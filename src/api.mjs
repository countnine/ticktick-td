import { readFile } from 'node:fs/promises';
import { TICKTICK_CONFIG_PATH } from './paths.mjs';

const BASE_URL = 'https://api.ticktick.com/open/v1';

/** 인증이 없거나 만료됨 → 종료 코드 2 */
export class AuthError extends Error {}
/** 그 외 API 오류 → 종료 코드 1 */
export class ApiError extends Error {}

export const LOGIN_HINT = [
  '먼저 TickTick 에 로그인하세요:',
  '',
  '  npx -y @ticktick/ticktick-cli auth login',
  '',
  '브라우저를 쓸 수 없다면 TickTick 웹 → 아바타 → Settings > Account > API Token 발급 후:',
  '',
  '  npx -y @ticktick/ticktick-cli auth token <token>',
].join('\n');

let cachedToken;

/**
 * 토큰 우선순위: TICKTICK_TOKEN 환경변수 → 공식 CLI 설정 파일.
 * 공식 CLI 가 설정 형식을 바꾸더라도 환경변수로 복구할 수 있다.
 */
export async function loadToken() {
  const fromEnv = process.env.TICKTICK_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  try {
    const raw = await readFile(TICKTICK_CONFIG_PATH, 'utf-8');
    const token = JSON.parse(raw)?.access_token;
    if (typeof token === 'string' && token.trim()) return token.trim();
  } catch {
    // 파일 없음 / 깨진 JSON → 아래에서 동일하게 처리
  }

  throw new AuthError(`저장된 액세스 토큰을 찾을 수 없습니다.\n\n${LOGIN_HINT}`);
}

const REQUEST_TIMEOUT_MS = 10_000;

async function request(path, { method = 'GET', body } = {}) {
  cachedToken ??= await loadToken();

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cachedToken}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ApiError(`TickTick 서버 응답이 없습니다 (${REQUEST_TIMEOUT_MS / 1000}초 초과).`);
    }
    throw new ApiError(`TickTick 서버에 연결하지 못했습니다: ${error.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(`토큰이 만료되었거나 권한이 없습니다 (HTTP ${response.status}).\n\n${LOGIN_HINT}`);
  }
  if (!response.ok) {
    throw new ApiError(`TickTick API 오류 ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  if (response.status === 204) return undefined;
  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) return undefined;
  return response.json();
}

/**
 * 남아 있는 keep-alive 소켓을 닫는다.
 * 이걸 안 하면 마지막 응답을 다 받고도 소켓이 만료될 때까지 약 1초간 프로세스가 종료되지 않는다.
 * (process.exit() 로 잘라내면 Windows 에서 libuv 어설션이 나므로 쓰지 않는다.)
 * undici 는 Node 내부 모듈이라 심볼로 접근한다. 버전이 바뀌어 못 찾으면 조용히 넘어간다 — 느려질 뿐 동작에는 지장이 없다.
 */
export async function closeConnections() {
  try {
    const symbol = Object.getOwnPropertySymbols(globalThis).find((s) =>
      s.description?.startsWith('undici.globalDispatcher'),
    );
    await globalThis[symbol]?.close?.();
  } catch {
    // 무시
  }
}

/** POST /task/filter 는 한 번에 최대 200건만 돌려준다. (실측값) */
export const FILTER_PAGE_SIZE = 200;

/**
 * POST /task/filter.
 * 실측된 동작:
 *  - projectIds 를 생략하면 **인박스만** 반환한다 (일반 프로젝트는 빠진다).
 *  - 최대 200건에서 잘리며 dueDate 내림차순으로 채워진다.
 *  - startDate/endDate 는 dueDate 기준 [start, end) 범위다.
 *  - 인박스의 기한 없는 태스크는 어떤 조합으로도 반환되지 않는다 (일반 프로젝트는 정상 반환).
 */
export async function filterTasks(body) {
  const tasks = await request('/task/filter', { method: 'POST', body });
  return Array.isArray(tasks) ? tasks : [];
}

/** GET /project/{projectId}/task/{taskId} — 단건 상세 */
export async function getTask(projectId, taskId) {
  return request(`/project/${projectId}/task/${taskId}`);
}

/** GET /project/{id}/data — 해당 프로젝트의 미완료 태스크 */
export async function getProjectData(projectId) {
  return request(`/project/${projectId}/data`);
}

export async function listProjects() {
  const projects = await request('/project');
  return Array.isArray(projects) ? projects : [];
}

export async function completeTask(projectId, taskId) {
  await request(`/project/${projectId}/task/${taskId}/complete`, { method: 'POST' });
}

export async function createTask(input) {
  return request('/task', { method: 'POST', body: input });
}
