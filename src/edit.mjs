import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDue, toApiDate } from './due.mjs';
import { LOCAL_TZ, formatDateTime, parseDue } from './view.mjs';

export const PRIORITY_BY_NAME = { high: 5, med: 3, medium: 3, low: 1, none: 0 };
const PRIORITY_TO_NAME = { 5: 'high', 3: 'med', 1: 'low', 0: 'none' };

/** `--p` 값 → API priority 숫자 */
export function parsePriority(value) {
  const named = PRIORITY_BY_NAME[String(value).trim().toLowerCase()];
  const priority = named ?? Number.parseInt(value, 10);
  if (![0, 1, 3, 5].includes(priority)) {
    throw new Error(`우선순위는 high | med | low | none (또는 5 | 3 | 1 | 0) 이어야 합니다: ${value}`);
  }
  return priority;
}

/**
 * 태스크 → 편집용 초안. 옵션 편집과 에디터 편집이 같은 표현을 쓰도록 한가운데에 둔다.
 * `due` 는 `resolveDue()` 가 그대로 다시 읽을 수 있는 형태로 적는다.
 */
export function taskToDraft(task) {
  const due = parseDue(task);
  return {
    title: task?.title ?? '',
    due: !due ? 'none' : due.allDay ? due.key : formatDateTime(task.dueDate, due.timeZone),
    priority: PRIORITY_TO_NAME[task?.priority ?? 0] ?? String(task?.priority),
    content: task?.content ?? '',
  };
}

/** 마감 관련 필드. 실측상 `dueDate: null` 을 보내면 기한이 지워진다. */
function dueFields(current, value) {
  if (String(value).trim().toLowerCase() === 'none') return { dueDate: null };

  const due = resolveDue(value);
  const dueDate = toApiDate(due.key, due.time);
  const fields = { dueDate, isAllDay: due.allDay, timeZone: LOCAL_TZ };

  // 시작일이 마감일과 같던 하루짜리 항목만 같이 옮긴다.
  // 진짜 기간이 있는 항목의 시작일은 건드리지 않는다.
  if (current?.startDate && current.startDate === current.dueDate) fields.startDate = dueDate;
  return fields;
}

/**
 * 서버 태스크와 편집한 초안을 비교해 **바뀐 필드만** 담은 본문을 만든다.
 * 실측 결과 `POST /task/{id}` 는 부분 갱신이라 보내지 않은 필드(tags·items 등)는 그대로 보존된다.
 */
export function draftToUpdate(current, draft) {
  const before = taskToDraft(current);
  const body = {};

  if (draft.title !== before.title) body.title = draft.title;
  if (draft.content !== before.content) body.content = draft.content;
  if (parsePriority(draft.priority) !== parsePriority(before.priority)) body.priority = parsePriority(draft.priority);
  if (draft.due !== before.due) Object.assign(body, dueFields(current, draft.due));

  return body;
}

const PRIORITY_LABELS = { high: '높음', med: '중간', low: '낮음', none: '없음' };
const describePriority = (value) => PRIORITY_LABELS[String(value).toLowerCase()] ?? String(value);

/** 화면에 보여 줄 변경 요약 */
export function describeChanges(current, draft) {
  const before = taskToDraft(current);
  const changes = [];

  if (draft.title !== before.title) changes.push({ label: '제목', from: before.title, to: draft.title });
  if (draft.due !== before.due) {
    changes.push({ label: '마감', from: before.due === 'none' ? '없음' : before.due, to: draft.due === 'none' ? '없음' : draft.due });
  }
  if (draft.priority !== before.priority) {
    changes.push({ label: '우선순위', from: describePriority(before.priority), to: describePriority(draft.priority) });
  }
  if (draft.content !== before.content) {
    const lines = (text) => (text ? text.split(/\r?\n/).length : 0);
    changes.push({ label: '내용', from: `${lines(before.content)}줄`, to: `${lines(draft.content)}줄` });
  }
  return changes;
}

const SEPARATOR = '---';
const HEADER_KEYS = new Set(['title', 'due', 'priority']);

/** 에디터에 띄울 버퍼. 헤더 + `---` + 본문. */
export function serializeDraft(draft, { projectName } = {}) {
  return [
    '# 저장하고 닫으면 반영됩니다. # 로 시작하는 줄은 무시됩니다.',
    '#   due       today | tomorrow | YYYY-MM-DD | "YYYY-MM-DD HH:mm" | none',
    '#   priority  high | med | low | none',
    `#   프로젝트${projectName ? `(${projectName})` : ''} 이동은 Open API 가 지원하지 않습니다. 앱에서 옮기세요.`,
    `title: ${draft.title}`,
    `due: ${draft.due}`,
    `priority: ${draft.priority}`,
    SEPARATOR,
    draft.content,
  ].join('\n');
}

