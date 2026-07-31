import { firstUrl, hyperlink, stripMarkdownLinks } from './links.mjs';

export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const ESC = String.fromCharCode(27);
const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor() ? `${ESC}[${code}m${text}${ESC}[0m` : String(text));

export const color = {
  dim: paint('2'),
  bold: paint('1'),
  red: paint('31'),
  yellow: paint('33'),
  blue: paint('34'),
  green: paint('32'),
  cyan: paint('36'),
};

/** 로컬 타임존 기준 YYYY-MM-DD */
export function dateKey(date, timeZone = LOCAL_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function todayKey() {
  return dateKey(new Date());
}

function formatTime(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * 마감 정보를 꺼낸다.
 * 종일 태스크는 저장 규칙(UTC 자정 / 로컬 자정→UTC)이 서버마다 다를 수 있는데,
 * 태스크 자신의 timeZone 으로 변환하면 두 규칙 모두에서 같은 달력 날짜가 나온다.
 */
export function parseDue(task) {
  if (!task?.dueDate) return null;
  const date = new Date(task.dueDate);
  if (Number.isNaN(date.getTime())) return null;
  const timeZone = task.timeZone || LOCAL_TZ;
  return {
    date,
    timeZone,
    allDay: Boolean(task.isAllDay),
    key: dateKey(date, timeZone),
  };
}

/** 등록 시각. Open API 가 createdTime 을 주지 않으면 태스크 id(ObjectId) 앞 8자리에서 복원한다. */
export function createdAt(task) {
  const raw = task?.createdTime;
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const hex = typeof task?.id === 'string' ? task.id.slice(0, 8) : '';
  if (/^[0-9a-f]{8}$/i.test(hex)) {
    const seconds = Number.parseInt(hex, 16);
    // 2000-01-01 ~ 2100-01-01 범위일 때만 신뢰한다.
    if (seconds > 946_684_800 && seconds < 4_102_444_800) return new Date(seconds * 1000);
  }
  return null;
}

// 색은 호출 시점에 입힌다 (import 시점에 고정하면 테스트에서 토글할 수 없다)
const PRIORITY_MARKS = { 5: [color.red, '!!!'], 3: [color.yellow, ' !!'], 1: [color.blue, '  !'] };

function priorityMark(task) {
  const mark = PRIORITY_MARKS[task?.priority];
  return mark ? mark[0](mark[1]) : '   ';
}

/** 한글·CJK 는 터미널에서 두 칸을 차지한다. 정렬을 맞추기 위한 폭 계산. */
export function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 한글 라벨을 섞어도 열이 맞도록 표시 폭 기준으로 채운다 */
export function padEndWidth(text, target) {
  const width = displayWidth(text);
  return width >= target ? text : text + ' '.repeat(target - width);
}

function truncateWidth(text, max) {
  if (displayWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (width + charWidth > max - 1) break;
    out += char;
    width += charWidth;
  }
  return `${out}…`;
}

function daysBetween(fromKey, toKey) {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function describeDue(due, today) {
  if (!due) return { text: '기한 없음', overdue: false };

  const diff = daysBetween(today, due.key);
  const time = due.allDay ? '' : ` ${formatTime(due.date, due.timeZone)}`;

  if (diff === 0) return { text: `오늘${time}`, overdue: false };
  if (diff === 1) return { text: `내일${time}`, overdue: false };
  if (diff < 0) return { text: `${-diff}일 지남 (${due.key})`, overdue: true };
  return { text: `${due.key}${time}`, overdue: false };
}

// "  1.  !!!  " 접두부 11칸 + 제목 뒤 여백 2칸 + 메타(프로젝트 · 마감) 대략 28칸
const ROW_OVERHEAD = 41;

/** 터미널 폭에 맞춰 제목 열 너비를 정한다. 폭을 알 수 없으면 44 를 쓴다. */
function titleWidth() {
  const columns = process.stdout.columns;
  if (!columns) return 44;
  return Math.min(60, Math.max(20, columns - ROW_OVERHEAD));
}

/**
 * 한 줄 렌더링.
 * @param {number} index 1부터 시작하는 표시 번호
 */
export function formatRow(index, task, projectNames, today = todayKey()) {
  const due = parseDue(task);
  const { text: dueText, overdue } = describeDue(due, today);
  const projectName = projectNames.get(task.projectId) ?? '인박스';

  // 마크다운 링크는 라벨만 보여 주고, 제목 전체를 클릭 가능한 링크로 감싼다.
  // 이스케이프 시퀀스가 폭 계산을 망치지 않도록 자르기·패딩을 먼저 하고 나서 감싼다.
  const width = titleWidth();
  const visible = truncateWidth(stripMarkdownLinks(task.title ?? '(제목 없음)'), width);
  const url = firstUrl(task.title);
  const title = hyperlink(url, visible) + ' '.repeat(Math.max(0, width - displayWidth(visible)));
  const meta = `${projectName} · ${dueText}`;

  return `${String(index).padStart(3)}.  ${priorityMark(task)}  ${title}  ${
    overdue ? color.red(meta) : color.dim(meta)
  }`;
}

/** 오늘 마감 항목: 시간 지정된 것 먼저(시간순) → 종일 → 우선순위 높은 순 */
export function sortForToday(tasks) {
  return [...tasks].sort((a, b) => {
    const dueA = parseDue(a);
    const dueB = parseDue(b);
    const allDayA = dueA?.allDay ? 1 : 0;
    const allDayB = dueB?.allDay ? 1 : 0;
    if (allDayA !== allDayB) return allDayA - allDayB;
    if (!allDayA && dueA && dueB) {
      const diff = dueA.date - dueB.date;
      if (diff !== 0) return diff;
    }
    const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return (createdAt(a)?.getTime() ?? 0) - (createdAt(b)?.getTime() ?? 0);
  });
}

/** 보조 뷰: 우선순위 내림차순 → 등록일 오래된 순 */
export function sortForBacklog(tasks) {
  return [...tasks].sort((a, b) => {
    const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    const createdA = createdAt(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const createdB = createdAt(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return createdA - createdB;
  });
}

const PRIORITY_LABELS = { 5: '높음', 3: '중간', 1: '낮음', 0: '없음' };

export function priorityLabel(task) {
  return PRIORITY_LABELS[task?.priority ?? 0] ?? String(task?.priority);
}

/** 상세 화면용 날짜 표기 */
export function formatDateTime(value, timeZone = LOCAL_TZ, { dateOnly = false } = {}) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;

  // sv-SE 는 "2026-07-31 14:00" 형태로 나온다.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }),
  }).format(date);
}

/** 마감 정보를 상세 화면용 한 줄로 (예: "오늘 (2026-07-31, 종일)") */
export function describeDueLong(task, today = todayKey()) {
  const due = parseDue(task);
  if (!due) return '없음';
  const { text } = describeDue(due, today);
  const suffix = due.allDay ? '종일' : due.timeZone;
  return `${text}  ${color.dim(`(${due.key}, ${suffix})`)}`;
}

export function isOverdue(task, today = todayKey()) {
  const due = parseDue(task);
  return Boolean(due) && daysBetween(today, due.key) < 0;
}

export function isDueToday(task, today = todayKey()) {
  const due = parseDue(task);
  return Boolean(due) && due.key === today;
}
