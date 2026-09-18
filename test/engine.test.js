import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { EventStore } from '../src/store.js';
import { RotationEngine } from '../src/engine.js';

const NOW = '2026-09-01T08:00:00+08:00';

function context(over = {}) {
  return {
    teachers: [
      { id: 'T-01', name: '张老师', qualifications: ['math-middle'], homeSchool: 'S-CENTRAL' },
      { id: 'T-02', name: '李老师', qualifications: ['math-middle'], homeSchool: 'S-CENTRAL' },
      { id: 'T-03', name: '王老师', qualifications: ['math-middle', 'phys-middle'], homeSchool: 'S-CENTRAL' },
    ],
    schools: [
      { id: 'S-CENTRAL', name: '中心校区' },
      { id: 'S-RURAL-1', name: '东乡' },
      { id: 'S-RURAL-2', name: '西乡' },
    ],
    demands: [
      { id: 'D-1', school: 'S-RURAL-1', qualification: 'math-middle',
        startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-18T17:00:00+08:00', priority: 'critical' },
      { id: 'D-2', school: 'S-RURAL-2', qualification: 'math-middle',
        startsAt: '2026-09-21T08:00:00+08:00', endsAt: '2026-09-25T17:00:00+08:00' },
    ],
    travelMatrix: {
      'S-CENTRAL': { 'S-RURAL-1': 45, 'S-RURAL-2': 70 },
      'S-RURAL-1': { 'S-CENTRAL': 45, 'S-RURAL-2': 30 },
      'S-RURAL-2': { 'S-CENTRAL': 70, 'S-RURAL-1': 30 },
    },
    minContiguousDays: 3,
    minRestMinutes: 600,
    travelBufferMinutes: 20,
    ...over,
  };
}

let counter = 0;
function boot() {
  const file = `/tmp/rotation-test-${process.pid}-${++counter}.jsonl`;
  rmSync(file, { force: true });
  const store = new EventStore(file, { now: () => NOW });
  return { file, engine: new RotationEngine(store, { now: () => NOW }), store };
}

function activatedPlan(engine, over = {}) {
  const ctx = context(over);
  const plan = engine.createPlan(ctx, { planId: 'P1' });
  engine.confirmSchools('P1', ['S-RURAL-1', 'S-RURAL-2']);
  engine.activate('P1');
  return { ctx, plan };
}

// ---------- 草案 / 确认 / 生效 ----------

test('草案给出可执行轮岗计划，两条需求由不同教师承担', () => {
  const { engine } = boot();
  const plan = engine.createPlan(context(), { planId: 'P1' });
  assert.equal(plan.state, 'draft');
  assert.equal(plan.segmentCount, 2);
  const teachers = plan.segments.map((s) => s.teacherId);
  assert.equal(new Set(teachers).size, 2);
});

test('未满足需求进入 unmet 清单而非被静默丢弃', () => {
  const { engine } = boot();
  const plan = engine.createPlan(context({
    teachers: [{ id: 'T-01', qualifications: ['math-middle'], homeSchool: 'S-CENTRAL' }],
    demands: [
      { id: 'D-1', school: 'S-RURAL-1', qualification: 'math-middle',
        startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-18T17:00:00+08:00' },
      { id: 'D-2', school: 'S-RURAL-2', qualification: 'math-middle',
        startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-18T17:00:00+08:00' },
    ],
  }), { planId: 'P1' });
  assert.equal(plan.segmentCount, 1);
  assert.equal(plan.unmet.length, 1);
  assert.equal(plan.unmet[0].demandId, 'D-2');
});

test('必须所有有安排的学校确认后才能生效', () => {
  const { engine } = boot();
  engine.createPlan(context(), { planId: 'P1' });
  engine.confirmSchools('P1', ['S-RURAL-1']);
  assert.throws(() => engine.activate('P1'), /尚未有学校未确认|S-RURAL-2/);
  engine.confirmSchools('P1', ['S-RURAL-2']);
  assert.equal(engine.activate('P1').state, 'effective');
});

test('重复确认同一学校被拒绝', () => {
  const { engine } = boot();
  engine.createPlan(context(), { planId: 'P1' });
  engine.confirmSchools('P1', ['S-RURAL-1']);
  assert.throws(() => engine.confirmSchools('P1', ['S-RURAL-1']), /已确认/);
});

// ---------- 原子性：批量确认失败不留半套 ----------

test('批量确认遇冲突时整批失败，计划与日志均不发生变化', () => {
  const { engine, file } = boot();
  engine.createPlan(context(), { planId: 'P1' });
  const linesBefore = requireLines(file);
  // 人为制造冲突：直接在状态里把两条片段改成同一教师且时间重叠，
  // 确认时整表校验必须失败。
  const segs = engine.planView('P1').segments;
  engine.state.segments[segs[1].id].teacherId = segs[0].teacherId;
  engine.state.segments[segs[1].id].startsAt = segs[0].startsAt;
  engine.state.segments[segs[1].id].endsAt = segs[0].endsAt;
  assert.throws(() => engine.confirmSchools('P1', ['S-RURAL-1', 'S-RURAL-2']), /整批退回/);
  assert.equal(engine.planView('P1').state, 'draft');
  assert.equal(requireLines(file), linesBefore, '失败的提交不得写入日志');
});

// ---------- 请假中断、增量替补、无漂移 ----------

test('教师请假：只重排受影响需求，替补需校方确认，其他安排不漂移', () => {
  const { engine } = boot();
  activatedPlan(engine);
  const before = engine.planView('P1');
  const d1 = before.segments.find((s) => s.demandId === 'D-1');
  const d2Before = before.segments.find((s) => s.demandId === 'D-2');
  const originalTeacher = d1.teacherId;

  const { interruptionIds } = engine.interruptTeacherLeave('P1', originalTeacher,
    { at: '2026-09-16T10:00:00+08:00' });
  assert.equal(interruptionIds.length, 1);

  const after = engine.planView('P1');
  const interrupted = after.segments.find((s) => s.id === d1.id);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.clipEndsAt, '2026-09-16T10:00:00+08:00');

  const rep = after.segments.find((s) => s.rootId === d1.rootId && s.seq === 1);
  assert.ok(rep, '必须生成接续片段');
  assert.equal(rep.state, 'proposed');
  assert.notEqual(rep.teacherId, originalTeacher);
  assert.equal(rep.startsAt, '2026-09-16T10:00:00+08:00');
  assert.equal(rep.endsAt, d1.endsAt);

  // 无漂移：D-2 的教师、时间完全没变
  const d2After = after.segments.find((s) => s.demandId === 'D-2');
  assert.equal(d2After.teacherId, d2Before.teacherId);
  assert.deepEqual([d2After.startsAt, d2After.endsAt], [d2Before.startsAt, d2Before.endsAt]);

  // 替补需校方确认后才生效
  assert.throws(() => engine.confirmReplacement('P1', rep.id, 'S-RURAL-2'), /不属于学校/);
  engine.confirmReplacement('P1', rep.id, 'S-RURAL-1');
  assert.equal(engine.state.segments[rep.id].state, 'confirmed');
});

test('出发前临时请假：片段尚未开始，整段让出并寻找替补', () => {
  const { engine } = boot();
  activatedPlan(engine);
  const d1 = engine.planView('P1').segments.find((s) => s.demandId === 'D-1');
  const { interruptionIds } = engine.interruptTeacherLeave('P1', d1.teacherId,
    { at: '2026-09-13T20:00:00+08:00' }); // 出发前一晚
  const after = engine.planView('P1');
  const interrupted = after.segments.find((s) => s.id === d1.id);
  assert.equal(interrupted.clipEndsAt, d1.startsAt, '剪断点=开始点，履行部分为零');
  const rep = after.segments.find((s) => s.rootId === d1.rootId && s.seq === 1);
  assert.equal(rep.startsAt, d1.startsAt);
  assert.equal(rep.endsAt, d1.endsAt);
});

test('连续改派：一次请假覆盖同一教师多个片段时，同一名替补不会被重复占用', () => {
  const { engine } = boot();
  // 让 T-01 承担两条时间相邻但不重叠的需求
  const plan = engine.createPlan(context({
    minContiguousDays: 1,
    demands: [
      { id: 'D-1', school: 'S-RURAL-1', qualification: 'math-middle',
        startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-15T17:00:00+08:00', priority: 'critical' },
      { id: 'D-2', school: 'S-RURAL-2', qualification: 'math-middle',
        startsAt: '2026-09-21T08:00:00+08:00', endsAt: '2026-09-22T17:00:00+08:00' },
    ],
  }), { planId: 'P1' });
  engine.confirmSchools('P1', ['S-RURAL-1', 'S-RURAL-2']);
  engine.activate('P1');
  const d1 = plan.segments.find((s) => s.demandId === 'D-1');
  const d2 = plan.segments.find((s) => s.demandId === 'D-2');
  // 排程上两人各担一条；模拟实际中 D-2 也由 T-01 承担的情形（如另一人临期更换），
  // 随后 T-01 无固定期限请假：两条安排都要改派。
  engine.state.segments[d2.id].teacherId = d1.teacherId;
  const { interruptionIds } = engine.interruptTeacherLeave('P1', d1.teacherId,
    { at: '2026-09-14T10:00:00+08:00' }); // 无 endsAt => 无限期
  assert.equal(interruptionIds.length, 2, '两条安排各产生一次中断');
  const reps = engine.planView('P1').segments.filter((s) => s.seq === 1);
  assert.equal(reps.length, 2);
  assert.notEqual(reps[0].teacherId, reps[1].teacherId, '两条接续不能是同一名教师');
  assert.equal(new Set(reps.map((r) => r.teacherId)).size, 2);
});

test('替补因跨午夜休息间隔不足无法接续时，缺口原因给出 BUFFER_OR_REST 明细', () => {
  const { engine } = boot();
  // 两名教师：T-02 刚在另一所学校结束晚课，跨午夜也凑不够 路程+缓冲+休息。
  const ctx = context({
    teachers: [
      { id: 'T-01', qualifications: ['math-middle'], homeSchool: 'S-CENTRAL' },
      { id: 'T-02', qualifications: ['math-middle'], homeSchool: 'S-CENTRAL' },
    ],
    minContiguousDays: 1,
    demands: [
      { id: 'D-1', school: 'S-RURAL-1', qualification: 'math-middle',
        startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-16T12:00:00+08:00', priority: 'critical' },
      { id: 'D-2', school: 'S-RURAL-2', qualification: 'math-middle',
        // T-02 在此驻校到 23:00；T-01 次日 01:00 请假时，T-02 无法满足休息
        startsAt: '2026-09-15T18:00:00+08:00', endsAt: '2026-09-15T23:00:00+08:00' },
    ],
  });
  engine.createPlan(ctx, { planId: 'P1' });
  engine.confirmSchools('P1', ['S-RURAL-1', 'S-RURAL-2']);
  engine.activate('P1');
  const d1 = engine.planView('P1').segments.find((s) => s.demandId === 'D-1');
  // 次日 01:00（跨午夜）请假，剩余到 12:00 的时段需要替补
  engine.interruptTeacherLeave('P1', d1.teacherId, { at: '2026-09-16T01:00:00+08:00' });
  const gaps = engine.listGaps('P1');
  assert.equal(gaps.length, 1);
  const blocker = gaps[0].detail.blockers[0];
  assert.equal(blocker.reason, 'BUFFER_OR_REST');
  assert.equal(blocker.detail.requiredMinutes, 30 + 20 + 600);
  assert.equal(blocker.detail.freeMinutes, 120);
});

test('无人可补时记录缺口，协调员可查询还有哪些需求无法满足', () => {  const { engine } = boot();
  // 两名教师、两条同周重叠需求，每人各担一条；其中一人请假时另一人无法分身 => 缺口。
  activatedPlan(engine, {
    teachers: [
      { id: 'T-01', qualifications: ['math-middle'], homeSchool: 'S-CENTRAL' },
      { id: 'T-02', qualifications: ['math-middle'], homeSchool: 'S-CENTRAL' },
    ],
    demands: [
      { id: 'D-1', school: 'S-RURAL-1', qualification: 'math-middle',
        startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-18T17:00:00+08:00', priority: 'critical' },
      { id: 'D-2', school: 'S-RURAL-2', qualification: 'math-middle',
        startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-18T17:00:00+08:00' },
    ],
  });
  const segs = engine.planView('P1').segments;
  const d1 = segs.find((s) => s.demandId === 'D-1');
  engine.interruptTeacherLeave('P1', d1.teacherId, { at: '2026-09-16T10:00:00+08:00' });
  const gaps = engine.listGaps('P1');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].demandId, 'D-1');
  assert.equal(gaps[0].reason, 'ALL_CANDIDATES_BLOCKED');
});

// ---------- 解释性 ----------

test('explainAdjustment 回答影响了谁、为何选这位替补', () => {
  const { engine } = boot();
  activatedPlan(engine);
  const d1 = engine.planView('P1').segments.find((s) => s.demandId === 'D-1');
  const { interruptionIds } = engine.interruptTeacherLeave('P1', d1.teacherId,
    { at: '2026-09-16T10:00:00+08:00' }, { actor: '协调员甲' });
  const ex = engine.explainAdjustment('P1', interruptionIds[0]);
  assert.equal(ex.actor, '协调员甲');
  assert.ok(ex.affectedTeacherIds.includes(d1.teacherId));
  assert.deepEqual(ex.affectedSchoolIds, ['S-RURAL-1']);
  const rep = ex.segments[0].replacement;
  assert.ok(rep);
  const chosen = rep.rankedCandidates.find((c) => c.chosen);
  assert.equal(chosen.teacherId, rep.teacherId);
  assert.ok(rep.rankedCandidates.every((c) => c.rank >= 1));
});

test('commitImpact 给出某次提交的精确变更范围', () => {
  const { engine } = boot();
  activatedPlan(engine);
  const d1 = engine.planView('P1').segments.find((s) => s.demandId === 'D-1');
  const { interruptionIds } = engine.interruptTeacherLeave('P1', d1.teacherId,
    { at: '2026-09-16T10:00:00+08:00' });
  const leaveCommit = engine.history('P1').at(-1).commitId;
  const impact = engine.commitImpact(leaveCommit);
  const ids = impact.changed.map((c) => c.segmentId);
  assert.ok(ids.includes(d1.id), '原片段状态改变');
  // 变更仅限被中断的链，不涉及 D-2
  const d2 = engine.planView('P1').segments.find((s) => s.demandId === 'D-2');
  assert.ok(!ids.includes(d2.id));
});

// ---------- 撤销恢复 ----------

test('替补确认前撤销中断：作废替补候选、恢复原安排、关闭缺口', () => {
  const { engine } = boot();
  activatedPlan(engine);
  const d1 = engine.planView('P1').segments.find((s) => s.demandId === 'D-1');
  const { interruptionIds } = engine.interruptTeacherLeave('P1', d1.teacherId,
    { at: '2026-09-16T10:00:00+08:00' });
  const repId = engine.planView('P1').segments.find((s) => s.rootId === d1.rootId && s.seq === 1).id;
  engine.revokeInterruption('P1', interruptionIds[0]);
  assert.equal(engine.state.segments[d1.id].state, 'confirmed');
  assert.equal(engine.state.segments[d1.id].clipEndsAt, null);
  assert.equal(engine.state.segments[repId].state, 'revoked');
  assert.equal(engine.state.interruptions[interruptionIds[0]].status, 'closed');
});

test('替补已确认后不能通过撤销让安排漂移，须走新的中断', () => {
  const { engine } = boot();
  activatedPlan(engine);
  const d1 = engine.planView('P1').segments.find((s) => s.demandId === 'D-1');
  const { interruptionIds } = engine.interruptTeacherLeave('P1', d1.teacherId,
    { at: '2026-09-16T10:00:00+08:00' });
  const rep = engine.planView('P1').segments.find((s) => s.rootId === d1.rootId && s.seq === 1);
  engine.confirmReplacement('P1', rep.id, 'S-RURAL-1');
  assert.throws(() => engine.revokeInterruption('P1', interruptionIds[0]), /已经确认/);
});

test('连续改派必须从最近一次中断往回撤', () => {
  const { engine } = boot();
  activatedPlan(engine);
  const d1 = engine.planView('P1').segments.find((s) => s.demandId === 'D-1');
  const first = engine.interruptTeacherLeave('P1', d1.teacherId,
    { at: '2026-09-15T10:00:00+08:00' });
  const rep1 = engine.planView('P1').segments.find((s) => s.rootId === d1.rootId && s.seq === 1);
  // 替补在确认前又请假（连续改派）
  const second = engine.interruptTeacherLeave('P1', rep1.teacherId,
    { at: '2026-09-16T10:00:00+08:00' });
  // 不能先撤销更早的第一次中断
  assert.throws(() => engine.revokeInterruption('P1', first.interruptionIds[0]), /更近的中断/);
  // 先撤第二次，再撤第一次，恢复到最初安排
  engine.revokeInterruption('P1', second.interruptionIds[0]);
  engine.revokeInterruption('P1', first.interruptionIds[0]);
  assert.equal(engine.state.segments[d1.id].state, 'confirmed');
  assert.equal(engine.state.segments[d1.id].teacherId, d1.teacherId);
});

test('学校停课中断本校全部片段，撤销后恢复', () => {
  const { engine } = boot();
  activatedPlan(engine);
  const d1 = engine.planView('P1').segments.find((s) => s.demandId === 'D-1');
  const { interruptionId } = engine.interruptSchoolClosure('P1', 'S-RURAL-1',
    { at: '2026-09-16T10:00:00+08:00', endsAt: '2026-09-17T12:00:00+08:00' });
  assert.equal(engine.state.segments[d1.id].state, 'interrupted');
  assert.equal(engine.listGaps('P1')[0].reason, 'SCHOOL_CLOSED');
  engine.revokeInterruption('P1', interruptionId);
  assert.equal(engine.state.segments[d1.id].state, 'confirmed');
  assert.equal(engine.listGaps('P1').length, 0);
});

// ---------- 权限：学校只看本校 ----------

test('学校查询只返回本校安排', () => {
  const { engine } = boot();
  activatedPlan(engine);
  const view = engine.schoolView('S-RURAL-1');
  assert.equal(view.arrangements.length, 1);
  assert.equal(view.arrangements[0].schoolId, 'S-RURAL-1');
  assert.equal(view.arrangements[0].demandId, 'D-1');
});

// ---------- 历史版本与重启复盘 ----------

test('服务重启后历史状态完整重建，任意提交点可复盘', () => {
  const { file, engine } = boot();
  activatedPlan(engine);
  const d1 = engine.planView('P1').segments.find((s) => s.demandId === 'D-1');
  const r = engine.interruptTeacherLeave('P1', d1.teacherId,
    { at: '2026-09-16T10:00:00+08:00' });
  engine.confirmReplacement('P1',
    engine.planView('P1').segments.find((s) => s.rootId === d1.rootId && s.seq === 1).id,
    'S-RURAL-1');
  const historyCount = engine.history('P1').length;
  const currentRep = engine.planView('P1').segments.find((s) => s.rootId === d1.rootId && s.seq === 1);

  // 用同一个日志文件重新构造引擎（模拟重启）
  const rebooted = new RotationEngine(new EventStore(file, { now: () => NOW }), { now: () => NOW });
  assert.equal(rebooted.listPlans()[0].state, 'effective');
  const view = rebooted.planView('P1');
  assert.equal(view.segments.length, engine.planView('P1').segments.length);
  assert.equal(rebooted.state.segments[currentRep.id].state, 'confirmed');
  assert.equal(rebooted.history('P1').length, historyCount);
  assert.ok(rebooted.explainAdjustment('P1', r.interruptionIds[0]).segments[0].replacement);

  // 复盘中断发生之前（生效提交点）的版本：只有原片段
  const versions = rebooted.history('P1');
  const activateCommit = versions.find((v) => v.eventTypes.includes('PlanActivated')).commitId;
  const old = rebooted.planAt('P1', activateCommit);
  assert.equal(old.segments.length, 2);
  assert.ok(old.segments.every((s) => s.state === 'confirmed'));
});

// ---------- 多期计划 ----------

test('新计划生效时旧计划变为 superseded', () => {
  const { engine } = boot();
  activatedPlan(engine);
  const plan2 = engine.createPlan(context({
    demands: [{ id: 'D-9', school: 'S-RURAL-1', qualification: 'math-middle',
      startsAt: '2026-10-12T08:00:00+08:00', endsAt: '2026-10-16T17:00:00+08:00' }],
  }), { planId: 'P2' });
  engine.confirmSchools('P2', ['S-RURAL-1']);
  engine.activate('P2');
  assert.equal(engine.listPlans().find((p) => p.id === 'P1').state, 'superseded');
  assert.equal(engine.listPlans().find((p) => p.id === 'P2').state, 'effective');
  // 历史仍可复盘
  assert.equal(engine.planAt('P1', 1).state, 'draft');
});

function requireLines(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
}
