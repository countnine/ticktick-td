import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createdAt,
  dateKey,
  displayWidth,
  formatRow,
  isDueToday,
  isOverdue,
  padEndWidth,
  parseDue,
  priorityLabel,
  sortForBacklog,
  sortForToday,
} from '../src/view.mjs';

const TZ = 'Asia/Seoul';
const NAMES = new Map([['p1', 'Work']]);
const TODAY = '2026-07-31';

/** KST 종일 항목: 로컬 자정을 UTC 로 저장하는 규칙 (실제 TickTick 이 쓰는 방식) */
const localMidnightUtc = (day) => `${day}T15:00:00.000+0000`;

function task(overrides = {}) {
  return {
    id: '6890a1b2c3d4e5f600000001',
    projectId: 'p1',
    title: '제목',
    priority: 0,
    timeZone: TZ,
    isAllDay: true,
    ...overrides,
  };
}

describe('parseDue', () => {
  it('종일 항목은 태스크 타임존 기준 날짜로 읽는다', () => {
    // 2026-07-30T15:00Z 는 KST 로 7월 31일 00:00
    const due = parseDue(task({ dueDate: localMidnightUtc('2026-07-30') }));
    assert.equal(due.key, TODAY);
    assert.equal(due.allDay, true);
  });

  it('UTC 자정으로 저장된 종일 항목도 같은 날짜가 나온다', () => {
    const due = parseDue(task({ dueDate: '2026-07-31T00:00:00.000+0000' }));
    assert.equal(due.key, TODAY);
  });

  it('마감이 없으면 null', () => {
    assert.equal(parseDue(task()), null);
    assert.equal(parseDue(task({ dueDate: '말도 안 되는 값' })), null);
  });
});

describe('createdAt', () => {
  it('createdTime 이 있으면 그대로 쓴다', () => {
    const at = createdAt(task({ createdTime: '2026-01-02T03:04:05.000+0000' }));
    assert.equal(at.toISOString(), '2026-01-02T03:04:05.000Z');
  });

  it('createdTime 이 없으면 ObjectId 앞 8자리에서 복원한다', () => {
    // 0x60000000 = 1610612736초 = 2021-01-14T08:25:36Z
    const at = createdAt(task({ id: '60000000c3d4e5f600000004' }));
    assert.equal(at.toISOString(), '2021-01-14T08:25:36.000Z');
  });

  it('id 가 ObjectId 형식이 아니면 null', () => {
    assert.equal(createdAt({ id: 'not-an-object-id' }), null);
  });
});

describe('정렬', () => {
  const timed = task({ id: 'a', title: '시간 지정', isAllDay: false, dueDate: '2026-07-31T05:00:00.000+0000' });
  const allDayHigh = task({ id: 'b', title: '종일 높음', priority: 5, dueDate: localMidnightUtc('2026-07-30') });
  const allDayLow = task({ id: 'c', title: '종일 낮음', priority: 1, dueDate: localMidnightUtc('2026-07-30') });

  it('오늘 뷰: 시간 지정이 종일보다 먼저', () => {
    const sorted = sortForToday([allDayHigh, timed, allDayLow]);
    assert.deepEqual(
      sorted.map((t) => t.id),
      ['a', 'b', 'c'],
    );
  });

  it('보조 뷰: 우선순위 내림차순 → 등록일 오래된 순', () => {
    const old = task({ id: 'old', priority: 5, createdTime: '2020-01-01T00:00:00.000+0000' });
    const recent = task({ id: 'recent', priority: 5, createdTime: '2026-01-01T00:00:00.000+0000' });
    const low = task({ id: 'low', priority: 1, createdTime: '2019-01-01T00:00:00.000+0000' });

    assert.deepEqual(
      sortForBacklog([recent, low, old]).map((t) => t.id),
      ['old', 'recent', 'low'],
    );
  });
});

describe('isDueToday / isOverdue', () => {
  it('오늘·지연·미래를 구분한다', () => {
    const today = task({ dueDate: localMidnightUtc('2026-07-30') });
    const past = task({ dueDate: localMidnightUtc('2026-07-27') });
    const future = task({ dueDate: localMidnightUtc('2026-08-10') });

    assert.equal(isDueToday(today, TODAY), true);
    assert.equal(isOverdue(today, TODAY), false);
    assert.equal(isOverdue(past, TODAY), true);
    assert.equal(isDueToday(future, TODAY), false);
    assert.equal(isOverdue(future, TODAY), false);
  });

  it('마감이 없으면 둘 다 false', () => {
    assert.equal(isDueToday(task(), TODAY), false);
    assert.equal(isOverdue(task(), TODAY), false);
  });
});

describe('formatRow', () => {
  it('오늘·내일·지연을 사람이 읽는 문구로 쓴다', () => {
    const today = formatRow(1, task({ dueDate: localMidnightUtc('2026-07-30') }), NAMES, TODAY);
    const tomorrow = formatRow(1, task({ dueDate: localMidnightUtc('2026-07-31') }), NAMES, TODAY);
    const overdue = formatRow(1, task({ dueDate: localMidnightUtc('2026-07-27') }), NAMES, TODAY);

    assert.match(today, /Work · 오늘$/);
    assert.match(tomorrow, /Work · 내일$/);
    assert.match(overdue, /3일 지남 \(2026-07-28\)/);
  });

  it('알 수 없는 projectId 는 인박스로 표시한다', () => {
    assert.match(formatRow(1, task({ projectId: 'inbox123' }), NAMES, TODAY), /인박스/);
  });

  it('마크다운 링크는 라벨만 남는다', () => {
    const row = formatRow(1, task({ title: '[step](https://www.step.or.kr/) 강의' }), NAMES, TODAY);
    assert.match(row, /step 강의/);
    assert.doesNotMatch(row, /step\.or\.kr/);
  });

  it('한글이 섞여도 메타 열의 시작 위치가 같다', () => {
    const rows = [
      formatRow(1, task({ title: 'ascii only' }), NAMES, TODAY),
      formatRow(2, task({ title: '한글 제목 섞임' }), NAMES, TODAY),
      formatRow(3, task({ title: '아주 긴 한글 제목이라 잘려야 정상인 항목입니다 정말로 깁니다' }), NAMES, TODAY),
    ];
    // 문자 개수가 아니라 터미널에서 차지하는 폭으로 비교해야 한다 (한글 1글자 = 2칸)
    const starts = rows.map((row) => displayWidth(row.slice(0, row.indexOf('Work ·'))));
    assert.equal(new Set(starts).size, 1, `메타 열 시작 위치가 어긋남: ${starts}`);
  });
});

describe('padEndWidth', () => {
  it('한글을 두 칸으로 세어 채운다', () => {
    assert.equal(padEndWidth('가나', 6), '가나  ');
    assert.equal(padEndWidth('abcd', 6), 'abcd  ');
    assert.equal(padEndWidth('넘치는값', 2), '넘치는값');
  });
});

describe('priorityLabel', () => {
  it('우선순위 숫자를 한글로 바꾼다', () => {
    assert.equal(priorityLabel({ priority: 5 }), '높음');
    assert.equal(priorityLabel({ priority: 3 }), '중간');
    assert.equal(priorityLabel({ priority: 1 }), '낮음');
    assert.equal(priorityLabel({}), '없음');
  });
});

describe('dateKey', () => {
  it('타임존 기준 YYYY-MM-DD 를 만든다', () => {
    assert.equal(dateKey(new Date('2026-07-30T15:00:00Z'), TZ), '2026-07-31');
    assert.equal(dateKey(new Date('2026-07-30T15:00:00Z'), 'UTC'), '2026-07-30');
  });
});
