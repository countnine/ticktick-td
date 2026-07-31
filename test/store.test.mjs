import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.TD_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'td-store-'));

const {
  invalidateTaskCache,
  readConfig,
  readLastList,
  readTaskCache,
  saveLastList,
  saveTaskCache,
  updateConfig,
} = await import('../src/store.mjs');
const { LAST_LIST_PATH, TASK_CACHE_PATH, TD_DIR } = await import('../src/paths.mjs');

describe('paths', () => {
  it('TD_CONFIG_DIR 로 저장 위치를 옮길 수 있다', () => {
    assert.equal(TD_DIR, process.env.TD_CONFIG_DIR);
  });
});

describe('번호 캐시', () => {
  it('저장한 그대로 읽힌다', async () => {
    const entries = [{ number: 1, id: 't1', projectId: 'p1', title: '할일 하나' }];
    await saveLastList(entries, 'today');

    const loaded = await readLastList();
    assert.deepEqual(loaded.entries, entries);
    assert.equal(loaded.view, 'today');
    assert.ok(Date.parse(loaded.savedAt), 'savedAt 이 ISO 시각이어야 한다');
  });

  it('빈 목록도 저장된다 (이전 번호로 잘못 완료하는 걸 막는다)', async () => {
    await saveLastList([], 'today');
    assert.deepEqual((await readLastList()).entries, []);
  });

  it('POSIX 에서는 0600 으로 저장한다', { skip: process.platform === 'win32' }, async () => {
    await saveLastList([], 'today');
    const mode = (await stat(LAST_LIST_PATH)).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

describe('태스크 캐시', () => {
  it('저장 → 조회 → 무효화', async () => {
    await saveTaskCache([{ id: 't1' }], 'inbox1');

    const cached = await readTaskCache();
    assert.deepEqual(cached.tasks, [{ id: 't1' }]);
    assert.equal(cached.inboxId, 'inbox1');
    assert.ok(Date.parse(cached.savedAt));

    await invalidateTaskCache();
    assert.equal(await readTaskCache(), undefined);
  });

  it('없는 캐시를 무효화해도 오류가 없다', async () => {
    await invalidateTaskCache();
    await invalidateTaskCache();
    assert.equal(await readTaskCache(), undefined);
    assert.match(TASK_CACHE_PATH, /task-cache\.json$/);
  });
});

describe('설정', () => {
  it('부분 갱신이 기존 값을 지우지 않는다', async () => {
    await updateConfig({ inboxId: 'inbox1' });
    await updateConfig({ projects: { fetchedAt: '2026-01-01T00:00:00.000Z', byId: { p1: 'Work' } } });

    const config = await readConfig();
    assert.equal(config.inboxId, 'inbox1');
    assert.equal(config.projects.byId.p1, 'Work');
  });
});
