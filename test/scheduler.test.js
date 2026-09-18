import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContext, travelMinutes } from '../src/model.js';
import { Timeline, buildAssignments, buildReplacement, validateAll } from '../src/scheduler.js';

const base = {
  teachers: [
    { id: 'T-A', qualifications: ['math'], homeSchool: 'S-HOME' },
    { id: 'T-B', qualifications: ['math', 'phys'], homeSchool: 'S-HOME' },
    { id: 'T-C', qualifications: ['phys'], homeSchool: 'S-HOME' },
  ],
  schools: [{ id: 'S-HOME' }, { id: 'S-R1' }, { id: 'S-R2' }],
  demands: [],
  travelMatrix: {
    'S-HOME': { 'S-R1': 40, 'S-R2': 90 },
    'S-R1': { 'S-HOME': 40, 'S-R2': 30 },
    'S-R2': { 'S-HOME': 90, 'S-R1': 30 },
  },
  minContiguousDays: 1,
  minRestMinutes: 600, // 10 小时法定休息
  travelBufferMinutes: 15,
};

function context(over = {}) {
  return validateContext({ ...base, ...over });
}

const demand = (id, over = {}) => ({
  id, school: 'S-R1', qualification: 'math',
  startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-15T17:00:00+08:00',
  ...over,
});

test('路程矩阵：同校为 0，缺省视为不可达', () => {
  const ctx = context();
  assert.equal(travelMinutes(ctx.travel, 'S-R1', 'S-R1'), 0);
  assert.equal(travelMinutes(ctx.travel, 'S-HOME', 'S-R1'), 40);
  assert.equal(travelMinutes(ctx.travel, 'S-R1', 'S-UNKNOWN'), null);
});

test('同一名教师不能被重复占用：重叠需求分给不同教师', () => {
  const ctx = context({ demands: [demand('D1'), demand('D2', { school: 'S-R2' })] });
  const { assignments, unmet } = buildAssignments(ctx);
  assert.equal(assignments.length, 2);
  assert.equal(unmet.length, 0);
  assert.notEqual(assignments[0].teacherId, assignments[1].teacherId);
  // 整表校验无违例
  assert.deepEqual(validateAll(assignments, ctx), []);
});

test('教师不足时重叠需求进入 unmet，原因可解释', () => {
  const one = context({
    teachers: [{ id: 'T-A', qualifications: ['math'], homeSchool: 'S-HOME' }],
    demands: [demand('D1'), demand('D2')],
  });
  const { assignments, unmet } = buildAssignments(one);
  assert.equal(assignments.length, 1);
  assert.equal(unmet.length, 1);
  assert.equal(unmet[0].reason, 'ALL_CANDIDATES_BLOCKED');
  assert.equal(unmet[0].detail.blockers[0].reason, 'TEACHING_CONFLICT');
});

test('无任何合格教师时给出 NO_QUALIFIED_TEACHER', () => {
  const ctx = context({ demands: [demand('D1', { qualification: 'chem' })] });
  const { unmet } = buildAssignments(ctx);
  assert.equal(unmet[0].reason, 'NO_QUALIFIED_TEACHER');
});

