import { chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LAST_LIST_PATH, TASK_CACHE_PATH, TD_CONFIG_PATH, TD_DIR, TICKTICK_CONFIG_PATH } from './paths.mjs';

/** 토큰은 끝 4자만 남긴다. 길이는 따로 알려 준다. */
export function maskToken(token) {
  const text = String(token ?? '');
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${'*'.repeat(text.length - 4)}${text.slice(-4)}`;
}

/** Windows 는 파일 모드가 없고 프로필 ACL 을 따른다. 모드 기반 점검은 POSIX 에서만 뜻이 있다. */
export const CAN_CHECK_MODE = process.platform !== 'win32';

/**
 * 파일·디렉터리 권한을 본다.
 * @returns {Promise<{path: string, octal: string, exposed: boolean}|undefined>} 없으면 undefined
 */
export async function inspectMode(path) {
  try {
    const info = await stat(path);
    const mode = info.mode & 0o777;
    return { path, octal: mode.toString(8).padStart(3, '0'), exposed: Boolean(mode & 0o077) };
  } catch {
    return undefined;
  }
}

/** 토큰과 캐시가 들어 있는 파일·디렉터리. 캐시에는 할일 제목이 들어 있어 함께 조인다. */
export function protectedPaths() {
  return {
    files: [TICKTICK_CONFIG_PATH, TD_CONFIG_PATH, LAST_LIST_PATH, TASK_CACHE_PATH],
    dirs: [dirname(TICKTICK_CONFIG_PATH), TD_DIR],
  };
}

/** 다른 로컬 사용자가 읽을 수 있는 파일·디렉터리 목록 (POSIX 전용) */
export async function findExposed() {
  if (!CAN_CHECK_MODE) return [];
  const { files, dirs } = protectedPaths();
  const checked = await Promise.all([...files, ...dirs].map(inspectMode));
  return checked.filter((entry) => entry?.exposed);
}

/**
 * 파일은 0600, 디렉터리는 0700 으로 조인다 (POSIX 전용).
 * @returns {Promise<string[]>} 실제로 바꾼 경로
 */
export async function fixPermissions() {
  if (!CAN_CHECK_MODE) return [];
  const { files, dirs } = protectedPaths();
  const fixed = [];

  for (const [paths, mode] of [
    [files, 0o600],
    [dirs, 0o700],
  ]) {
    for (const path of paths) {
      const before = await inspectMode(path);
      if (!before || !before.exposed) continue;
      try {
        await chmod(path, mode);
        fixed.push(path);
      } catch {
        // 권한이 없거나 다른 사용자 소유 → 조용히 넘어가고 status 가 계속 경고하게 둔다
      }
    }
  }
  return fixed;
}
