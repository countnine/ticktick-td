import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeChanges,
  draftToUpdate,
  normalizeDraft,
  parseDraft,
  parsePriority,
  resolveEditor,
  serializeDraft,
  taskToDraft,
} from '../src/edit.mjs';

const TZ = 'Asia/Seoul';
/** KST 종일 항목: 그 날짜의 로컬 자정을 UTC 로 저장한다 (= 하루 전 15:00Z) */
const kstAllDay = (day) => new Date(Date.parse(`${day}T00:00:00+09:00`)).toISOString().replace('Z', '+0000');

function task(overrides = {}) {
  return {
    id: '6890a1b2c3d4e5f600000001',
    projectId: 'p1',
    title: '보고서 초안',
    priority: 3,
    timeZone: TZ,
    isAllDay: true,
    dueDate: kstAllDay('2026-08-06'),
    startDate: kstAllDay('2026-08-06'),
    content: '',
    ...overrides,
  };
}

describe('parsePriority', () => {
  it('이름과 숫자를 모두 받는다', () => {
    assert.equal(parsePriority('high'), 5);
    assert.equal(parsePriority('MED'), 3);
    assert.equal(parsePriority('medium'), 3);
    assert.equal(parsePriority('low'), 1);
    assert.equal(parsePriority('none'), 0);
    assert.equal(parsePriority('5'), 5);
  });

  it('엉뚱한 값은 사람이 읽는 오류', () => {
    assert.throws(() => parsePriority('아무거나'), /high \| med \| low \| none/);
    assert.throws(() => parsePriority('4'), /high \| med \| low \| none/);
  });
});

describe('taskToDraft', () => {
  it('종일 항목은 날짜만, 시각 항목은 날짜와 시각을 적는다', () => {
    assert.equal(taskToDraft(task()).due, '2026-08-06');

    const timed = task({ isAllDay: false, dueDate: '2026-08-06T05:00:00.000+0000' });
    assert.equal(taskToDraft(timed).due, '2026-08-06 14:00');
  });

  it('기한이 없으면 none', () => {
    assert.equal(taskToDraft(task({ dueDate: undefined })).due, 'none');
  });

  it('우선순위를 이름으로 적는다', () => {
    assert.equal(taskToDraft(task({ priority: 5 })).priority, 'high');
    assert.equal(taskToDraft(task({ priority: 0 })).priority, 'none');
  });
});

describe('normalizeDraft', () => {
  it('같은 값을 다르게 쓴 입력을 표준형으로 맞춘다', () => {
    // 이게 없으면 --p 5 나 --due 2026-08-06 이 늘 "바뀜" 으로 잡힌다
    const before = taskToDraft(task());
    const normalized = normalizeDraft({ ...before, priority: '3', due: '2026-08-06' });
    assert.deepEqual(normalized, before);
  });

  it('none 은 그대로 둔다', () => {
    assert.equal(normalizeDraft({ ...taskToDraft(task()), due: 'NONE' }).due, 'none');
  });

  it('잘못된 값은 던진다', () => {
    assert.throws(() => normalizeDraft({ ...taskToDraft(task()), due: '내일모레' }));
    assert.throws(() => normalizeDraft({ ...taskToDraft(task()), priority: '9' }));
  });
});

describe('draftToUpdate', () => {
  it('바뀐 필드만 담는다 (부분 갱신이라 나머지는 서버가 보존한다)', () => {
    const current = task();
    const draft = { ...taskToDraft(current), title: '새 제목' };
    assert.deepEqual(draftToUpdate(current, draft), { title: '새 제목' });
  });

  it('아무것도 안 바꾸면 빈 객체', () => {
    const current = task();
    assert.deepEqual(draftToUpdate(current, taskToDraft(current)), {});
  });

  it('마감을 바꾸면 isAllDay·timeZone 도 함께 보낸다', () => {
    const current = task();
    const body = draftToUpdate(current, { ...taskToDraft(current), due: '2026-08-09 09:30' });
    assert.equal(body.isAllDay, false);
    assert.ok(body.dueDate.startsWith('2026-08-09') || body.dueDate.startsWith('2026-08-08'));
    assert.ok(body.timeZone);
  });

  it('하루짜리 항목은 시작일도 함께 옮긴다', () => {
    const current = task(); // startDate === dueDate
    const body = draftToUpdate(current, { ...taskToDraft(current), due: '2026-08-09' });
    assert.equal(body.startDate, body.dueDate);
  });

  it('기간이 있는 항목의 시작일은 건드리지 않는다', () => {
    const current = task({ startDate: kstAllDay('2026-08-01') });
    const body = draftToUpdate(current, { ...taskToDraft(current), due: '2026-08-09' });
    assert.equal(body.startDate, undefined);
  });

  it('due none 은 dueDate 를 null 로 보낸다', () => {
    const body = draftToUpdate(task(), { ...taskToDraft(task()), due: 'none' });
    assert.equal(body.dueDate, null);
    assert.equal('isAllDay' in body, false);
  });

  it('우선순위는 숫자로 보낸다', () => {
    const body = draftToUpdate(task(), { ...taskToDraft(task()), priority: 'low' });
    assert.deepEqual(body, { priority: 1 });
  });
});

