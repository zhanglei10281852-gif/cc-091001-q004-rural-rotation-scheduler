import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulerService } from '../src/service.js';
import { createApp } from '../src/server.js';

const TZ = '+08:00';
const iso = (s) => `2026-${s}${TZ}`;

async function freshService() {
  const dir = await mkdtemp(join(tmpdir(), 'rotation-'));
  const svc = await new SchedulerService(join(dir, 'db.json')).init();
  await svc.setPolicy({ minRestMinutes: 660, minContinuousMinutes: 2880, travelBufferMinutes: 0 });
  for (const id of ['S-HOME', 'S-RURAL-1', 'S-RURAL-2']) {
    await svc.registerSchool({ id, name: id });
  }
  await svc.setTravel('S-HOME', 'S-RURAL-1', 45);
  await svc.setTravel('S-HOME', 'S-RURAL-2', 60);
  await svc.setTravel('S-RURAL-1', 'S-RURAL-2', 30);
  await svc.registerTeacher({ id: 'T-301', homeSchool: 'S-HOME', qualifications: ['math-middle'] });
  await svc.registerTeacher({ id: 'T-302', homeSchool: 'S-HOME', qualifications: ['math-middle'] });
  await svc.registerTeacher({ id: 'T-303', homeSchool: 'S-HOME', qualifications: ['chinese-middle'] });
  await svc.addDemand({ id: 'D1', school: 'S-RURAL-1', qualification: 'math-middle', priority: 'critical', startsAt: iso('09-14T08:00'), endsAt: iso('09-18T17:00') });
  await svc.addDemand({ id: 'D2', school: 'S-RURAL-2', qualification: 'chinese-middle', startsAt: iso('09-14T08:00'), endsAt: iso('09-18T17:00') });
  await svc.addDemand({ id: 'D3', school: 'S-RURAL-2', qualification: 'math-middle', startsAt: iso('09-21T08:00'), endsAt: iso('09-25T17:00') });
  return { svc, dir };
}

async function confirmAllAndEffectuate(svc, planId) {
  await svc.submit(planId);
  for (const school of ['S-RURAL-1', 'S-RURAL-2']) await svc.confirm(planId, school);
  await svc.effectuate(planId);
}

test('草案：按资质、路程与负载排程，含路程的占用窗口跨午夜正确', async () => {
  const { svc, dir } = await freshService();
  const { plan } = await svc.createDraft({});
  assert.equal(plan.state, 'draft');
  assert.equal(plan.assignments.length, 3);
  const d1 = plan.assignments.find((a) => a.demandId === 'D1');
  assert.equal(d1.teacherId, 'T-301'); // 路程 45 分钟，数学教师中最短
  assert.equal(d1.travelMinutesEachWay, 45);
  // 出发 = 08:00 - 45 分钟 = 前一日历日... 同一日 07:15；这里验证按毫秒计算而非时钟小时
  assert.equal(d1.busyStart, '2026-09-13T23:15:00.000Z'); // 07:15+08
  assert.equal(d1.busyEnd, '2026-09-18T09:45:00.000Z');   // 17:45+08
  const d3 = plan.assignments.find((a) => a.demandId === 'D3');
  assert.equal(d3.teacherId, 'T-302'); // T-301 已有 D1 负载，T-302 负载更低
  assert.ok(d1.rationale.alternativesConsidered >= 1);
  await rm(dir, { recursive: true, force: true });
});

