#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  ApiError,
  AuthError,
  closeConnections,
  completeTask,
  createTask,
  deleteTask,
  getTask,
  listProjects,
  loadTokenInfo,
  updateTask,
} from '../src/api.mjs';
import { CAN_CHECK_MODE, findExposed, fixPermissions, maskToken } from '../src/auth.mjs';
import { resolveDue, toApiDate } from '../src/due.mjs';
import {
  describeChanges,
  draftToUpdate,
  editInEditor,
  normalizeDraft,
  parseDraft,
  parsePriority,
  serializeDraft,
  taskToDraft,
} from '../src/edit.mjs';
import { extractLinks, hyperlink, linkify, webAppUrl } from '../src/links.mjs';
import { getProjectNames, isInboxId, resolveProject } from '../src/projects.mjs';
import { collectOpenTasks } from '../src/tasks.mjs';
import {
  dropLastListEntries,
  invalidateTaskCache,
  patchLastListEntry,
  readLastList,
  saveLastList,
} from '../src/store.mjs';
import {
  DEFAULT_TODAY_FILL,
  LOCAL_TZ,
  buildTodayView,
  color,
  describeDueLong,
  formatDateTime,
  formatRow,
  padEndWidth,
  priorityLabel,
  sortForBacklog,
  todayKey,
} from '../src/view.mjs';

const USAGE = `
${color.bold('td')} — 터미널에서 TickTick 할일 보기 / 완료 / 추가 / 편집 / 삭제

  td                          오늘 마감인 할일 (모자라면 지난 항목으로 채움)
  td 10                       미완료 전체를 우선순위·오래된 순으로 10개 (td top [N] 과 동일)
  td view <번호>               방금 출력된 번호의 상세 (링크는 클릭 가능)
  td open <번호>               그 항목의 링크를 기본 브라우저로 열기
  td done <번호...>            방금 출력된 번호로 완료 처리 (예: td done 1 3)
  td add "<제목>" [옵션]        할일 추가
  td edit <번호> [옵션]         편집. 옵션이 없으면 에디터가 열린다
  td rm <번호...>              삭제 (확인을 묻는다. 휴지통에서 복구 가능)
  td auth status              토큰 출처·권한·연결 확인
  td help                     이 도움말

${color.bold('add 옵션')}
  --due today | tomorrow | YYYY-MM-DD [HH:mm] | none   마감일 (기본: today, 시간 없으면 종일)
  --p  high | med | low | none                         우선순위
  --project <이름>                                      대상 프로젝트 (기본: 인박스)

${color.bold('edit 옵션')}  (하나도 안 주면 $EDITOR 로 전체 편집)
  --title "<제목>"             제목
  --due  <위와 동일>            마감일. none 이면 기한을 지운다
  --p    <위와 동일>            우선순위
  --content "<본문>"           본문 (여러 줄은 에디터로)
  ※ 프로젝트 이동은 Open API 가 지원하지 않는다. 앱에서 옮길 것

${color.bold('공통 옵션')}
  --json                      서버 원본 JSON 출력 (목록·상세)
  --fresh, -f                 캐시(기본 5분) 무시하고 서버에서 새로 받기
  --fill <N>                  td 화면을 지난 항목으로 N줄까지 채움 (기본 10, 0이면 끔)
  --yes, -y                   삭제 확인 건너뛰기
  NO_COLOR=1 / NO_HYPERLINK=1  색 / 클릭 링크 끄기
  TD_EDITOR / TD_TOKEN_CMD    에디터 지정 / 토큰을 뱉는 외부 명령

${color.bold('처음 한 번')}
  npx -y @ticktick/ticktick-cli auth login
`.trim();

/** 이보다 오래된 번호 캐시로 완료하려 하면 경고한다 */
const STALE_LIST_MS = 30 * 60 * 1000;

/** --json: 서버 원본 태스크를 그대로 출력한다 (색·하이퍼링크 없음) */
let jsonMode = false;

/** --fresh: 캐시를 무시하고 서버에서 새로 받는다 */
let forceFresh = false;

