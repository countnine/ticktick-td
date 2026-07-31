import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { extractLinks, firstUrl, hyperlink, linkify, stripMarkdownLinks, webAppUrl } from '../src/links.mjs';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** 테스트 프로세스는 TTY 가 아니므로, 하이퍼링크 경로를 보려면 켜 줘야 한다 */
function withTty(fn) {
  const original = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    return fn();
  } finally {
    process.stdout.isTTY = original;
  }
}

afterEach(() => {
  delete process.env.NO_HYPERLINK;
});

describe('hyperlink', () => {
  it('TTY 에서는 OSC 8 시퀀스로 감싼다', () => {
    const out = withTty(() => hyperlink('https://example.com', '예시'));
    assert.equal(out, `${ESC}]8;;https://example.com${BEL}예시${ESC}]8;;${BEL}`);
  });

  it('TTY 가 아니면 라벨만 남긴다', () => {
    assert.equal(hyperlink('https://example.com', '예시'), '예시');
  });

  it('NO_HYPERLINK=1 이면 끈다', () => {
    process.env.NO_HYPERLINK = '1';
    assert.equal(
      withTty(() => hyperlink('https://example.com', '예시')),
      '예시',
    );
  });

  it('URL 이 없으면 라벨을 그대로 돌려준다', () => {
    assert.equal(
      withTty(() => hyperlink(undefined, '라벨')),
      '라벨',
    );
  });
});

describe('linkify', () => {
  const sample = '[step](https://www.step.or.kr/) 강의 그리고 https://example.com/a?b=1 참고';

  it('마크다운 링크와 맨 URL 을 한 번에 처리한다', () => {
    const out = withTty(() => linkify(sample));
    assert.match(out, /]8;;https:\/\/www\.step\.or\.kr\//);
    assert.match(out, /]8;;https:\/\/example\.com\/a\?b=1/);
  });

  it('이미 감싼 URL 을 다시 감싸지 않는다', () => {
    const out = withTty(() => linkify(sample));
    // 링크 2개 → 여는 시퀀스 2개 + 닫는 시퀀스 2개 = ESC 4개
    assert.equal((out.match(new RegExp(ESC, 'g')) ?? []).length, 4);
  });

  it('링크가 없으면 원문 그대로', () => {
    assert.equal(linkify('링크 없는 문장'), '링크 없는 문장');
  });
});

describe('stripMarkdownLinks', () => {
  it('라벨만 남긴다', () => {
    assert.equal(stripMarkdownLinks('[step](https://www.step.or.kr/) 강의'), 'step 강의');
  });

  it('맨 URL 은 건드리지 않는다', () => {
    assert.equal(stripMarkdownLinks('https://example.com 참고'), 'https://example.com 참고');
  });
});

describe('firstUrl', () => {
  it('마크다운 링크의 URL 을 꺼낸다', () => {
    assert.equal(firstUrl('[step](https://www.step.or.kr/) 강의'), 'https://www.step.or.kr/');
  });

  it('맨 URL 도 꺼낸다', () => {
    assert.equal(firstUrl('참고 https://example.com/x 끝'), 'https://example.com/x');
  });

  it('없으면 undefined', () => {
    assert.equal(firstUrl('링크 없음'), undefined);
    assert.equal(firstUrl(undefined), undefined);
  });

  it('호출을 반복해도 결과가 같다 (정규식 lastIndex 오염 없음)', () => {
    const text = '[a](https://a.example) [b](https://b.example)';
    assert.equal(firstUrl(text), 'https://a.example');
    assert.equal(firstUrl(text), 'https://a.example');
  });
});

describe('extractLinks', () => {
  it('중복 URL 을 한 번만 담는다', () => {
    const links = extractLinks('[a](https://x.example) 그리고 https://x.example 또 [b](https://y.example)');
    assert.deepEqual(links, [
      { url: 'https://x.example', label: 'a' },
      { url: 'https://y.example', label: 'b' },
    ]);
  });

  it('라벨이 없으면 URL 을 라벨로 쓴다', () => {
    assert.deepEqual(extractLinks('https://z.example'), [{ url: 'https://z.example', label: 'https://z.example' }]);
  });
});

describe('webAppUrl', () => {
  it('웹앱 주소를 만든다', () => {
    assert.equal(webAppUrl('inbox1', 'task1'), 'https://ticktick.com/webapp/#p/inbox1/tasks/task1');
  });
});
