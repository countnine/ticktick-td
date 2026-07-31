import { homedir } from 'node:os';
import { join } from 'node:path';

// Windows / macOS 모두 같은 규칙을 쓴다. 공식 ticktick CLI 도 homedir()/.config 아래에 저장한다.
const CONFIG_ROOT = join(homedir(), '.config');

/** 이 래퍼가 쓰는 디렉터리. TD_CONFIG_DIR 로 옮길 수 있다 (테스트 격리에도 쓴다). */
export const TD_DIR = process.env.TD_CONFIG_DIR || join(CONFIG_ROOT, 'td');

/** 번호 → 태스크 매핑 캐시 (`td done <번호>` 가 참조) */
export const LAST_LIST_PATH = join(TD_DIR, 'last-list.json');

/** 미완료 태스크 전체의 단기 캐시 */
export const TASK_CACHE_PATH = join(TD_DIR, 'task-cache.json');

/** 래퍼 설정 (기본 프로젝트 등) */
export const TD_CONFIG_PATH = join(TD_DIR, 'config.json');

/** 공식 @ticktick/ticktick-cli 가 액세스 토큰을 저장하는 위치 */
export const TICKTICK_CONFIG_PATH = join(CONFIG_ROOT, 'ticktick-cli', 'config.json');