/** `td` 기본 화면을 지난 항목으로 몇 줄까지 채울지. --fill / TD_TODAY_FILL 로 조절, 0 이면 끔. */
let todayFill = DEFAULT_TODAY_FILL;

/** -y / --yes: 삭제 확인 프롬프트를 건너뛴다 */
let skipConfirm = false;

/** 캐시에서 나온 결과임을 알리는 꼬리말 */
function cacheNote(result) {
  if (!result.fromCache) return '';
  const minutes = Math.round((Date.now() - Date.parse(result.savedAt)) / 60_000);
  return color.dim(`  (${minutes < 1 ? '방금' : `${minutes}분 전`} 기준 · td --fresh 로 갱신)`);
}

/**
 * 섹션 목록을 출력한다.
 * 번호는 **섹션을 가로질러 이어지고**, 저장되는 번호 캐시에도 모든 섹션이 들어간다.
 * 그래야 `td done 7` / `td rm 7` / `td view 7` 이 화면에 보이는 7번을 그대로 가리킨다.
 *
 * @param {{label?: string, tasks: object[]}[]} sections
 */
async function render(sections, view) {
  const all = sections.flatMap((section) => section.tasks);

  if (jsonMode) {
    console.log(JSON.stringify(all, null, 2));
  } else {
    const today = todayKey();
    const projectNames = await getProjectNames(all);
    let number = 0;
    for (const section of sections) {
      if (section.tasks.length === 0) continue;
      if (section.label) console.log(color.dim(`\n  ── ${section.label} ──\n`));
      for (const task of section.tasks) {
        number += 1;
        console.log(formatRow(number, task, projectNames, today));
      }
    }
  }

  await saveLastList(
    all.map((task, index) => ({
      number: index + 1,
      id: task.id,
      projectId: task.projectId,
      title: task.title,
    })),
    view,
  );
}

async function commandToday() {
  const result = await collectOpenTasks({ force: forceFresh });
  const { tasks } = result;
  const { sections, overdueCount } = buildTodayView(tasks, { today: todayKey(), fill: todayFill });
  const shown = sections.reduce((count, section) => count + section.tasks.length, 0);

  if (shown === 0 && !jsonMode) {
    console.log(color.green('오늘 마감인 할일이 없습니다.'));
    // 목록이 비어도 번호 캐시는 비워 둬야 이전 목록의 번호로 잘못 완료하는 일이 없다.
    await saveLastList([], 'today');
  } else {
    await render(sections, 'today');
  }
  if (jsonMode) return;

  const parts = [];
  if (overdueCount > 0) parts.push(color.red(`지연 ${overdueCount}건`));
  parts.push(`미완료 전체 ${tasks.length}건`);
  console.log(`${color.dim(`\n${parts.join(' · ')}  →  td 10`)}${cacheNote(result)}`);
}

async function commandTop(rawCount) {
  const count = Number.parseInt(rawCount ?? '10', 10);
  if (!Number.isInteger(count) || count <= 0) {
    console.error('개수는 1 이상의 정수여야 합니다.');
    process.exitCode = 1;
    return;
  }

  const result = await collectOpenTasks({ force: forceFresh });
  const { tasks } = result;
  const picked = sortForBacklog(tasks).slice(0, count);

  if (picked.length === 0 && !jsonMode) {
    console.log(color.green('미완료 할일이 없습니다.'));
    await saveLastList([], 'top');
    return;
  }

  await render([{ tasks: picked }], 'top');
  if (jsonMode) return;
  console.log(
    `${color.dim(`\n미완료 전체 ${tasks.length}건 중 ${picked.length}건 표시 (우선순위 → 오래된 순)`)}${cacheNote(result)}`,
  );
}

/**
 * 번호 목록을 캐시 항목으로 바꾼다. 목록이 없거나 번호가 잘못됐으면 안내를 출력하고 undefined.
 * 오래된 캐시면 경고만 하고 진행한다 (뒤에서 제목 대조가 한 번 더 막아 준다).
 */
