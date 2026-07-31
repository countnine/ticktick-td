#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { ApiError, AuthError, closeConnections, completeTask, createTask, getTask } from '../src/api.mjs';
import { resolveDue, toApiDate } from '../src/due.mjs';
import { extractLinks, hyperlink, linkify, webAppUrl } from '../src/links.mjs';
import { getProjectNames, resolveProject } from '../src/projects.mjs';
import { collectOpenTasks } from '../src/tasks.mjs';
import { invalidateTaskCache, readLastList, saveLastList } from '../src/store.mjs';
import {
  LOCAL_TZ,
  color,
  describeDueLong,
  formatDateTime,
  formatRow,
  isDueToday,
  isOverdue,
  padEndWidth,
  priorityLabel,
  sortForBacklog,
  sortForToday,
  todayKey,
} from '../src/view.mjs';

const USAGE = `
${color.bold('td')} — 터미널에서 TickTick 오늘 할일 보기 / 완료 / 추가

  td                          오늘 마감인 할일
  td 10                       미완료 전체를 우선순위·오래된 순으로 10개 (td top [N] 과 동일)
  td view <번호>               방금 출력된 번호의 상세 (링크는 클릭 가능)
  td open <번호>               그 항목의 링크를 기본 브라우저로 열기
  td done <번호...>            방금 출력된 번호로 완료 처리 (예: td done 1 3)
  td add "<제목>" [옵션]        할일 추가
  td help                     이 도움말

${color.bold('add 옵션')}
  --due today | tomorrow | YYYY-MM-DD [HH:mm] | none   마감일 (기본: today, 시간 없으면 종일)
  --p  high | med | low | none                         우선순위
  --project <이름>                                      대상 프로젝트 (기본: 인박스)

${color.bold('공통 옵션')}
  --json                      서버 원본 JSON 출력 (목록·상세)
  --fresh, -f                 캐시(기본 5분) 무시하고 서버에서 새로 받기
  NO_COLOR=1 / NO_HYPERLINK=1  색 / 클릭 링크 끄기

${color.bold('처음 한 번')}
  npx -y @ticktick/ticktick-cli auth login
`.trim();

const PRIORITY_BY_NAME = { high: 5, med: 3, medium: 3, low: 1, none: 0 };

/** 이보다 오래된 번호 캐시로 완료하려 하면 경고한다 */
const STALE_LIST_MS = 30 * 60 * 1000;

/** --json: 서버 원본 태스크를 그대로 출력한다 (색·하이퍼링크 없음) */
let jsonMode = false;

/** --fresh: 캐시를 무시하고 서버에서 새로 받는다 */
let forceFresh = false;

/** 캐시에서 나온 결과임을 알리는 꼬리말 */
function cacheNote(result) {
  if (!result.fromCache) return '';
  const minutes = Math.round((Date.now() - Date.parse(result.savedAt)) / 60_000);
  return color.dim(`  (${minutes < 1 ? '방금' : `${minutes}분 전`} 기준 · td --fresh 로 갱신)`);
}