test('跨午夜的出发窗口与法定休息间隔：间隔不足必须拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rotation-'));
  const svc = await new SchedulerService(join(dir, 'db.json')).init();
  await svc.setPolicy({ minRestMinutes: 660, minContinuousMinutes: 1440, travelBufferMinutes: 0 });
  await svc.registerSchool({ id: 'S-HOME' });
  await svc.registerSchool({ id: 'S-RURAL-1' });
  await svc.setTravel('S-HOME', 'S-RURAL-1', 45);
  await svc.registerTeacher({ id: 'T-301', homeSchool: 'S-HOME', qualifications: ['math-middle'] });
  // 第一段 14 日 08:00 至 15 日 08:00（含返程 08:45 结束占用）
  await svc.addDemand({ id: 'Da', school: 'S-RURAL-1', qualification: 'math-middle', startsAt: iso('09-14T08:00'), endsAt: iso('09-15T08:00') });
  // 第二段 15 日 12:00 开始（11:15 就需出发），距上一段占用结束仅 150 分钟 < 660
  await svc.addDemand({ id: 'Db', school: 'S-RURAL-1', qualification: 'math-middle', startsAt: iso('09-15T12:00'), endsAt: iso('09-16T12:00') });
  const { plan } = await svc.createDraft({});
  const placed = plan.assignments.map((a) => a.demandId);
  assert.deepEqual(placed, ['Da']);
  assert.equal(plan.unmet[0].demandId, 'Db');
  assert.ok(plan.unmet[0].reasons.includes('rest-gap'));
  const reject = plan.unmet[0].rejected.find((r) => r.teacherId === 'T-301');
  assert.equal(reject.reason, 'rest-gap');
  assert.equal(reject.detail.requiredMinutes, 660);
  await rm(dir, { recursive: true, force: true });
});

test('不可达校区与低于最低连续服务周期进入未满足清单并附原因', async () => {
  const { svc, dir } = await freshService();
  await svc.registerSchool({ id: 'S-ISLAND' });
  await svc.setTravel('S-HOME', 'S-ISLAND', null); // 不可达
  await svc.addDemand({ id: 'D4', school: 'S-ISLAND', qualification: 'math-middle', startsAt: iso('09-28T08:00'), endsAt: iso('10-02T17:00') });
  await svc.addDemand({ id: 'D5', school: 'S-RURAL-1', qualification: 'math-middle', startsAt: iso('09-19T08:00'), endsAt: iso('09-19T12:00') }); // 仅 4 小时
  const { plan } = await svc.createDraft({ demandIds: ['D4', 'D5'] });
  assert.equal(plan.assignments.length, 0);
  const byId = Object.fromEntries(plan.unmet.map((u) => [u.demandId, u]));
  assert.ok(byId.D4.reasons.includes('travel-unreachable'));
  assert.ok(byId.D5.reasons.includes('service-window-shorter-than-minimum'));
  await rm(dir, { recursive: true, force: true });
});

test('校方确认与生效：批量确认失败整笔不动；未全部确认不得生效', async () => {
  const { svc, dir } = await freshService();
  const { plan } = await svc.createDraft({});
  const pid = plan.id;
  await svc.submit(pid);
  // RURAL-1 试图确认 RURAL-2 的分配 → 拒绝且无副作用
  const foreign = plan.assignments.find((a) => a.school === 'S-RURAL-2').id;
  await assert.rejects(svc.confirm(pid, 'S-RURAL-1', [foreign]), /只能确认本校/);
  let snapshot = svc.getPlan(pid);
  assert.ok(snapshot.assignments.every((a) => a.state === 'proposed'));
  assert.equal(snapshot.confirmations['S-RURAL-1'], undefined);
  // 只确认一所学校就生效 → 整笔中止
  await svc.confirm(pid, 'S-RURAL-1');
  await assert.rejects(svc.effectuate(pid), /未经校方确认/);
  assert.equal(svc.getPlan(pid).state, 'awaiting-school');
  // 补齐后生效成功
  await svc.confirm(pid, 'S-RURAL-2');
  await svc.effectuate(pid);
  assert.equal(svc.getPlan(pid).state, 'effective');
  assert.ok(svc.getPlan(pid).effectiveAt);
  await rm(dir, { recursive: true, force: true });
});

test('同一教师不被重复占用：生效计划占用教师，重叠需求改派他人或进入未满足清单', async () => {
  const { svc, dir } = await freshService();
  const { plan } = await svc.createDraft({});
  await confirmAllAndEffectuate(svc, plan.id);
  // 与 D1 同窗的新数学需求；T-301 被占，T-302 空 → 选 T-302
  await svc.addDemand({ id: 'D6', school: 'S-RURAL-1', qualification: 'math-middle', startsAt: iso('09-15T08:00'), endsAt: iso('09-17T17:00') });
  const r2 = await svc.createDraft({ demandIds: ['D6'] });
  assert.equal(r2.plan.assignments[0].teacherId, 'T-302');
  assert.ok(r2.plan.assignments[0].rationale.rejected.some((r) => r.teacherId === 'T-301' && r.reason === 'double-booked'));
  // 让 T-302 也不可用 → 新需求无人可派
  await svc.registerTeacher({ id: 'T-302', homeSchool: 'S-HOME', qualifications: ['math-middle'], unavailable: [{ startsAt: iso('09-14T00:00'), endsAt: iso('09-30T00:00'), reason: '培训' }] });
  const r3 = await svc.createDraft({ demandIds: ['D6'] });
  assert.equal(r3.plan.assignments.length, 0);
  assert.deepEqual(r3.plan.unmet[0].reasons.sort(), ['double-booked', 'on-leave', 'qualification-mismatch'].sort());
  await rm(dir, { recursive: true, force: true });
});