async function resolveNumbers(args, usage) {
  const numbers = args.map((arg) => Number.parseInt(arg, 10));
  if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n))) {
    console.error(usage);
    process.exitCode = 1;
    return undefined;
  }

  const cache = await readLastList();
  if (!cache?.entries?.length) {
    console.error('표시된 목록이 없습니다. 먼저 `td` 또는 `td 10` 을 실행하세요.');
    process.exitCode = 1;
    return undefined;
  }

  const ageMs = cache.savedAt ? Date.now() - Date.parse(cache.savedAt) : 0;
  if (ageMs > STALE_LIST_MS) {
    console.error(
      color.yellow(`목록을 띄운 지 ${Math.round(ageMs / 60_000)}분 지났습니다. 아래 항목이 맞는지 확인하세요.`),
    );
  }

  return numbers.map((number) => ({ number, entry: cache.entries.find((item) => item.number === number) }));
}

/**
 * 번호 캐시는 목록을 띄운 뒤 상황이 바뀌면 엉뚱한 할일을 가리킬 수 있다.
 * 조작 직전에 단건 조회로 제목을 대조한다.
 * @returns {Promise<object|undefined>} 대조에 성공한 서버 최신 태스크
 */
async function verifyEntry(number, entry, { requireOpen = true } = {}) {
  const current = await getTask(entry.projectId, entry.id);

  if (requireOpen && current?.status !== 0) {
    console.error(color.yellow(`- ${number}. ${entry.title} — 이미 완료(또는 포기)된 항목입니다. 건너뜁니다.`));
    return undefined;
  }
  if (current?.title !== entry.title) {
    throw new Error(
      `목록이 바뀌었습니다. 캐시="${entry.title}" / 현재="${current?.title}"\n` +
        '  `td` 를 다시 실행해 번호를 확인하세요.',
    );
  }
  return current;
}

async function commandDone(args) {
  const targets = await resolveNumbers(args, '사용법: td done <번호...>   (예: td done 1 3)');
  if (!targets) return;

  let failed = 0;
  for (const { number, entry } of targets) {
    if (!entry) {
      console.error(color.red(`✗ ${number}번 항목이 목록에 없습니다.`));
      failed += 1;
      continue;
    }

    try {
      const current = await verifyEntry(number, entry);
      if (!current) continue; // 이미 완료됨 — 실패로 세지 않는다

      await completeTask(entry.projectId, entry.id);
      console.log(`${color.green('✓')} ${number}. ${entry.title}`);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      console.error(color.red(`✗ ${number}. ${entry.title} — ${error.message}`));
      failed += 1;
    }
  }

  await invalidateTaskCache();
  if (failed > 0) process.exitCode = 1;
}

/** [y/N] 확인. TTY 가 아니면 물어볼 수 없으므로 false 를 돌려준다. */
async function confirm(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    // 닫지 않으면 stdin 이 열린 채로 남아 프로세스가 끝나지 않는다.
    rl.close();
  }
}

async function commandRemove(args) {
  const targets = await resolveNumbers(args, '사용법: td rm <번호...>   (예: td rm 2 5)');
  if (!targets) return;

  // 지우기 전에 무엇을 지우는지 먼저 보여 준다. 여기서 제목 대조도 끝낸다.
  const confirmed = [];
  let failed = 0;
  for (const { number, entry } of targets) {
    if (!entry) {
      console.error(color.red(`✗ ${number}번 항목이 목록에 없습니다.`));
      failed += 1;
      continue;
    }
    try {
      // 삭제는 완료 여부와 무관하게 할 수 있어야 한다.
      await verifyEntry(number, entry, { requireOpen: false });
      confirmed.push({ number, entry });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      console.error(color.red(`✗ ${number}. ${entry.title} — ${error.message}`));
      failed += 1;
    }
  }

  if (confirmed.length > 0 && !skipConfirm) {
    for (const { number, entry } of confirmed) console.log(`  ${String(number).padStart(3)}. ${entry.title}`);

    if (!process.stdin.isTTY) {
      console.error(color.red(`\n${confirmed.length}건을 삭제하려면 -y 를 붙이세요 (대화형 터미널이 아닙니다).`));
      process.exitCode = 1;
      return;
    }
    const ok = await confirm(
      `\n${confirmed.length}건을 삭제합니다. TickTick 휴지통에서 복구할 수 있습니다.  계속할까요?`,
    );
    if (!ok) {
      console.log('취소했습니다.');
      return;
    }
  }

  const removed = [];
  for (const { number, entry } of confirmed) {
    try {
      await deleteTask(entry.projectId, entry.id);
      removed.push(entry.id);
      console.log(`${color.green('✓')} ${number}. ${entry.title} ${color.dim('삭제됨')}`);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      console.error(color.red(`✗ ${number}. ${entry.title} — ${error.message}`));
      failed += 1;
    }
  }

  await invalidateTaskCache();
  await dropLastListEntries(removed);
  if (failed > 0) process.exitCode = 1;
}