describe('버퍼 왕복', () => {
  it('직렬화한 걸 그대로 파싱하면 원래 초안이 나온다', () => {
    const draft = { ...taskToDraft(task({ content: '한 줄\n두 줄' })) };
    assert.deepEqual(parseDraft(serializeDraft(draft)), draft);
  });

  it('본문 안의 --- 는 본문으로 남는다 (첫 구분선만 쓴다)', () => {
    const draft = { ...taskToDraft(task()), content: '위\n---\n아래' };
    assert.equal(parseDraft(serializeDraft(draft)).content, '위\n---\n아래');
  });

  it('# 로 시작하는 줄과 빈 줄은 무시한다', () => {
    const parsed = parseDraft('# 안내\n\ntitle: 제목\ndue: none\npriority: none\n---\n본문');
    assert.equal(parsed.title, '제목');
    assert.equal(parsed.content, '본문');
  });

  it('제목에 콜론이 들어가도 값 전체를 가져온다', () => {
    const draft = { ...taskToDraft(task()), title: '회의: 3분기 계획 10:00' };
    assert.equal(parseDraft(serializeDraft(draft)).title, '회의: 3분기 계획 10:00');
  });

  it('CRLF 로 저장돼도 읽힌다 (Windows 메모장)', () => {
    const text = serializeDraft(taskToDraft(task())).replace(/\n/g, '\r\n');
    assert.equal(parseDraft(text).title, '보고서 초안');
  });

  it('본문 끝의 빈 줄은 다듬는다', () => {
    assert.equal(parseDraft('title: 제목\ndue: none\npriority: none\n---\n본문\n\n\n').content, '본문');
  });
});

describe('버퍼 오류', () => {
  const ok = 'title: 제목\ndue: none\npriority: none\n---\n본문';

  it('구분선이 없으면 알려 준다', () => {
    assert.throws(() => parseDraft('title: 제목\ndue: none\npriority: none'), /구분선/);
  });

  it('모르는 항목은 알려 준다', () => {
    assert.throws(() => parseDraft(ok.replace('due:', 'deadline:')), /알 수 없는 항목/);
  });

  it('빠진 줄을 알려 준다', () => {
    assert.throws(() => parseDraft(ok.replace('priority: none\n', '')), /priority 줄이 없습니다/);
  });

  it('제목이 비면 알려 준다', () => {
    assert.throws(() => parseDraft(ok.replace('title: 제목', 'title:')), /제목이 비어 있습니다/);
  });

  it('헤더 형식이 아니면 알려 준다', () => {
    assert.throws(() => parseDraft(`그냥 문장\n${ok}`), /헤더 형식이 아닙니다/);
  });

  it('값이 잘못되면 파싱 단계에서 걸린다 (임시 파일을 살려 두기 위해)', () => {
    assert.throws(() => parseDraft(ok.replace('priority: none', 'priority: 아무거나')));
    assert.throws(() => parseDraft(ok.replace('due: none', 'due: 내일모레')));
  });
});

describe('describeChanges', () => {
  it('바뀐 것만 사람이 읽는 형태로 모은다', () => {
    const current = task({ priority: 0 });
    const changes = describeChanges(current, { ...taskToDraft(current), priority: 'high', title: '새 제목' });

    assert.deepEqual(changes, [
      { label: '제목', from: '보고서 초안', to: '새 제목' },
      { label: '우선순위', from: '없음', to: '높음' },
    ]);
  });

  it('기한 없음을 "없음" 으로 쓴다', () => {
    const current = task();
    const [change] = describeChanges(current, { ...taskToDraft(current), due: 'none' });
    assert.deepEqual(change, { label: '마감', from: '2026-08-06', to: '없음' });
  });

  it('본문은 줄 수로 요약한다', () => {
    const current = task({ content: '' });
    const [change] = describeChanges(current, { ...taskToDraft(current), content: '한 줄\n두 줄' });
    assert.deepEqual(change, { label: '내용', from: '0줄', to: '2줄' });
  });
});

describe('resolveEditor', () => {
  it('TD_EDITOR 가 VISUAL·EDITOR 보다 우선한다', () => {
    const editor = resolveEditor({ TD_EDITOR: 'nano', VISUAL: 'emacs', EDITOR: 'vi' });
    assert.equal(editor.command, 'nano');
  });

  it('VISUAL 이 EDITOR 보다 우선한다', () => {
    assert.equal(resolveEditor({ VISUAL: 'emacs', EDITOR: 'vi' }).command, 'emacs');
  });

  it('인자가 붙어 있어도 나눈다', () => {
    const editor = resolveEditor({ TD_EDITOR: 'code -w' });
    assert.equal(editor.command, 'code');
    assert.deepEqual(editor.args, ['-w']);
    assert.equal(editor.raw, 'code -w');
  });

  it('아무것도 없으면 플랫폼 기본값', () => {
    assert.equal(resolveEditor({}, 'win32').command, 'notepad');
    assert.equal(resolveEditor({}, 'darwin').command, 'vi');
  });
});