test('请假中断→替补接续：已确认安排不漂移，仅中断段重排，修订版生效后旧版归档', async () => {
  const { svc, dir } = await freshService();
  const { plan } = await svc.createDraft({});
  await confirmAllAndEffectuate(svc, plan.id);
  const d1 = plan.assignments.find((a) => a.demandId === 'D1');
  const d2 = plan.assignments.find((a) => a.demandId === 'D2');
  const d3 = plan.assignments.find((a) => a.demandId === 'D3');

  await svc.interrupt({ planId: plan.id, assignmentId: d1.id, kind: 'leave', startsAt: iso('09-16T08:00'), endsAt: iso('09-16T18:00'), reason: '临时请假' });
  assert.equal(svc.getPlan(plan.id).assignments.find((a) => a.id === d1.id).state, 'interrupted');

  const repaired = await svc.repair(plan.id);
  const rev = repaired.plan;
  assert.equal(rev.revisionOfId, plan.id);
  assert.equal(rev.revisionNo, 2);
  // D2、D3 原样携带：教师、起止、占用窗口全部不变，且保持 confirmed
  const carriedD2 = rev.assignments.find((a) => a.carriedFromAssignmentId === d2.id);
  assert.equal(carriedD2.teacherId, 'T-303');
  assert.equal(carriedD2.startsAt, d2.startsAt);
  assert.equal(carriedD2.busyStart, d2.busyStart);
  assert.equal(carriedD2.state, 'confirmed');
  const carriedD3 = rev.assignments.find((a) => a.carriedFromAssignmentId === d3.id);
  assert.equal(carriedD3.teacherId, 'T-302');
  // D1 拆成两段：T-302 仅覆盖请假窗口（09-16 08:00–18:00），T-301 假期后接续到需求结束
  const sub = rev.assignments.find((a) => a.demandId === 'D1' && !a.carriedConfirmation);
  assert.equal(sub.teacherId, 'T-302');
  assert.equal(Date.parse(sub.startsAt), Date.parse(iso('09-16T08:00')));
  assert.equal(Date.parse(sub.endsAt), Date.parse(iso('09-16T18:00')));
  assert.equal(sub.rationale.handoff.kind, 'leave-cover');
  assert.equal(sub.rationale.handoff.fromTeacher, 'T-301');
  assert.equal(sub.supersedesAssignmentId, d1.id);
  assert.ok(sub.rationale.rejected.some((r) => r.teacherId === 'T-301' && r.reason === 'on-leave'));
  const resumed = rev.assignments.find((a) => a.resumedAfter);
  assert.equal(resumed.teacherId, 'T-301');
  assert.equal(Date.parse(resumed.startsAt), Date.parse(iso('09-16T18:00')));
  assert.equal(resumed.endsAt, d1.endsAt);
  assert.equal(resumed.state, 'confirmed');
  assert.equal(resumed.resumedAfter.coverAssignmentId, sub.id);
  // 仅受影响学校（RURAL-1）确认替补；其他学校的确认已随携带项沿用，无需重签
  const pending = rev.assignments.filter((a) => a.state === 'proposed');
  assert.deepEqual(pending.map((a) => a.school), ['S-RURAL-1']);
  await svc.confirm(rev.id, 'S-RURAL-1');
  await svc.effectuate(rev.id);
  assert.equal(svc.getPlan(rev.id).state, 'effective');
  assert.equal(svc.getPlan(plan.id).state, 'superseded');

  // 影响面查询：变化的只有 T-301（中断）与 T-302（替补 D1）；D2/D3 列为未变化
  const impact = svc.impact({ planId: rev.id });
  assert.deepEqual(impact.impactedTeachers.sort(), ['T-301', 'T-302']);
  const unchangedIds = impact.unchangedAssignments.map((a) => a.carriedFromAssignmentId ?? a.assignmentId);
  assert.ok(unchangedIds.includes(d2.id) && unchangedIds.includes(d3.id));
  const changes = impact.changedAssignments.map((a) => a.change);
  assert.ok(changes.includes('interrupted') && changes.includes('substitute'));
  await rm(dir, { recursive: true, force: true });
});