test('相邻两段之间必须容纳 路程+缓冲+休息，跨午夜同样成立', () => {
  const ctx = context();
  const teacher = ctx.teachers.get('T-A');
  const d = demand('D1');
  const tl = new Timeline();
  // 已有一段：周一 08:00-17:00 在 S-R1
  tl.add('T-A', { id: 'X', rootId: 'X', schoolId: 'S-R1', startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-14T17:00:00+08:00' });

  // 次日 02:00 在 S-R2 开课：即使跨午夜，间隙也只有 9 小时，小于 30+15+600=645 分钟 => 不可行
  const tooTight = { id: 'Y', rootId: 'Y', startsAt: '2026-09-15T02:00:00+08:00', endsAt: '2026-09-15T05:00:00+08:00' };
  const bad = tl.check(teacher, { ...d, school: 'S-R2' }, tooTight, ctx);
  assert.equal(bad.reason, 'BUFFER_OR_REST');
  assert.equal(bad.detail.requiredMinutes, 30 + 15 + 600);

  // 次日 08:00 开课：15 小时间隙，可行
  const ok = { id: 'Y', rootId: 'Y', startsAt: '2026-09-15T08:00:00+08:00', endsAt: '2026-09-15T12:00:00+08:00' };
  assert.equal(tl.check(teacher, { ...d, school: 'S-R2' }, ok, ctx), null);
});

test('路程矩阵缺失 => UNREACHABLE', () => {
  const ctx = context({
    teachers: [{ id: 'T-X', qualifications: ['math'], homeSchool: 'S-FAR' }],
    demands: [demand('D1')],
  });
  const { unmet } = buildAssignments(ctx);
  assert.equal(unmet[0].detail.blockers[0].reason, 'UNREACHABLE');
});

test('最低连续服务周期：短于周期的完整需求不能排入', () => {
  const ctx = context({
    minContiguousDays: 5,
    demands: [demand('D1')], // 只有 2 天
  });
  const { unmet } = buildAssignments(ctx);
  assert.equal(unmet[0].detail.blockers[0].reason, 'MIN_CONTIGUOUS');
  // 请假后的接续片段不受该约束
  const ctx1 = context({ demands: [demand('D1')] });
  const tl = new Timeline();
  const t = ctx1.teachers.get('T-A');
  const bad = tl.check(t, demand('D1'), { id: 'Z', rootId: 'Z', startsAt: '2026-09-15T10:00:00+08:00', endsAt: '2026-09-15T17:00:00+08:00' }, ctx1, { fromAt: '2026-09-15T10:00:00+08:00' });
  assert.equal(bad, null);
});

test('替补选择给出确定性排序与打分明细（少负重、近路程优先）', () => {
  const ctx = context({
    demands: [
      demand('D1', { school: 'S-R1', startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-16T17:00:00+08:00' }),
      demand('D2', { school: 'S-R2', startsAt: '2026-09-20T08:00:00+08:00', endsAt: '2026-09-21T17:00:00+08:00' }),
    ],
  });
  const built = buildAssignments(ctx);
  const d1 = built.assignments.find((a) => a.demandId === 'D1');
  const leaveTeacher = d1.teacherId;
  const open = {
    startsAt: '2026-09-15T10:00:00+08:00', endsAt: '2026-09-16T17:00:00+08:00',
    rootId: d1.rootId, nextSeq: 1, interruptionId: 'I1', previousSegmentId: d1.id,
  };
  const res = buildReplacement(ctx.demands.get('D1'), open, ctx, built.assignments, {
    excludeTeacherIds: [leaveTeacher], idGen: () => 'R1',
  });
  assert.ok(res.segment, '应有空闲的合格替补');
  assert.notEqual(res.segment.teacherId, leaveTeacher);
  assert.equal(res.candidates[0].rank, 1);
  assert.equal(res.candidates[0].teacherId, res.segment.teacherId);
  // 不合格教师（T-C 只有 phys）不在候选中
  assert.ok(!res.candidates.some((c) => c.teacherId === 'T-C'));
});

test('关键需求优先于普通需求获得教师', () => {
  const ctx = context({
    teachers: [{ id: 'T-A', qualifications: ['math'], homeSchool: 'S-HOME' }],
    demands: [
      demand('DN', { priority: 'normal', startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-16T17:00:00+08:00' }),
      demand('DC', { priority: 'critical', school: 'S-R2', startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-16T17:00:00+08:00' }),
    ],
  });
  const { assignments, unmet } = buildAssignments(ctx);
  assert.equal(assignments[0].demandId, 'DC');
  assert.equal(unmet[0].demandId, 'DN');
});
