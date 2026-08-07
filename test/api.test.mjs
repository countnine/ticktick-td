import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

process.env.TD_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'td-api-'));
process.env.TICKTICK_TOKEN = 'env-token';

const { ApiError, AuthError, completeTask, deleteTask, filterTasks, loadToken, updateTask } = await import(
  '../src/api.mjs'
);

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

describe('TD_TOKEN_CMD', () => {
  /** TICKTICK_TOKEN 을 잠시 치우고 돌린다 (파일 맨 위에서 켜 두었다) */
  async function withoutEnvToken(run) {
    const saved = process.env.TICKTICK_TOKEN;
    delete process.env.TICKTICK_TOKEN;
    try {
      return await run();
    } finally {
      process.env.TICKTICK_TOKEN = saved;
      delete process.env.TD_TOKEN_CMD;
    }
  }

  it('TICKTICK_TOKEN 이 TD_TOKEN_CMD 보다 우선한다', async () => {
    process.env.TD_TOKEN_CMD = 'echo cmd-token';
    try {
      assert.equal(await loadToken(), 'env-token');
    } finally {
      delete process.env.TD_TOKEN_CMD;
    }
  });

  it('명령의 마지막 비어 있지 않은 줄을 토큰으로 쓴다', async () => {
    // 1Password·pass 같은 도구는 안내문을 함께 뱉는다
    await withoutEnvToken(async () => {
      process.env.TD_TOKEN_CMD = 'echo notice && echo cmd-token';
      assert.equal(await loadToken(), 'cmd-token');
    });
  });

  it('명령이 실패해도 표준출력이나 명령 원문을 인용하지 않는다', async () => {
    // 명령 안에 토큰을 직접 써 넣은 사용자가 있을 수 있다.
    // exec 의 error.message 는 "Command failed: <명령 전체>" 라서 그대로 쓰면 새어 나간다.
    await withoutEnvToken(async () => {
      process.env.TD_TOKEN_CMD = 'echo super-secret-token && exit 3';
      await assert.rejects(
        () => loadToken(),
        (error) => {
          assert.ok(error instanceof AuthError);
          assert.doesNotMatch(error.message, /super-secret-token/, '토큰이 오류 메시지에 새어 나왔다');
          assert.match(error.message, /종료 코드 3/);
          return true;
        },
      );
    });
  });

  it('실패하면 stderr 는 보여 준다 (원인을 알아야 고친다)', async () => {
    await withoutEnvToken(async () => {
      process.env.TD_TOKEN_CMD = 'echo vault-is-locked 1>&2 && exit 1';
      await assert.rejects(
        () => loadToken(),
        (error) => assert.match(error.message, /vault-is-locked/) ?? true,
      );
    });
  });

  it('아무것도 출력하지 않으면 AuthError', async () => {
    await withoutEnvToken(async () => {
      process.env.TD_TOKEN_CMD = 'exit 0';
      await assert.rejects(() => loadToken(), AuthError);
    });
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

  it('삭제는 프로젝트 경로로 DELETE 한다', async () => {
    const calls = stubFetch(() => new Response(null, { status: 200 }));
    await deleteTask('p1', 't1');
    assert.equal(calls[0].url, 'https://api.ticktick.com/open/v1/project/p1/task/t1');
    assert.equal(calls[0].init.method, 'DELETE');
  });

  it('편집은 /task/{id} 로 POST 하며 본문을 그대로 보낸다', async () => {
    const calls = stubFetch(() => jsonResponse({ id: 't1' }));
    await updateTask('t1', { id: 't1', projectId: 'p1', title: '새 제목' });

    assert.equal(calls[0].url, 'https://api.ticktick.com/open/v1/task/t1');
    assert.equal(calls[0].init.method, 'POST');
    // id·projectId 가 빠지면 서버가 거부한다
    assert.deepEqual(JSON.parse(calls[0].init.body), { id: 't1', projectId: 'p1', title: '새 제목' });
  });

  it('dueDate: null 이 본문에서 사라지지 않는다 (기한 지우기)', async () => {
    const calls = stubFetch(() => jsonResponse({ id: 't1' }));
    await updateTask('t1', { id: 't1', projectId: 'p1', dueDate: null });
    assert.equal(JSON.parse(calls[0].init.body).dueDate, null);
  });
});
