import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

process.env.TD_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'td-api-'));
process.env.TICKTICK_TOKEN = 'env-token';

const { ApiError, AuthError, completeTask, filterTasks, loadToken } = await import('../src/api.mjs');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** fetch 를 대체하고, 마지막으로 넘어온 인자를 돌려준다 */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('loadToken', () => {
  it('TICKTICK_TOKEN 환경변수를 우선한다', async () => {
    assert.equal(await loadToken(), 'env-token');
  });

  it('환경변수가 없으면 공식 CLI 설정 파일에서 읽는다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'td-home-'));
    await mkdir(join(home, '.config', 'ticktick-cli'), { recursive: true });
    await writeFile(join(home, '.config', 'ticktick-cli', 'config.json'), JSON.stringify({ access_token: 'file-token' }));

    // paths 는 import 시점에 homedir() 를 읽으므로, 별도 프로세스에서 확인한다
    const { execFileSync } = await import('node:child_process');
    const script = `
      import { loadToken } from ${JSON.stringify(new URL('../src/api.mjs', import.meta.url).href)};
      console.log(await loadToken());
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TICKTICK_TOKEN: '', HOME: home, USERPROFILE: home },
      encoding: 'utf-8',
    });
    assert.equal(out.trim(), 'file-token');
  });
});

describe('request 오류 처리', () => {
  it('401 은 AuthError', async () => {
    stubFetch(() => new Response('nope', { status: 401 }));
    await assert.rejects(() => filterTasks({ status: [0] }), AuthError);
  });

  it('403 도 AuthError', async () => {
    stubFetch(() => new Response('nope', { status: 403 }));
    await assert.rejects(() => filterTasks({ status: [0] }), AuthError);
  });

  it('5xx 는 ApiError', async () => {
    stubFetch(() => new Response('boom', { status: 500 }));
    await assert.rejects(() => filterTasks({ status: [0] }), ApiError);
  });

  it('타임아웃은 사람이 읽는 ApiError 로 바꾼다', async () => {
    stubFetch(() => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    });
    await assert.rejects(
      () => filterTasks({ status: [0] }),
      (error) => error instanceof ApiError && /응답이 없습니다/.test(error.message),
    );
  });

  it('네트워크 오류도 ApiError', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(
      () => filterTasks({ status: [0] }),
      (error) => error instanceof ApiError && /연결하지 못했습니다/.test(error.message),
    );
  });
});

describe('요청 형태', () => {
  it('Bearer 토큰과 JSON 본문, 타임아웃 시그널을 보낸다', async () => {
    const calls = stubFetch(() => jsonResponse([]));
    await filterTasks({ status: [0] });

    const [{ url, init }] = calls;
    assert.equal(url, 'https://api.ticktick.com/open/v1/task/filter');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer env-token');
    assert.equal(init.body, JSON.stringify({ status: [0] }));
    assert.ok(init.signal, '타임아웃 시그널이 없다');
  });

  it('완료는 complete 엔드포인트를 POST 한다', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await completeTask('p1', 't1');
    assert.equal(calls[0].url, 'https://api.ticktick.com/open/v1/project/p1/task/t1/complete');
    assert.equal(calls[0].init.method, 'POST');
  });

  it('JSON 이 아닌 응답은 undefined 로 돌려준다', async () => {
    stubFetch(() => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
    assert.equal(await completeTask('p1', 't1'), undefined);
  });
});
