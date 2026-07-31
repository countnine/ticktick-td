import { listProjects } from './api.mjs';
import { readConfig, updateConfig } from './store.mjs';

const TTL_MS = 12 * 60 * 60 * 1000;

/** Open API 의 GET /project 는 인박스를 돌려주지 않는다. 인박스 id 는 이 형태로 온다. */
export function isInboxId(projectId) {
  return typeof projectId === 'string' && projectId.toLowerCase().startsWith('inbox');
}

/**
 * projectId → 프로젝트 이름 맵.
 * 매 명령마다 GET /project 를 부르지 않도록 캐시하고,
 * 캐시가 오래됐거나 처음 보는 프로젝트가 목록에 있으면 그때만 새로 받는다.
 */
export async function getProjectNames(tasks = []) {
  const config = await readConfig();
  const cached = config.projects;
  const fresh = cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS;

  if (fresh) {
    const map = new Map(Object.entries(cached.byId ?? {}));
    const hasUnknown = tasks.some((task) => task.projectId && !isInboxId(task.projectId) && !map.has(task.projectId));
    if (!hasUnknown) return map;
  }

  return refreshProjectNames();
}

/** 인박스를 제외한 일반 프로젝트 id 목록 (캐시 우선) */
export async function getProjectIds() {
  const names = await getProjectNames();
  return [...names.keys()];
}

export async function refreshProjectNames() {
  const projects = await listProjects();
  const byId = Object.fromEntries(projects.map((project) => [project.id, project.name]));
  await updateConfig({ projects: { fetchedAt: new Date().toISOString(), byId } });
  return new Map(Object.entries(byId));
}

/** 이름(또는 고유한 접두사)으로 프로젝트를 찾는다. */
export async function resolveProject(name) {
  const projects = await listProjects();
  const needle = name.trim().toLowerCase();

  const exact = projects.filter((project) => project.name?.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];

  const prefix = projects.filter((project) => project.name?.toLowerCase().startsWith(needle));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw new Error(`프로젝트 "${name}" 가 여러 개와 일치합니다: ${prefix.map((p) => p.name).join(', ')}`);
  }

  throw new Error(
    `프로젝트 "${name}" 를 찾을 수 없습니다. 사용 가능한 프로젝트: ${projects.map((p) => p.name).join(', ') || '(없음)'}`,
  );
}
