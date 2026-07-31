#!/usr/bin/env node
/**
 * Open API 응답이 기대대로인지 확인하는 진단 스크립트.
 * 제목 등 내용은 출력하지 않고 구조만 요약한다.  실행: npm run probe
 */
import { listProjects } from '../src/api.mjs';
import { collectOpenTasks } from '../src/tasks.mjs';
import { createdAt, dateKey, isDueToday, isOverdue, parseDue, todayKey, LOCAL_TZ } from '../src/view.mjs';

const { tasks, inboxId } = await collectOpenTasks();
const projects = await listProjects();
const projectIds = new Set(projects.map((project) => project.id));
const today = todayKey();

console.log(`로컬 타임존         : ${LOCAL_TZ}`);
console.log(`오늘(로컬)          : ${today}`);
console.log(`미완료 태스크       : ${tasks.length}건`);
console.log(`GET /project 프로젝트: ${projects.length}개`);

console.log(`인박스 projectId    : ${inboxId ?? '(감지 실패)'}`);
const inboxCount = tasks.filter((task) => task.projectId === inboxId).length;
console.log(`  인박스 / 일반 프로젝트: ${inboxCount}건 / ${tasks.length - inboxCount}건`);
console.log('  ※ 인박스의 기한 없는 항목은 Open API 가 반환하지 않으므로 위 수치에서 빠져 있다.');

const withCreatedTime = tasks.filter((task) => task.createdTime).length;
console.log(`createdTime 보유    : ${withCreatedTime}/${tasks.length}건`);
if (withCreatedTime < tasks.length) {
  const recovered = tasks.filter((task) => !task.createdTime && createdAt(task)).length;
  console.log(`  ObjectId 로 복원   : ${recovered}/${tasks.length - withCreatedTime}건`);
}

const fields = new Set();
for (const task of tasks) for (const key of Object.keys(task)) fields.add(key);
console.log(`응답 필드           : ${[...fields].sort().join(', ')}`);

console.log(`\n오늘 마감으로 계산됨: ${tasks.filter((task) => isDueToday(task, today)).length}건`);
console.log(`지연으로 계산됨     : ${tasks.filter((task) => isOverdue(task, today)).length}건`);
console.log(`기한 없음           : ${tasks.filter((task) => !task.dueDate).length}건`);

console.log('\n마감일 샘플 (제목 제외, 최대 8건)');
for (const task of tasks.filter((task) => task.dueDate).slice(0, 8)) {
  const due = parseDue(task);
  console.log(
    `  dueDate=${task.dueDate}  isAllDay=${Boolean(task.isAllDay)}  timeZone=${task.timeZone ?? '(없음)'}` +
      `  → 태스크TZ날짜=${due.key}  로컬날짜=${dateKey(due.date)}`,
  );
}
console.log('\n두 날짜가 다른 종일 항목이 있으면 view.mjs 의 종일 처리 규칙을 재검토할 것.');