test('无人可替补时修订版保留未满足清单，已确认部分仍不漂移', async () => {
  const { svc, dir } = await freshService();
  const { plan } = await svc.createDraft({});
  await confirmAllAndEffectuate(svc, plan.id);
  const d1 = plan.assignments.find((a) => a.demandId === 'D1');
  await svc.interrupt({ planId: plan.id, assignmentId: d1.id, startsAt: iso('09-16T08:00'), endsAt: iso('09-17T18:00') });
  // T-302 在接续窗口也请假
  await svc.registerTeacher({ id: 'T-302', homeSchool: 'S-HOME', qualifications: ['math-middle'], unavailable: [{ startsAt: iso('09-16T00:00'), endsAt: iso('09-18T00:00'), reason: '病假' }] });
  const { plan: rev } = await svc.repair(plan.id);
  assert.equal(rev.assignments.filter((a) => !a.carriedConfirmation).length, 0);
  assert.equal(rev.unmet.length, 1);
  assert.equal(rev.unmet[0].demandId, 'D1');
  assert.ok(rev.unmet[0].reasons.includes('on-leave'));
  const unmet = svc.unmet();
  assert.ok(unmet.items.some((u) => u.demandId === 'D1' && u.planId === rev.id));
  await rm(dir, { recursive: true, force: true });
});

test('撤销与恢复：计划/分配均可撤销，恢复时复检冲突，冲突则拒绝', async () => {
  const { svc, dir } = await freshService();
  const { plan } = await svc.createDraft({});
  await svc.cancelPlan(plan.id, '协调员撤销');
  assert.equal(svc.getPlan(plan.id).state, 'cancelled');
  await svc.restorePlan(plan.id);
  assert.equal(svc.getPlan(plan.id).state, 'draft');
  // 撤销单条分配后进入未满足清单；恢复后移除
  const d1 = plan.assignments.find((a) => a.demandId === 'D1');
  await svc.cancelAssignment(d1.id, '教师临时变动');
  assert.equal(svc.getPlan(plan.id).assignments.find((a) => a.id === d1.id).state, 'cancelled');
  assert.ok(svc.unmet().items.some((u) => u.detail?.assignmentId === d1.id));
  await svc.restoreAssignment(d1.id);
  assert.equal(svc.getPlan(plan.id).assignments.find((a) => a.id === d1.id).state, 'proposed');
  assert.ok(!svc.unmet().items.some((u) => u.detail?.assignmentId === d1.id));
  await rm(dir, { recursive: true, force: true });
});

test('学校视图只返回本校安排，草案不对校方泄露', async () => {
  const { svc, dir } = await freshService();
  const { plan } = await svc.createDraft({});
  // 草案阶段：校方视图为空
  assert.equal(svc.schoolView('S-RURAL-1').arrangements.length, 0);
  await confirmAllAndEffectuate(svc, plan.id);
  const view = svc.schoolView('S-RURAL-1');
  assert.equal(view.arrangements.length, 1);
  assert.equal(view.arrangements[0].school, 'S-RURAL-1');
  assert.ok(!JSON.stringify(view).includes('T-303')); // 不含他校教师信息
  assert.ok(!JSON.stringify(view).includes('S-RURAL-2'));
  await rm(dir, { recursive: true, force: true });
});