function printField(label, value) {
  if (value === undefined || value === null || value === '') return;
  console.log(`  ${color.dim(padEndWidth(label, 10))}  ${value}`);
}

function printBlock(label, text) {
  const body = String(text ?? '').trim();
  if (!body) return;
  console.log(`\n  ${color.bold(label)}`);
  for (const line of body.split(/\r?\n/)) console.log(`    ${linkify(line)}`);
}

/** 번호 → 캐시 항목 → 서버 최신 상태. 실패하면 안내를 출력하고 undefined 를 돌려준다. */
async function loadTaskByNumber(rawNumber, usage) {
  const number = Number.parseInt(rawNumber, 10);
  if (!Number.isInteger(number)) {
    console.error(usage);
    process.exitCode = 1;
    return undefined;
  }

  const cache = await readLastList();
  const entry = cache?.entries?.find((item) => item.number === number);
  if (!entry) {
    console.error(
      cache?.entries?.length
        ? `${number}번 항목이 목록에 없습니다. (1~${cache.entries.length})`
        : '표시된 목록이 없습니다. 먼저 `td` 또는 `td 10` 을 실행하세요.',
    );
    process.exitCode = 1;
    return undefined;
  }

  // 목록을 막 띄운 직후라면 캐시에 상세(content·desc·items 포함)가 그대로 있다. 왕복 한 번을 아낀다.
  if (!forceFresh) {
    const cached = await collectOpenTasks({ force: false });
    const hit = cached.fromCache && cached.tasks.find((task) => task.id === entry.id);
    if (hit) return { number, task: hit, fromCache: true, savedAt: cached.savedAt };
  }

  try {
    return { number, task: await getTask(entry.projectId, entry.id), fromCache: false };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    console.error(color.red(`불러오지 못했습니다 (삭제된 항목일 수 있습니다): ${error.message}`));
    process.exitCode = 1;
    return undefined;
  }
}

