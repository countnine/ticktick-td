import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { LAST_LIST_PATH, TASK_CACHE_PATH, TD_CONFIG_PATH, TD_DIR } from './paths.mjs';

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

async function writeJson(path, value) {
  await mkdir(TD_DIR, { recursive: true });
  // 태스크 제목이 담기므로 홈 디렉터리 아래(프로젝트 밖)에만 쓴다.
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function readConfig() {
  return (await readJson(TD_CONFIG_PATH)) ?? {};
}

export async function updateConfig(partial) {
  const config = await readConfig();
  const next = { ...config, ...partial };
  await writeJson(TD_CONFIG_PATH, next);
  return next;
}

/**
 * 화면에 출력한 번호 → 태스크 매핑을 저장한다. `td done <번호>` 가 이걸 참조한다.
 * @param {{number: number, id: string, projectId: string, title: string}[]} entries
 */
export async function saveLastList(entries, view) {
  await writeJson(LAST_LIST_PATH, {
    view,
    savedAt: new Date().toISOString(),
    entries,
  });
}

export async function readLastList() {
  return await readJson(LAST_LIST_PATH);
}

/**
 * 미완료 태스크 전체를 짧게 캐시한다.
 * 프로세스마다 TLS 핸드셰이크에만 1초 넘게 드는 탓에, 캐시가 없으면 연속 명령이 매번 느리다.
 */
export async function saveTaskCache(tasks, inboxId) {
  await writeJson(TASK_CACHE_PATH, { savedAt: new Date().toISOString(), inboxId, tasks });
}

export async function readTaskCache() {
  return await readJson(TASK_CACHE_PATH);
}

/** 할일을 추가/완료해 목록이 바뀌었을 때 호출한다. */
export async function invalidateTaskCache() {
  await rm(TASK_CACHE_PATH, { force: true });
}
