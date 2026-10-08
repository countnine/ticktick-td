import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { CAN_CHECK_MODE } from './auth.mjs';
import { LAST_LIST_PATH, TASK_CACHE_PATH, TD_CONFIG_PATH, TD_DIR } from './paths.mjs';

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

async function writeJson(path, value) {
  await mkdir(TD_DIR, { recursive: true, mode: 0o700 });
  // 태스크 제목이 담기므로 홈 디렉터리 아래(프로젝트 밖)에만 쓴다.
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // writeFile 의 mode 옵션은 새로 만드는 파일에만 적용된다.
  // 예전에 느슨하게 만들어진 파일·디렉터리도 여기서 조인다 (POSIX 전용).
  if (CAN_CHECK_MODE) {
    await chmod(TD_DIR, 0o700).catch(() => {});
    await chmod(path, 0o600).catch(() => {});
  }
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
 * 번호 캐시의 한 항목을 갱신한다.
 * `td edit` 으로 제목을 바꾼 뒤에도 같은 번호를 계속 쓸 수 있어야 하기 때문이다.
 * (갱신하지 않으면 제목 대조 안전장치가 사용자 자신의 변경을 막는다.)
 */
export async function patchLastListEntry(id, patch) {
  const cache = await readLastList();
  const entry = cache?.entries?.find((item) => item.id === id);
  if (!entry) return;
  Object.assign(entry, patch);
  await writeJson(LAST_LIST_PATH, cache);
}

/**
 * 지운 항목을 번호 캐시에서 뺀다. 남은 항목의 번호는 그대로 둬서 화면과 계속 맞춘다.
 * 삭제된 태스크도 단건 조회는 성공하므로(실측), 이 캐시가 유일하게 "이미 지웠다"를 아는 근거다.
 */
export async function dropLastListEntries(ids) {
  const cache = await readLastList();
  if (!cache?.entries?.length) return;
  const drop = new Set(ids);
  cache.entries = cache.entries.filter((item) => !drop.has(item.id));
  await writeJson(LAST_LIST_PATH, cache);
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