/**
 * 버퍼 → 초안. 형식이 틀리면 사람이 읽는 오류를 던진다.
 * 본문은 첫 `---` 이후 전부이므로 본문 안에 `---` 가 있어도 안전하다.
 */
export function parseDraft(text) {
  const lines = String(text).split(/\r?\n/);
  const separator = lines.findIndex((line) => line.trim() === SEPARATOR);
  if (separator === -1) {
    throw new Error(`구분선 "${SEPARATOR}" 이 없습니다. 헤더와 본문 사이에 한 줄로 넣어 주세요.`);
  }

  const draft = { title: undefined, due: undefined, priority: undefined, content: '' };
  for (const line of lines.slice(0, separator)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const match = /^([A-Za-z]+):(.*)$/.exec(line);
    if (!match) throw new Error(`헤더 형식이 아닙니다 (key: value): ${line}`);

    const [, key, rawValue] = match;
    if (!HEADER_KEYS.has(key)) {
      throw new Error(`알 수 없는 항목입니다: ${key}  (쓸 수 있는 것: ${[...HEADER_KEYS].join(', ')})`);
    }
    draft[key] = rawValue.trim();
  }

  for (const key of HEADER_KEYS) {
    if (draft[key] === undefined) throw new Error(`${key} 줄이 없습니다.`);
  }
  if (!draft.title) throw new Error('제목이 비어 있습니다.');

  draft.content = lines.slice(separator + 1).join('\n').replace(/\s+$/, '');

  return normalizeDraft(draft);
}

/**
 * 값을 검증하면서 `taskToDraft` 와 같은 표준형으로 맞춘다.
 * 이걸 거치지 않으면 `--due today` 나 `--p 5` 처럼 **같은 값을 다르게 쓴 입력**이
 * 늘 "바뀜" 으로 잡힌다. 잘못된 값은 여기서 던져, 에디터 경로에서 임시 파일이 살아남게 한다.
 */
export function normalizeDraft(draft) {
  const priority = parsePriority(draft.priority);
  const due = String(draft.due).trim().toLowerCase() === 'none' ? 'none' : resolveDue(draft.due).label;
  return { ...draft, priority: PRIORITY_TO_NAME[priority], due };
}

/** TD_EDITOR → VISUAL → EDITOR → 플랫폼 기본. `code -w` 처럼 인자가 붙어 있어도 된다. */
export function resolveEditor(env = process.env, platform = process.platform) {
  const configured = (env.TD_EDITOR || env.VISUAL || env.EDITOR || '').trim();
  const raw = configured || (platform === 'win32' ? 'notepad' : 'vi');
  const [command, ...args] = raw.split(/\s+/);
  return { command, args, raw };
}

/**
 * 임시 파일을 에디터로 열고 저장된 내용을 돌려준다.
 * 파싱이 실패할 수 있으므로 지우는 건 호출부가 정한다 (사용자가 쓴 내용을 날리지 않기 위해).
 *
 * @returns {Promise<{text: string, file: string, cleanup: () => Promise<void>}>}
 */
export async function editInEditor(initial) {
  const dir = await mkdtemp(join(tmpdir(), 'td-edit-'));
  const file = join(dir, 'task.md');
  await writeFile(file, initial, { mode: 0o600 });

  const { command, args, raw } = resolveEditor();
  // Windows 에서 code.cmd 같은 배치 파일은 셸 없이는 실행할 수 없다 (Node 의 .cmd spawn 제한).
  // 셸을 쓸 때 인자를 배열로 넘기면 Node 가 DEP0190 경고를 띄우므로 한 줄로 합쳐 넘긴다.
  const useShell = process.platform === 'win32';

  await new Promise((resolve, reject) => {
    const child = useShell
      ? spawn(`${raw} "${file}"`, { stdio: 'inherit', shell: true })
      : spawn(command, [...args, file], { stdio: 'inherit' });
    child.on('error', (error) =>
      reject(
        new Error(
          `에디터를 실행하지 못했습니다 (${command}): ${error.message}\n` +
            '  TD_EDITOR 환경변수로 지정할 수 있습니다. 예: TD_EDITOR="code -w"',
        ),
      ),
    );
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`에디터가 코드 ${code} 로 끝났습니다. 아무것도 반영하지 않았습니다.`)),
    );
  });

  return {
    text: await readFile(file, 'utf-8'),
    file,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
