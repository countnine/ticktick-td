import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveDue, toApiDate } from '../src/due.mjs';
import { todayKey } from '../src/view.mjs';

describe('resolveDue', () => {
  it('today / tomorrow 를 날짜로 바꾼다', () => {
    assert.equal(resolveDue('today').key, todayKey());

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const expected = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      tomorrow,
    );
    assert.equal(resolveDue('tomorrow').key, expected);
  });

  it('시간이 없으면 종일', () => {
    assert.deepEqual(resolveDue('2026-08-05'), { key: '2026-08-05', allDay: true, label: '2026-08-05' });
  });

  it('시간을 붙이면 시각 지정이 된다', () => {
    assert.deepEqual(resolveDue('2026-08-05 09:30'), {
      key: '2026-08-05',
      time: '09:30',
      allDay: false,
      label: '2026-08-05 09:30',
    });
  });

  it('한 자리 시간도 받는다', () => {
    assert.equal(resolveDue('today 9:05').time, '09:05');
  });

  it('잘못된 값은 거부한다', () => {
    assert.throws(() => resolveDue('yesterday'), /today \| tomorrow/);
    assert.throws(() => resolveDue('2026-8-5'), /today \| tomorrow/);
    assert.throws(() => resolveDue('today 25:00'), /시간 범위/);
    assert.throws(() => resolveDue('today 1800'), /시간 형식/);
    assert.throws(() => resolveDue('today 18:00 추가'), /너무 깁니다/);
    assert.throws(() => resolveDue(undefined), /today \| tomorrow/);
  });

  it('today / tomorrow 는 대소문자를 가리지 않는다', () => {
    assert.equal(resolveDue('Today').key, todayKey());
    assert.equal(resolveDue('TOMORROW').key, resolveDue('tomorrow').key);
    assert.equal(resolveDue('Today 9:05').time, '09:05');
  });
});

describe('toApiDate', () => {
  it('로컬 시각을 UTC 오프셋 표기로 바꾼다', () => {
    const out = toApiDate('2026-08-05', '09:30');
    assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0000$/);

    // 로컬 09:30 을 UTC 로 옮긴 값과 같아야 한다
    assert.equal(out, new Date('2026-08-05T09:30:00').toISOString().replace(/\.\d{3}Z$/, '+0000'));
  });

  it('시간을 생략하면 자정', () => {
    assert.equal(toApiDate('2026-08-05'), new Date('2026-08-05T00:00:00').toISOString().replace(/\.\d{3}Z$/, '+0000'));
  });

  it('말이 안 되는 날짜는 거부한다', () => {
    assert.throws(() => toApiDate('아무말'), /날짜 형식/);
  });
});