test('重启服务后历史版本与事件仍可复盘', async () => {
  const { svc, dir } = await freshService();
  const { plan } = await svc.createDraft({});
  await confirmAllAndEffectuate(svc, plan.id);
  const d1 = plan.assignments.find((a) => a.demandId === 'D1');
  await svc.interrupt({ planId: plan.id, assignmentId: d1.id, startsAt: iso('09-16T08:00'), endsAt: iso('09-16T18:00') });
  const { plan: rev } = await svc.repair(plan.id);
  await svc.confirm(rev.id, 'S-RURAL-1');
  await svc.effectuate(rev.id);

  // 用同一数据库路径重新初始化（模拟进程重启）
  const restarted = await new SchedulerService(join(dir, 'db.json')).init();
  const chain = restarted.versionChain(plan.id);
  assert.deepEqual(chain.map((v) => v.revisionNo), [1, 2]);
  const snap = restarted.historicalSnapshot(plan.id);
  assert.equal(snap.plan.state, 'superseded');
  assert.ok(snap.events.some((e) => e.type === 'assignment-interrupted'));
  assert.ok(restoredUnmetOk(restarted));
  await rm(dir, { recursive: true, force: true });
});
function restoredUnmetOk(svc) { return Array.isArray(svc.unmet().items); }

test('为何选择某位替补：rationale 给出排序依据与全部落选原因', async () => {
  const { svc, dir } = await freshService();
  const { plan } = await svc.createDraft({});
  const d1 = plan.assignments.find((a) => a.demandId === 'D1');
  const r = svc.rationale(d1.id);
  assert.equal(r.assignment.teacherId, 'T-301');
  assert.match(r.rationale.chosenBecause[0], /45/);
  assert.ok(r.rationale.alsoQualifiedButRankedLower.includes('T-302'));
  assert.ok(r.rationale.rejected.some((x) => x.reason === 'qualification-mismatch'));
  await rm(dir, { recursive: true, force: true });
});

test('路程缓冲计入占用窗口', async () => {
  const { svc, dir } = await freshService();
  await svc.setPolicy({ travelBufferMinutes: 15 });
  const { plan } = await svc.createDraft({ demandIds: ['D1'] });
  const d1 = plan.assignments[0];
  // 08:00+08 - 45 路程 - 15 缓冲 = 07:00+08 = 前一日 23:00Z
  assert.equal(d1.busyStart, '2026-09-13T23:00:00.000Z');
  assert.equal(d1.busyEnd, '2026-09-18T10:00:00.000Z');
  await rm(dir, { recursive: true, force: true });
});

test('HTTP：校方密钥隔离，协调员可走完整流程', async () => {
  const { dir } = await freshService();
  const server = await createApp({
    dbPath: join(dir, 'http.json'),
    coordinatorKey: 'coord-secret',
    schoolKeys: { 'S-RURAL-1': 'k1', 'S-RURAL-2': 'k2' },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const req = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  // 无密钥访问校方接口 → 403；持 RURAL-1 密钥查 RURAL-2 → 403
  assert.equal((await req('GET', '/schools/S-RURAL-1/arrangements')).status, 403);
  assert.equal((await req('GET', '/schools/S-RURAL-2/arrangements', null, { 'x-school-key': 'k1' })).status, 403);
  // 协调员录入基础数据
  for (const id of ['S-HOME', 'S-RURAL-1', 'S-RURAL-2']) await req('POST', '/admin/schools', { id }, { 'x-coordinator-key': 'coord-secret' });
  const c = { 'x-coordinator-key': 'coord-secret' };
  await req('POST', '/admin/travel', { schoolA: 'S-HOME', schoolB: 'S-RURAL-1', minutes: 45 }, c);
  await req('POST', '/admin/teachers', { id: 'T-301', homeSchool: 'S-HOME', qualifications: ['math-middle'] }, c);
  await req('POST', '/admin/demands', { id: 'D1', school: 'S-RURAL-1', qualification: 'math-middle', startsAt: iso('09-14T08:00'), endsAt: iso('09-18T17:00') }, c);
  let r = await req('POST', '/plans', {}, c);
  const pid = r.json.plan.id;
  assert.equal((await req('POST', `/plans/${pid}/submit`, {}, c)).status, 200);
  // 校方用自己的密钥确认本校
  r = await req('POST', `/plans/${pid}/confirmations`, {}, { 'x-school-key': 'k1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.confirmed.length, 1);
  assert.equal((await req('POST', `/plans/${pid}/effectuate`, {}, c)).status, 200);
  // 校方只看到本校一条安排
  r = await req('GET', '/schools/S-RURAL-1/arrangements', null, { 'x-school-key': 'k1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.arrangements.length, 1);
  assert.equal(r.json.arrangements[0].school, 'S-RURAL-1');
  // 未满足需求接口对校方密钥不可见
  assert.equal((await req('GET', '/unmet', null, { 'x-school-key': 'k1' })).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