async function commandView(args) {
  const loaded = await loadTaskByNumber(args[0], '사용법: td view <번호>   (예: td view 1)');
  if (!loaded) return;
  const { number, task } = loaded;

  if (jsonMode) {
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  const projectNames = await getProjectNames([task]);
  const projectName = projectNames.get(task.projectId) ?? '인박스';

  const STATUS_LABELS = { 2: '완료됨', '-1': '포기함' };
  const statusLabel = STATUS_LABELS[task.status];

  console.log(`\n${color.bold(linkify(task.title ?? '(제목 없음)'))}\n`);
  if (statusLabel) {
    const at = formatDateTime(task.completedTime);
    printField('상태', color.green(at ? `${statusLabel} (${at})` : statusLabel));
  }
  printField('프로젝트', projectName);
  printField('마감', describeDueLong(task));
  printField('시작', task.startDate === task.dueDate ? undefined : formatDateTime(task.startDate, task.timeZone));
  printField('우선순위', priorityLabel(task));
  printField('태그', task.tags?.length ? task.tags.join(', ') : undefined);
  printField('반복', task.repeatFlag);
  printField('알림', task.reminders?.length ? task.reminders.join(', ') : undefined);
  printField('등록', formatDateTime(task.createdTime));
  printField('수정', formatDateTime(task.modifiedTime));

  if (task.items?.length) {
    const done = task.items.filter((item) => item.status === 1).length;
    console.log(`\n  ${color.bold(`체크리스트 (${done}/${task.items.length})`)}`);
    for (const item of task.items) {
      const mark = item.status === 1 ? color.green('☑') : '☐';
      console.log(`    ${mark} ${linkify(item.title ?? '')}`);
    }
  }

  printBlock('내용', task.content);
  printBlock('설명', task.desc);

  const links = extractLinks([task.title, task.content, task.desc, ...(task.items ?? []).map((i) => i.title)].join('\n'));
  if (links.length) {
    console.log(`\n  ${color.bold('링크')}`);
    for (const [index, link] of links.entries()) {
      const label = link.label === link.url ? '' : `${link.label} — `;
      console.log(`    ${index + 1}) ${label}${hyperlink(link.url)}`);
    }
  }

  console.log(`\n  ${color.dim('TickTick 에서 열기')}  ${hyperlink(webAppUrl(task.projectId, task.id), '↗ 웹앱')}`);
  if (!statusLabel) console.log(color.dim(`\n  완료하려면: td done ${number}   ·   링크 열기: td open ${number}`));
  if (loaded.fromCache) console.log(cacheNote(loaded).trimStart());
}

/** 기본 브라우저로 URL 을 연다. 의존성 없이 플랫폼별 명령을 쓴다. */
function openInBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', (error) => {
    console.error(color.red(`브라우저를 열지 못했습니다: ${error.message}`));
    console.error(url);
    process.exitCode = 1;
  });
  child.unref();
}

async function commandOpen(args) {
  const loaded = await loadTaskByNumber(args[0], '사용법: td open <번호>   (예: td open 1)');
  if (!loaded) return;
  const { task } = loaded;

  const links = extractLinks([task.title, task.content, task.desc].join('\n'));
  const target = links[0]?.url ?? webAppUrl(task.projectId, task.id);
  const what = links[0] ? (links[0].label === target ? target : `${links[0].label} — ${target}`) : 'TickTick 웹앱';

  console.log(`${color.green('↗')} ${what}`);
  if (links.length > 1) {
    console.log(color.dim(`  링크가 ${links.length}개입니다. 나머지는 td view ${loaded.number} 로 확인하세요.`));
  }
  openInBrowser(target);
}

/**
 * `--key value` 옵션과 위치 인자를 나눈다.
 * @param {Record<string, string>} spec 옵션 이름 → 담을 키
 */
