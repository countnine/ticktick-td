import { todayKey } from './view.mjs';

/** 로컬 시각을 API 가 받는 yyyy-MM-ddTHH:mm:ss+0000 형식으로 변환 */
export function toApiDate(dateKeyValue, time = '00:00') {
  const local = new Date(`${dateKeyValue}T${time}:00`);
  if (Number.isNaN(local.getTime())) throw new Error(`날짜 형식이 올바르지 않습니다: ${dateKeyValue} ${time}`);
  return local.toISOString().replace(/\.\d{3}Z$/, '+0000');
}

function relativeDayKey(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/**
 * `--due` 값을 파싱한다.
 *   today | tomorrow | YYYY-MM-DD            → 종일
 *   "today 18:00" | "2026-08-05 09:30"       → 시각 지정
 *
 * @returns {{key: string, time?: string, allDay: boolean, label: string}}
 */
export function resolveDue(value) {
  const [datePart, timePart, ...rest] = String(value ?? '').trim().split(/\s+/);
  if (rest.length > 0) throw new Error(`--due 값이 너무 깁니다: ${value}`);

  // 키워드는 대소문자를 가리지 않는다 (`--p` 의 parsePriority 와 같은 규칙).
  const keyword = datePart?.toLowerCase();
  const key =
    keyword === 'today'
      ? todayKey()
      : keyword === 'tomorrow'
        ? relativeDayKey(1)
        : /^\d{4}-\d{2}-\d{2}$/.test(datePart ?? '')
          ? datePart
          : undefined;

  if (!key) throw new Error(`--due 값은 today | tomorrow | YYYY-MM-DD [HH:mm] | none 이어야 합니다: ${value}`);
  if (timePart === undefined) return { key, allDay: true, label: key };

  if (!/^\d{1,2}:\d{2}$/.test(timePart)) throw new Error(`시간 형식이 올바르지 않습니다 (HH:mm): ${timePart}`);
  const [hour, minute] = timePart.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new Error(`시간 범위가 올바르지 않습니다: ${timePart}`);

  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { key, time, allDay: false, label: `${key} ${time}` };
}
