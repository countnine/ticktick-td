import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

process.env.TD_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'td-tasks-'));
process.env.TICKTICK_TOKEN = 'test-token';
process.env.TD_CACHE_TTL_SEC = '0'; // 캐시를 끄고 순수 수집 로직만 본다

const { collectOpenTasks, resolveCacheTtlMs } = await import('../src/tasks.mjs');
const { TD_DIR } = await import('../src/paths.mjs');

const realFetch = globalThis.fetch;

const PROJECTS = [
  { id: 'p1', name: 'Work' },
  { id: 'p2', name: '개인' },
];

/** dueDate 내림차순으로 채워진 인박스 태스크를 만든다 */
function inboxTask(index) {
  const day = new Date(Date.UTC(2026, 0, 1) - index * 86_400_000).toISOString().replace('T', 'T').slice(0, 10);
  return { id: `inbox-${index}`, projectId: 'inbox999', title: `인박스 ${index}`, dueDate: `${day}T15:00:00.000+0000` };
}

/**
 * 서버를 흉내낸다.
 *  - projectIds 없음 → 인박스만, 200건 상한, endDate 커서로 페이징
 *  - projectIds 있음 → 해당 프로젝트 태스크
 */
function stubServer({ inboxCount = 0, projectTasks = [], projectData = {} } = {}) {
  const calls = { filter: [], projectData: [], projects: 0 };
  const inbox = Array.from({ length: inboxCount }, (_, i) => inboxTask(i));

  globalThis.fetch = async (url, init) => {
    const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

    if (url.endsWith('/project')) {
      calls.projects += 1;
      return json(PROJECTS);
    }
    if (url.includes('/project/') && url.endsWith('/data')) {
      const id = url.split('/project/')[1].replace('/data', '');
      calls.projectData.push(id);
      return json({ project: { id }, tasks: projectData[id] ?? [], columns: [] });
    }
    if (url.endsWith('/task/filter')) {
      const body = JSON.parse(init.body);
      calls.filter.push(body);

      if (body.projectIds) return json(projectTasks);

      const pool = body.endDate ? inbox.filter((task) => task.dueDate < body.endDate) : inbox;
      return json(pool.slice(0, 200));
    }
    throw new Error(`예상하지 못한 요청: ${url}`);
  };

  return calls;
}

beforeEach(async () => {
  // 프로젝트 이름 캐시가 테스트 간에 새지 않도록 설정 디렉터리를 비운다
  await rm(TD_DIR, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('resolveCacheTtlMs', () => {
  it('없으면 300초 기본값', () => {
    assert.equal(resolveCacheTtlMs({}), 300_000);
    assert.equal(resolveCacheTtlMs({ TD_CACHE_TTL_SEC: '' }), 300_000);
  });

  it('0이면 캐시를 끈다 (이전에는 0이 300초로 둔갑했다)', () => {
    assert.equal(resolveCacheTtlMs({ TD_CACHE_TTL_SEC: '0' }), 0);
  });

  it('양의 정수는 초 단위로 바꾼다', () => {
    assert.equal(resolveCacheTtlMs({ TD_CACHE_TTL_SEC: '60' }), 60_000);
  });

  it('잘못된 값은 사람이 읽는 오류', () => {
    assert.throws(() => resolveCacheTtlMs({ TD_CACHE_TTL_SEC: 'abc' }), /TD_CACHE_TTL_SEC/);
    assert.throws(() => resolveCacheTtlMs({ TD_CACHE_TTL_SEC: '-1' }), /TD_CACHE_TTL_SEC/);
  });
});

describe('collectOpenTasks', () => {
  it('인박스 200건 상한을 커서 페이징으로 넘어간다', async () => {
    const calls = stubServer({ inboxCount: 286, projectTasks: [{ id: 'a', projectId: 'p1', title: '프로젝트 할일' }] });

    const { tasks } = await collectOpenTasks();

    assert.equal(tasks.length, 287, '인박스 286 + 프로젝트 1');
    const inboxCalls = calls.filter.filter((body) => !body.projectIds);
    assert.equal(inboxCalls.length, 2, '200건 + 86건 두 페이지');
    assert.ok(inboxCalls[1].endDate, '두 번째 페이지는 endDate 커서를 쓴다');
  });

  it('페이지가 겹쳐도 id 로 중복을 제거한다', async () => {
    const duplicated = [
      { id: 'dup', projectId: 'p1', title: '중복' },
      { id: 'dup', projectId: 'p1', title: '중복' },
    ];
    stubServer({ inboxCount: 0, projectTasks: duplicated });

    const { tasks } = await collectOpenTasks();
    assert.equal(tasks.length, 1);
  });

  it('인박스가 정확히 200건이면 빈 다음 페이지까지 확인하고 멈춘다', async () => {
    const calls = stubServer({ inboxCount: 200 });

    const { tasks } = await collectOpenTasks();

    assert.equal(tasks.length, 200);
    assert.equal(calls.filter.filter((body) => !body.projectIds).length, 2);
  });

  it('인박스 id 를 감지해 돌려준다', async () => {
    stubServer({ inboxCount: 3 });
    const { inboxId } = await collectOpenTasks();
    assert.equal(inboxId, 'inbox999');
  });

  it('프로젝트 질의가 상한에 닿으면 프로젝트별 조회로 보완한다', async () => {
    const capped = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, projectId: 'p1', title: `할일 ${i}` }));
    const calls = stubServer({
      inboxCount: 0,
      projectTasks: capped,
      projectData: { p1: [{ id: 'only-in-data', projectId: 'p1', title: '폴백으로만 보이는 항목' }], p2: [] },
    });

    const { tasks } = await collectOpenTasks();

    assert.deepEqual(calls.projectData.sort(), ['p1', 'p2']);
    assert.ok(
      tasks.some((task) => task.id === 'only-in-data'),
      '폴백 결과가 합쳐져야 한다',
    );
    assert.equal(tasks.length, 201);
  });

  it('할일이 하나도 없으면 빈 배열', async () => {
    stubServer({ inboxCount: 0, projectTasks: [] });
    const { tasks } = await collectOpenTasks();
    assert.deepEqual(tasks, []);
  });
});