async function render(tasks, view) {
  const today = todayKey();

  if (jsonMode) {
    console.log(JSON.stringify(tasks, null, 2));
  } else {
    const projectNames = await getProjectNames(tasks);
    for (const [index, task] of tasks.entries()) {
      console.log(formatRow(index + 1, task, projectNames, today));
    }
  }

  await saveLastList(
    tasks.map((task, index) => ({
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
  const today = todayKey();
  const dueToday = sortForToday(tasks.filter((task) => isDueToday(task, today)));

  if (dueToday.length === 0 && !jsonMode) {
    console.log(color.green('오늘 마감인 할일이 없습니다.'));
    // 목록이 비어도 번호 캐시는 비워 둬야 이전 목록의 번호로 잘못 완료하는 일이 없다.
    await saveLastList([], 'today');
  } else {
    await render(dueToday, 'today');
  }
  if (jsonMode) return;

  const overdue = tasks.filter((task) => isOverdue(task, today)).length;
  const parts = [];
  if (overdue > 0) parts.push(color.red(`지연 ${overdue}건`));
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

  await render(picked, 'top');
  if (jsonMode) return;
  console.log(
    `${color.dim(`\n미완료 전체 ${tasks.length}건 중 ${picked.length}건 표시 (우선순위 → 오래된 순)`)}${cacheNote(result)}`,
  );
}

async function commandDone(args) {
  const numbers = args.map((arg) => Number.parseInt(arg, 10));
  if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n))) {
    console.error('사용법: td done <번호...>   (예: td done 1 3)');
    process.exitCode = 1;
    return;
  }

  const cache = await readLastList();
  if (!cache?.entries?.length) {
    console.error('표시된 목록이 없습니다. 먼저 `td` 또는 `td 10` 을 실행하세요.');
    process.exitCode = 1;
    return;
  }

  const ageMs = cache.savedAt ? Date.now() - Date.parse(cache.savedAt) : 0;
  if (ageMs > STALE_LIST_MS) {
    console.error(
      color.yellow(`목록을 띄운 지 ${Math.round(ageMs / 60_000)}분 지났습니다. 아래 항목이 맞는지 확인하세요.`),
    );
  }

  let failed = 0;
  for (const number of numbers) {
    const entry = cache.entries.find((item) => item.number === number);
    if (!entry) {
      console.error(color.red(`✗ ${number}번 항목이 목록에 없습니다.`));
      failed += 1;
      continue;
    }

    try {
      // 번호는 캐시 기반이라, 목록을 띄운 뒤 상황이 바뀌었으면 엉뚱한 할일을 완료할 수 있다.
      // 완료 직전에 단건 조회로 제목을 대조한다.
      const current = await getTask(entry.projectId, entry.id);

      if (current?.status !== 0) {
        console.error(color.yellow(`- ${number}. ${entry.title} — 이미 완료(또는 포기)된 항목입니다. 건너뜁니다.`));
        continue;
      }
      if (current?.title !== entry.title) {
        console.error(
          color.red(
            `✗ ${number}. 목록이 바뀌었습니다. 캐시="${entry.title}" / 현재="${current?.title}"\n` +
              '  `td` 를 다시 실행해 번호를 확인하세요.',
          ),
        );
        failed += 1;
        continue;
      }

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

function parseAddArgs(args) {
  const options = { title: undefined, due: undefined, priority: undefined, project: undefined };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--due':
      case '-d':
        options.due = args[index + 1];
        index += 1;
        break;
      case '--p':
      case '--priority':
      case '-p':
        options.priority = args[index + 1];
        index += 1;
        break;
      case '--project':
        options.project = args[index + 1];
        index += 1;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`알 수 없는 옵션: ${arg}`);
        options.title = options.title ? `${options.title} ${arg}` : arg;
    }
  }

  if (!options.title?.trim()) throw new Error('사용법: td add "<제목>" [--due today] [--p high]');
  return options;
}

async function commandAdd(args) {
  const options = parseAddArgs(args);
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

  if (options.priority !== undefined) {
    const priority = PRIORITY_BY_NAME[String(options.priority).toLowerCase()] ?? Number.parseInt(options.priority, 10);
    if (![0, 1, 3, 5].includes(priority)) {
      throw new Error('--p 값은 high | med | low | none (또는 5 | 3 | 1 | 0) 이어야 합니다.');
    }
    body.priority = priority;
  }

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

async function main() {
  const argv = process.argv.slice(2);

  // 전역 플래그는 어느 위치에 와도 되므로, add 의 제목으로 새어 들어가기 전에 먼저 빼낸다.
  const takeFlag = (...names) => {
    const index = argv.findIndex((arg) => names.includes(arg));
    if (index === -1) return false;
    argv.splice(index, 1);
    return true;
  };
  jsonMode = takeFlag('--json');
  forceFresh = takeFlag('--fresh', '-f');

  const [command, ...rest] = argv;

  if (command === undefined) return commandToday();
  if (['help', '--help', '-h'].includes(command)) return console.log(USAGE);
  if (command === 'view' || command === 'show') return commandView(rest);
  if (command === 'open') return commandOpen(rest);
  if (command === 'done') return commandDone(rest);
  if (command === 'add') return commandAdd(rest);
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
