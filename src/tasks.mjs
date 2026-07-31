import { FILTER_PAGE_SIZE, filterTasks, getProjectData } from './api.mjs';
import { getProjectIds } from './projects.mjs';
import { readConfig, readTaskCache, saveTaskCache, updateConfig } from './store.mjs';

const MAX_INBOX_PAGES = 20;

/** 캐시 유효 시간. TD_CACHE_TTL_SEC 로 조절한다 (0 이면 캐시 사용 안 함). */
const CACHE_TTL_MS = (Number.parseInt(process.env.TD_CACHE_TTL_SEC ?? '', 10) || 300) * 1000;

/**
 * 인박스는 projectIds 를 생략한 filter 로만 온전히 받을 수 있고 200건에서 잘리므로,
 * dueDate 를 커서로 삼아 오래된 쪽으로 페이징한다.
 */
async function collectInboxTasks() {
  const collected = new Map();
  let endDate;

  for (let page = 0; page < MAX_INBOX_PAGES; page += 1) {
    const body = { status: [0] };
    if (endDate) body.endDate = endDate;

    const tasks = await filterTasks(body);
    let earliest;
    for (const task of tasks) {
      collected.set(task.id, task);
      if (task.dueDate && (!earliest || task.dueDate < earliest)) earliest = task.dueDate;
    }

    // 마지막 페이지이거나 커서가 더 이상 전진하지 못하면 종료
    if (tasks.length < FILTER_PAGE_SIZE || !earliest || earliest === endDate) break;
    endDate = earliest;
  }

  return [...collected.values()];
}

/** 일반 프로젝트는 한 번의 projectIds 질의로 받는다. 200건 상한에 닿으면 프로젝트별 조회로 되돌아간다. */
async function collectProjectTasks(projectIds) {
  if (projectIds.length === 0) return [];

  const tasks = await filterTasks({ status: [0], projectIds });
  if (tasks.length < FILTER_PAGE_SIZE) return tasks;

  const perProject = await Promise.all(projectIds.map((id) => getProjectData(id).catch(() => undefined)));
  const merged = new Map();
  for (const data of perProject) {
    for (const task of data?.tasks ?? []) merged.set(task.id, task);
  }
  for (const task of tasks) merged.set(task.id, task);
  return [...merged.values()];
}

/**
 * 미완료 태스크 전체 (인박스 + 일반 프로젝트).
 * 인박스의 기한 없는 태스크는 API 가 돌려주지 않아 여기에 포함되지 않는다.
 *
 * @param {{force?: boolean}} options force 면 캐시를 무시하고 새로 받는다.
 * @returns {Promise<{tasks: object[], inboxId?: string, savedAt?: string, fromCache: boolean}>}
 */
export async function collectOpenTasks({ force = false } = {}) {
  if (!force && CACHE_TTL_MS > 0) {
    const cached = await readTaskCache();
    const age = cached?.savedAt ? Date.now() - Date.parse(cached.savedAt) : Number.POSITIVE_INFINITY;
    if (Array.isArray(cached?.tasks) && age < CACHE_TTL_MS) {
      return { tasks: cached.tasks, inboxId: cached.inboxId, savedAt: cached.savedAt, fromCache: true };
    }
  }

  const projectIds = await getProjectIds();

  // allSettled 로 둘 다 끝난 뒤에 실패를 던진다.
  // Promise.all 로 먼저 던지면 남은 요청이 진행 중인 채로 프로세스가 종료돼 Windows 에서 libuv 어설션이 난다.
  const [projectResult, inboxResult] = await Promise.allSettled([
    collectProjectTasks(projectIds),
    collectInboxTasks(),
  ]);
  if (projectResult.status === 'rejected') throw projectResult.reason;
  if (inboxResult.status === 'rejected') throw inboxResult.reason;
  const projectTasks = projectResult.value;
  const inboxTasks = inboxResult.value;

  const byId = new Map();
  for (const task of [...projectTasks, ...inboxTasks]) byId.set(task.id, task);

  const knownProjects = new Set(projectIds);
  const inboxId = inboxTasks.find((task) => !knownProjects.has(task.projectId))?.projectId;
  if (inboxId) {
    const config = await readConfig();
    if (config.inboxId !== inboxId) await updateConfig({ inboxId });
  }

  const tasks = [...byId.values()];
  const resolvedInboxId = inboxId ?? (await readConfig()).inboxId;
  if (CACHE_TTL_MS > 0) await saveTaskCache(tasks, resolvedInboxId);

  return { tasks, inboxId: resolvedInboxId, savedAt: new Date().toISOString(), fromCache: false };
}
