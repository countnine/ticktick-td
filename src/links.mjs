const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// OSC 8 하이퍼링크. Windows Terminal, iTerm2, 최신 macOS 터미널, VS Code 터미널에서 클릭된다.
// 지원하지 않는 터미널은 라벨만 보이므로 깨지지 않는다. NO_HYPERLINK=1 로 끌 수 있다.
// (import 시점이 아니라 호출 시점에 판정한다 — 테스트에서 토글할 수 있게)
function supportsHyperlink() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_HYPERLINK;
}

export function hyperlink(url, label = url) {
  if (!url || !supportsHyperlink()) return label;
  return `${ESC}]8;;${url}${BEL}${label}${ESC}]8;;${BEL}`;
}

const MARKDOWN_LINK = String.raw`\[([^\]]+)\]\((https?://[^\s)]+)\)`;
const BARE_URL = String.raw`(https?://[^\s<>()\[\]]+)`;
const COMBINED = new RegExp(`${MARKDOWN_LINK}|${BARE_URL}`, 'g');

/** `[라벨](url)` → 라벨만 남긴다 (목록에서 폭을 잡아먹지 않게) */
export function stripMarkdownLinks(text) {
  return String(text ?? '').replace(new RegExp(MARKDOWN_LINK, 'g'), '$1');
}

/** 마크다운 링크와 맨 URL 을 한 번에 클릭 가능한 형태로 바꾼다. */
export function linkify(text) {
  return String(text ?? '').replace(COMBINED, (_match, label, url, bare) =>
    bare ? hyperlink(bare) : hyperlink(url, label),
  );
}

export function firstUrl(text) {
  const match = new RegExp(COMBINED.source).exec(String(text ?? ''));
  if (!match) return undefined;
  return match[2] ?? match[3];
}

/** 텍스트에서 링크를 모두 뽑는다 (중복 URL 제거) */
export function extractLinks(text) {
  const found = new Map();
  for (const match of String(text ?? '').matchAll(COMBINED)) {
    const url = match[2] ?? match[3];
    if (!found.has(url)) found.set(url, match[1] ?? url);
  }
  return [...found].map(([url, label]) => ({ url, label }));
}

/** TickTick 웹앱에서 해당 태스크를 여는 주소 */
export function webAppUrl(projectId, taskId) {
  return `https://ticktick.com/webapp/#p/${projectId}/tasks/${taskId}`;
}