function parseOptions(args, spec) {
  const options = {};
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const key = spec[arg];
    if (key) {
      if (index + 1 >= args.length) throw new Error(`${arg} 에 값이 없습니다.`);
      options[key] = args[index + 1];
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`알 수 없는 옵션: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { options, positional };
}

const ADD_SPEC = {
  '--due': 'due',
  '-d': 'due',
  '--p': 'priority',
  '--priority': 'priority',
  '-p': 'priority',
  '--project': 'project',
};

const EDIT_SPEC = {
  '--title': 'title',
  '-t': 'title',
  '--due': 'due',
  '-d': 'due',
  '--p': 'priority',
  '--priority': 'priority',
  '-p': 'priority',
  '--content': 'content',
};

async function commandEdit(args) {
  const usage = '사용법: td edit <번호> [--title "..."] [--due tomorrow] [--p high] [--content "..."]';
  const { options, positional } = parseOptions(args, EDIT_SPEC);

  const targets = await resolveNumbers(positional.slice(0, 1), usage);
  if (!targets) return;
  const { number, entry } = targets[0];
  if (!entry) {
    console.error(color.red(`${number}번 항목이 목록에 없습니다.`));
    process.exitCode = 1;
    return;
  }

  // 편집은 최신 상태를 봐야 정확한 차이가 나온다. 캐시 대신 단건 조회 + 제목 대조.
  const current = await verifyEntry(number, entry, { requireOpen: false });

  let draft = normalizeDraft({ ...taskToDraft(current), ...options });

  if (Object.keys(options).length === 0) {
    const projectNames = await getProjectNames([current]);
    const buffer = serializeDraft(draft, { projectName: projectNames.get(current.projectId) ?? '인박스' });
    const { text, file, cleanup } = await editInEditor(buffer);

    // 저장하지 않았거나 대기하지 않는 에디터(code 등)면 내용이 그대로다.
    if (text === buffer) {
      await cleanup();
      console.log('변경 없음');
      return;
    }

    try {
      draft = parseDraft(text);
    } catch (error) {
      console.error(color.red(error.message));
      console.error(color.dim(`  편집한 내용은 ${file} 에 남아 있습니다.`));
      process.exitCode = 1;
      return; // 일부러 지우지 않는다
    }
    await cleanup();
  }

  const body = draftToUpdate(current, draft);
  if (Object.keys(body).length === 0) {
    console.log('변경 없음');
    return;
  }

  await updateTask(current.id, { id: current.id, projectId: current.projectId, ...body });
  await invalidateTaskCache();
  // 제목을 바꿨다면 번호 캐시도 따라가야 같은 번호로 이어서 편집할 수 있다.
  if (body.title !== undefined) await patchLastListEntry(current.id, { title: body.title });

  console.log(`${color.green('✓')} ${number}. ${draft.title}`);
  for (const change of describeChanges(current, draft)) {
    console.log(`    ${color.dim(padEndWidth(change.label, 8))}  ${change.from} → ${change.to}`);
  }

  if (body.dueDate === null) {
    if (isInboxId(current.projectId)) {
      console.log(color.dim('  주의: 인박스의 기한 없는 항목은 Open API 로 조회되지 않아 td 목록에서 사라집니다.'));
    }
    // 실측: 기한이 없으면 서버가 repeatFlag 를 빈 값으로 돌려준다. 기한을 다시 넣으면 규칙이 되살아난다.
    if (current.repeatFlag) {
      console.log(color.dim('  주의: 기한이 없는 동안은 반복 설정이 표시되지 않습니다 (기한을 다시 넣으면 돌아옵니다).'));
    }
  }
}

async function commandAdd(args) {
  const { options, positional } = parseOptions(args, ADD_SPEC);
  options.title = positional.join(' ');
  if (!options.title.trim()) throw new Error('사용법: td add "<제목>" [--due today] [--p high]');

  const body = { title: options.title.trim() };

  // 마감일을 생략하면 오늘로 잡는다.
  // 인박스의 기한 없는 태스크는 Open API 가 돌려주지 않아 td 목록에서 영영 보이지 않기 때문이다.
  const dueInput = options.due ?? 'today';
  const due = dueInput === 'none' ? undefined : resolveDue(dueInput);
  if (due) {
    body.dueDate = toApiDate(due.key, due.time);
    body.isAllDay = due.allDay;
    body.timeZone = LOCAL_TZ;
  }

  if (options.priority !== undefined) body.priority = parsePriority(options.priority);

  // projectId 를 생략하면 서버가 인박스에 넣는다.
  if (options.project) body.projectId = (await resolveProject(options.project)).id;

  const created = await createTask(body);
  await invalidateTaskCache();
  const where = options.project ?? '인박스';
  const when = due?.label ?? '기한 없음';
  console.log(`${color.green('✓')} 추가했습니다: ${created?.title ?? body.title} ${color.dim(`(${where} · ${when})`)}`);

  if (!body.dueDate && !options.project) {
    console.log(color.dim('  주의: 인박스의 기한 없는 항목은 Open API 로 조회되지 않아 td 목록에 나오지 않습니다.'));
  }
}

async function commandAuth(args) {
  const sub = args[0] ?? 'status';

  if (sub === 'fix-perms') {
    if (!CAN_CHECK_MODE) {
      console.log('Windows 에서는 필요 없습니다. 파일이 사용자 프로필의 ACL 을 그대로 따릅니다.');
      return;
    }
    const fixed = await fixPermissions();
    if (fixed.length === 0) {
      console.log(color.green('이미 안전합니다. 바꿀 것이 없습니다.'));
      return;
    }
    console.log(color.green(`${fixed.length}개를 조였습니다 (파일 600 · 디렉터리 700):`));
    for (const path of fixed) console.log(`  ${path}`);
    return;
  }

  if (sub !== 'status') {
    console.error('사용법: td auth status | td auth fix-perms');
    process.exitCode = 1;
    return;
  }

  const info = await loadTokenInfo();
  printField('토큰', `${maskToken(info.token)}  ${color.dim(`(${info.token.length}자)`)}`);
  printField('출처', info.source);

  if (!CAN_CHECK_MODE) {
    printField('권한', color.dim('Windows — 사용자 프로필 ACL 을 따르므로 모드 점검 대상이 아닙니다'));
  } else {
    const exposed = await findExposed();
    if (exposed.length === 0) {
      printField('권한', `${color.green('✓')} 본인만 읽을 수 있습니다`);
    } else {
      printField('권한', color.yellow(`⚠ ${exposed.length}개를 다른 로컬 사용자가 읽을 수 있습니다`));
      for (const entry of exposed) console.log(`  ${color.dim(' '.repeat(10))}  ${entry.octal}  ${entry.path}`);
      console.log(`  ${color.dim(' '.repeat(10))}  ${color.yellow('td auth fix-perms 로 조이세요.')}`);
    }
  }

  const projects = await listProjects();
  printField('연결', `${color.green('정상')}  ${color.dim(`(프로젝트 ${projects.length}개)`)}`);
}

async function main() {
  const argv = process.argv.slice(2);

  // 전역 플래그는 어느 위치에 와도 되므로, add 의 제목으로 새어 들어가기 전에 먼저 빼낸다.
  const takeFlag = (...names) => {
    const index = argv.findIndex((arg) => names.includes(arg));
    if (index === -1) return false;
    argv.splice(index, 1);
    return true;
  };
  // 값을 받는 전역 옵션. --fill 5 와 --fill=5 를 모두 받는다.
  const takeOption = (name) => {
    const index = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
    if (index === -1) return undefined;
    const arg = argv[index];
    if (arg.includes('=')) {
      argv.splice(index, 1);
      return arg.slice(arg.indexOf('=') + 1);
    }
    const [, value] = argv.splice(index, 2);
    return value;
  };

  jsonMode = takeFlag('--json');
  forceFresh = takeFlag('--fresh', '-f');
  skipConfirm = takeFlag('--yes', '-y');

  const fillInput = takeOption('--fill') ?? process.env.TD_TODAY_FILL;
  if (fillInput !== undefined && fillInput !== '') {
    const parsed = Number.parseInt(fillInput, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      console.error('--fill 값은 0 이상의 정수여야 합니다.');
      process.exitCode = 1;
      return;
    }
    todayFill = parsed;
  }

  const [command, ...rest] = argv;

  if (command === undefined) return commandToday();
  if (['help', '--help', '-h'].includes(command)) return console.log(USAGE);
  if (command === 'view' || command === 'show') return commandView(rest);
  if (command === 'open') return commandOpen(rest);
  if (command === 'done') return commandDone(rest);
  if (['rm', 'delete', 'del'].includes(command)) return commandRemove(rest);
  if (command === 'edit') return commandEdit(rest);
  if (command === 'add') return commandAdd(rest);
  if (command === 'auth') return commandAuth(rest);
  if (command === 'top') return commandTop(rest[0]);
  if (/^\d+$/.test(command)) return commandTop(command);

  console.error(`알 수 없는 명령: ${command}\n`);
  console.error(USAGE);
  process.exitCode = 1;
}

// process.exit() 를 쓰면 아직 정리되지 않은 소켓 때문에 Windows 에서 libuv 어설션이 난다.
// exitCode 만 세팅하고, 남은 keep-alive 소켓은 closeConnections() 로 닫아 즉시 종료되게 한다.
main()
  .catch((error) => {
    if (error instanceof AuthError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    if (error instanceof ApiError || error instanceof Error) {
      console.error(color.red(error.message));
      process.exitCode = 1;
      return;
    }
    console.error(color.red(String(error)));
    process.exitCode = 1;
  })
  .finally(closeConnections);
