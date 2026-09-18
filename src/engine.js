// 排程引擎：全部函数在 store 深拷贝出的 state 上工作，抛错即整笔回滚。
// 时间一律使用毫秒时间戳比较，跨午夜与休息间隔不依赖时钟小时数。
import { DomainError, priorityRank } from './domain.js';
import { ts, overlap, restGapSufficient, travelWindow, MS } from './time.js';

const iso = (ms) => new Date(ms).toISOString();
const minContinuousMs = (policy) => policy.minContinuousMinutes * MS.minute;
const restMs = (policy) => policy.minRestMinutes * MS.minute;
const bufferMs = (policy) => policy.travelBufferMinutes * MS.minute;

// ---------- 基础资料维护 ----------

export function upsertTeacher(state, teacher) {
  if (!teacher?.id) throw new DomainError('bad-input', '教师缺少 id');
  if (!teacher.homeSchool) throw new DomainError('bad-input', `教师 ${teacher.id} 缺少归属校 homeSchool`);
  if (!state.schools[teacher.homeSchool]) {
    throw new DomainError('unknown-school', `归属校 ${teacher.homeSchool} 尚未登记`);
  }
  const prev = state.teachers[teacher.id] ?? { unavailable: [] };
  state.teachers[teacher.id] = {
    qualifications: [],
    ...prev,
    ...teacher,
    qualifications: [...new Set(teacher.qualifications ?? prev.qualifications ?? [])],
    unavailable: teacher.unavailable ?? prev.unavailable ?? [],
  };
  return state.teachers[teacher.id];
}

export function upsertSchool(state, school) {
  if (!school?.id) throw new DomainError('bad-input', '学校缺少 id');
  state.schools[school.id] = { name: school.id, ...state.schools[school.id], ...school };
  return state.schools[school.id];
}

export function upsertDemand(state, demand) {
  for (const k of ['id', 'school', 'qualification', 'startsAt', 'endsAt']) {
    if (!demand?.[k]) throw new DomainError('bad-input', `需求缺少字段 ${k}`);
  }
  if (!state.schools[demand.school]) throw new DomainError('unknown-school', `需求校区 ${demand.school} 尚未登记`);
  if (ts(demand.endsAt) <= ts(demand.startsAt)) throw new DomainError('bad-input', `需求 ${demand.id} 结束时间必须晚于开始时间`);
  state.demands[demand.id] = { priority: 'normal', ...state.demands[demand.id], ...demand };
  return state.demands[demand.id];
}

export function setTravelEntry(state, schoolA, schoolB, minutes) {
  const key = [schoolA, schoolB].sort().join('|');
  if (minutes === null) { state.travelMatrix[key] = -1; return; }
  if (typeof minutes !== 'number' || minutes < 0) throw new DomainError('bad-input', '路程分钟必须为非负数字或 null(不可达)');
  state.travelMatrix[key] = minutes;
}

// ---------- 占用与冲突 ----------

// 返回当前仍可能占用教师的分配（已撤销/已被取代计划中的除外）。
// 每个窗口可被截断：interrupted 的分配只占用到请假开始时刻。
function busyWindows(state, { ignorePlan = null, ignoreAssignmentIds = new Set(), extra = [] } = {}) {
  const rows = [];
  for (const plan of Object.values(state.plans)) {
    // 草案不锁定教师（可同时生成多版草案比较）；已撤销与已被取代版本也不占用。
    if (plan.state === 'draft' || plan.state === 'cancelled' || plan.state === 'superseded' || plan.id === ignorePlan) continue;
    for (const a of plan.assignments) {
      if (a.state === 'cancelled' || ignoreAssignmentIds.has(a.id)) continue;
      let end = ts(a.busyEnd);
      if (a.state === 'interrupted' && a.interruption) end = Math.min(end, ts(a.interruption.startsAt));
      rows.push({ id: a.id, planId: plan.id, demandId: a.demandId, teacherId: a.teacherId, school: a.school, start: ts(a.busyStart), end });
    }
  }
  for (const a of extra) {
    let end = ts(a.busyEnd);
    if (a.state === 'interrupted' && a.interruption) end = Math.min(end, ts(a.interruption.startsAt));
    rows.push({ id: a.id, planId: a.planId, demandId: a.demandId, teacherId: a.teacherId, school: a.school, start: ts(a.busyStart), end });
  }
  return rows;
}

function evaluateTeacher(teacher, segment, policy, windows) {
  const win = travelWindow(segment, windows.matrix, teacher.homeSchool, bufferMs(policy));
  if (!win) return { ok: false, reason: 'travel-unreachable' };
  // 假期后接续的分配跳过“由它自己被中断而登记”的请假记录（sourceAssignment 命中即放行），
  // 该来源链会随修订携带一直保留，其他教师的请假照常冲突。
  const ignoreSources = new Set(segment.ignoreUnavailableSources ?? []);
  for (const u of teacher.unavailable ?? []) {
    if (u.sourceAssignment && ignoreSources.has(u.sourceAssignment)) continue;
    if (overlap(win.busyStart, win.busyEnd, ts(u.startsAt), ts(u.endsAt))) {
      return { ok: false, reason: 'on-leave', detail: { unavailable: u } };
    }
  }
  for (const w of windows.list.filter((x) => x.teacherId === teacher.id)) {
    if (overlap(win.busyStart, win.busyEnd, w.start, w.end)) {
      return { ok: false, reason: 'double-booked', detail: { conflictingAssignment: w.id, planId: w.planId } };
    }
    // 相邻两段之间必须留足法定休息间隔（含路程后的完整空档）。
    if (win.busyEnd <= w.start && !restGapSufficient(win.busyEnd, w.start, restMs(policy))) {
      return { ok: false, reason: 'rest-gap', detail: { after: w.id, gapMinutes: Math.round((w.start - win.busyEnd) / MS.minute), requiredMinutes: policy.minRestMinutes } };
    }
    if (w.end <= win.busyStart && !restGapSufficient(w.end, win.busyStart, restMs(policy))) {
      return { ok: false, reason: 'rest-gap', detail: { before: w.id, gapMinutes: Math.round((win.busyStart - w.end) / MS.minute), requiredMinutes: policy.minRestMinutes } };
    }
  }
  return { ok: true, win };
}

// 为一段需求挑选教师；成功返回 assignment 字段，失败返回全部拒绝原因。
function placeSegment(state, segment, policy, windows, gen, { demandId = segment.id, prefix = {}, requireMinContinuous = true } = {}) {
  const serviceMs = ts(segment.endsAt) - ts(segment.startsAt);
  // 替补接续只填请假后的剩余窗口，剩余时长不足一个完整连续周期是正常情况，不再卡退。
  if (requireMinContinuous && serviceMs < minContinuousMs(policy)) {
    return { unmet: { demandId, reasons: ['service-window-shorter-than-minimum'], detail: { serviceMinutes: Math.round(serviceMs / MS.minute), requiredMinutes: policy.minContinuousMinutes } } };
  }
  const rejected = [];
  const candidates = [];
  for (const teacher of Object.values(state.teachers)) {
    if (!teacher.qualifications.includes(segment.qualification)) {
      rejected.push({ teacherId: teacher.id, reason: 'qualification-mismatch' });
      continue;
    }
    const result = evaluateTeacher(teacher, segment, policy, windows);
    if (!result.ok) { rejected.push({ teacherId: teacher.id, reason: result.reason, detail: result.detail }); continue; }
    const loadMinutes = windows.list
      .filter((w) => w.teacherId === teacher.id)
      .reduce((sum, w) => sum + (w.end - w.start), 0) / MS.minute;
    candidates.push({ teacher, win: result.win, score: [result.win.travelMinutesEachWay, loadMinutes, teacher.id] });
  }
  if (candidates.length === 0) {
    return { unmet: { demandId, reasons: rejected.length ? [...new Set(rejected.map((r) => r.reason))] : ['no-teacher-registered'], rejected } };
  }
  candidates.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return a.score[i] > b.score[i] ? 1 : -1;
    return 0;
  });
  const [best, ...rest] = candidates;
  const a = {
    id: gen('assignment', 'A-'),
    planId: windows.planId,
    teacherId: best.teacher.id,
    demandId,
    school: segment.school,
    qualification: segment.qualification,
    startsAt: segment.startsAt,
    endsAt: segment.endsAt,
    busyStart: iso(best.win.busyStart),
    busyEnd: iso(best.win.busyEnd),
    travelMinutesEachWay: best.win.travelMinutesEachWay,
    state: 'proposed',
    rationale: {
      chosenBecause: [
        `单程路程 ${best.win.travelMinutesEachWay} 分钟（候选中最短）`,
        `候选时既有占用合计 ${Math.round(best.score[1])} 分钟（负载最低）`,
      ],
      score: { travelMinutesEachWay: best.win.travelMinutesEachWay, currentLoadMinutes: Math.round(best.score[1]) },
      alternativesConsidered: candidates.length,
      alsoQualifiedButRankedLower: rest.map((c) => c.teacher.id),
      rejected,
      ...prefix.rationale,
    },
    ...(prefix.supersedesAssignmentId ? { supersedesAssignmentId: prefix.supersedesAssignmentId } : {}),
  };
  return { assignment: a };
}

function resolvePolicy(state, override = {}) {
  return { ...state.policies, ...override };
}

function selectedDemands(state, ids) {
  const pool = ids ?? Object.keys(state.demands);
  const missing = pool.filter((id) => !state.demands[id]);
  if (missing.length) throw new DomainError('unknown-demand', `需求不存在: ${missing.join(', ')}`, { missing });
  return pool.map((id) => state.demands[id]).sort((a, b) => {
    // 高优先级（critical rank 最大）先排；同级按开始时间与 id 稳定排序。
    const pr = priorityRank(b.priority) - priorityRank(a.priority);
    return pr !== 0 ? pr : ts(a.startsAt) - ts(b.startsAt) || a.id.localeCompare(b.id);
  });
}

// ---------- 计划生命周期 ----------

export function generatePlan(state, gen, input = {}) {
  if (Object.keys(state.demands).length === 0) throw new DomainError('bad-input', '尚未登记任何校区需求');
  const policy = resolvePolicy(state, input.policy);
  const plan = {
    id: gen('plan', 'P-'),
    name: input.name ?? `轮岗计划 ${new Date().toISOString().slice(0, 10)}`,
    state: 'draft',
    policy,
    assignments: [],
    unmet: [],
    confirmations: {},
    createdAt: new Date().toISOString(),
    revisionNo: 1,
  };
  const windows = { planId: plan.id, matrix: state.travelMatrix, list: busyWindows(state) };
  for (const demand of selectedDemands(state, input.demandIds)) {
    const result = placeSegment(state, demand, policy, windows, gen);
    if (result.assignment) {
      plan.assignments.push(result.assignment);
      windows.list.push(busyOf(plan.id, result.assignment));
    } else {
      plan.unmet.push({ school: demand.school, qualification: demand.qualification, startsAt: demand.startsAt, endsAt: demand.endsAt, ...result.unmet });
    }
  }
  state.plans[plan.id] = plan;
  return plan;
}

function busyOf(planId, a) {
  let end = ts(a.busyEnd);
  if (a.state === 'interrupted' && a.interruption) end = Math.min(end, ts(a.interruption.startsAt));
  return { id: a.id, planId, demandId: a.demandId, teacherId: a.teacherId, school: a.school, start: ts(a.busyStart), end };
}

export function submitPlan(state, planId) {
  const plan = getPlan(state, planId);
  if (plan.state !== 'draft') throw new DomainError('illegal-state', `计划 ${planId} 为 ${plan.state}，仅草案可提交校方确认`, { current: plan.state });
  if (plan.assignments.length === 0) throw new DomainError('empty-plan', '空计划不能提交确认');
  plan.state = 'awaiting-school';
  return plan;
}

export function confirmBySchool(state, planId, schoolId, assignmentIds = null) {
  const plan = getPlan(state, planId);
  if (plan.state !== 'awaiting-school') throw new DomainError('illegal-state', `计划 ${planId} 为 ${plan.state}，校方确认仅在待确认阶段进行`, { current: plan.state });
  const mine = plan.assignments.filter((a) => a.school === schoolId && a.state === 'proposed');
  const targets = assignmentIds === null ? mine : assignmentIds.map((id) => {
    const a = plan.assignments.find((x) => x.id === id);
    if (!a) throw new DomainError('unknown-assignment', `分配 ${id} 不在计划 ${planId} 中`);
    if (a.school !== schoolId) throw new DomainError('forbidden-school', `学校 ${schoolId} 只能确认本校分配，${id} 属于 ${a.school}`);
    return a;
  });
  const notProposed = targets.filter((a) => a.state !== 'proposed');
  if (notProposed.length) throw new DomainError('not-confirmable', `这些分配不是待确认状态: ${notProposed.map((a) => `${a.id}(${a.state})`).join(', ')}`);
  // 整批翻转：上面任何校验失败都已抛错，此处不会留下“确认一半”。
  for (const a of targets) a.state = 'confirmed';
  const prev = plan.confirmations[schoolId]?.assignmentIds ?? [];
  plan.confirmations[schoolId] = {
    at: new Date().toISOString(),
    assignmentIds: [...new Set([...prev, ...targets.map((a) => a.id)])],
  };
  return { plan, confirmed: targets.map((a) => a.id) };
}

export function effectuatePlan(state, planId) {
  const plan = getPlan(state, planId);
  if (plan.state !== 'awaiting-school') throw new DomainError('illegal-state', `计划 ${planId} 为 ${plan.state}，仅待确认计划可生效`, { current: plan.state });
  const pending = plan.assignments.filter((a) => a.state !== 'confirmed');
  if (pending.length) {
    throw new DomainError('unconfirmed-assignments', `仍有 ${pending.length} 条分配未经校方确认，生效已整笔中止`, {
      pending: pending.map((a) => ({ id: a.id, school: a.school, state: a.state })),
    });
  }
  // 生效前防御性复检：排除本计划自身（修订版还要排除被取代的旧版同名分配）。
  const ignoreIds = new Set();
  if (plan.revisionOfId) {
    const parent = state.plans[plan.revisionOfId];
    if (parent) for (const a of parent.assignments) ignoreIds.add(a.id);
  }
  const windows = { planId: plan.id, matrix: state.travelMatrix, list: busyWindows(state, { ignorePlan: plan.id, ignoreAssignmentIds: ignoreIds }) };
  for (const a of plan.assignments) {
    const teacher = state.teachers[a.teacherId];
    const segment = { school: a.school, qualification: a.qualification, startsAt: a.startsAt, endsAt: a.endsAt, ignoreUnavailableSources: a.ignoreUnavailableSources ?? [] };
    const result = evaluateTeacher(teacher, segment, plan.policy, windows);
    if (!result.ok) throw new DomainError('conflict-at-effectuation', `生效复检发现 ${a.id} 冲突：${result.reason}`, { assignmentId: a.id, reason: result.reason, detail: result.detail });
    windows.list.push(busyOf(plan.id, a));
  }
  plan.state = 'effective';
  plan.effectiveAt = new Date().toISOString();
  if (plan.revisionOfId && state.plans[plan.revisionOfId]?.state === 'effective') {
    state.plans[plan.revisionOfId].state = 'superseded';
    state.plans[plan.revisionOfId].supersededById = plan.id;
  }
  return plan;
}

// ---------- 请假中断与替补接续 ----------

export function interrupt(state, input) {
  const { planId, kind = 'leave', reason = null } = input;
  const startsAt = input.startsAt ?? input.leaveStartsAt;
  const endsAt = input.endsAt ?? input.leaveEndsAt;
  if (!startsAt || !endsAt || ts(endsAt) <= ts(startsAt)) throw new DomainError('bad-input', '中断需要有效的 startsAt/endsAt');
  const plan = getPlan(state, planId);
  if (plan.state !== 'effective') throw new DomainError('illegal-state', `仅生效计划可登记中断，当前为 ${plan.state}`);
  let targets;
  if (input.assignmentId) {
    const a = plan.assignments.find((x) => x.id === input.assignmentId);
    if (!a) throw new DomainError('unknown-assignment', `分配 ${input.assignmentId} 不在计划 ${planId} 中`);
    targets = [a];
  } else if (input.teacherId) {
    targets = plan.assignments.filter((a) => a.teacherId === input.teacherId && a.state === 'confirmed' &&
      overlap(ts(a.startsAt), ts(a.endsAt), ts(startsAt), ts(endsAt)));
  } else {
    throw new DomainError('bad-input', '中断需指定 teacherId 或 assignmentId');
  }
  if (targets.length === 0) throw new DomainError('no-impact', '指定时段内没有可中断的已确认分配');
  for (const a of targets) {
    if (a.state !== 'confirmed') throw new DomainError('illegal-state', `分配 ${a.id} 为 ${a.state}，不可中断`);
    if (!overlap(ts(a.startsAt), ts(a.endsAt), ts(startsAt), ts(endsAt))) {
      throw new DomainError('no-impact', `中断时段与分配 ${a.id} 的服务时段不重叠`);
    }
    a.state = 'interrupted';
    a.interruption = { kind, reason, startsAt, endsAt, at: new Date().toISOString() };
    const teacher = state.teachers[a.teacherId];
    teacher.unavailable.push({ startsAt, endsAt, reason: reason ?? kind, sourceAssignment: a.id });
  }
  plan.interruptedAt = new Date().toISOString();
  return { plan, assignments: targets };
}

// 最小改派：未受影响的已确认分配原样携带（不漂移），仅为中断段重选替补。
export function repairPlan(state, gen, planId, input = {}) {
  const parent = getPlan(state, planId);
  if (parent.state !== 'effective') throw new DomainError('illegal-state', `仅生效计划可触发替补接续，当前为 ${parent.state}`);
  const broken = parent.assignments.filter((a) => a.state === 'interrupted');
  if (broken.length === 0) throw new DomainError('nothing-to-repair', `计划 ${planId} 没有中断中的分配`);

  const ignoreIds = new Set(parent.assignments.map((a) => a.id));
  const plan = {
    id: gen('plan', 'P-'),
    name: input.name ?? `${parent.name}（修订）`,
    // 紧急替补接续：携带项沿用原确认，替补项按应急接续规则自动确认，
    // 修订版直接进入待生效态；生效时仍会对全部安排做一次原子冲突复检。
    state: 'awaiting-school',
    policy: { ...parent.policy, ...input.policy },
    assignments: [],
    unmet: [],
    confirmations: {},
    createdAt: new Date().toISOString(),
    revisionOfId: parent.id,
    revisionNo: parent.revisionNo + 1,
  };
  // 先携带未受影响的确认/已完成分配，保持教师与时段不变（不无故漂移）。
  const carried = parent.assignments.filter((a) => a.state === 'confirmed' || a.state === 'completed');
  for (const old of carried) {
    const a = {
      ...structuredClone(old),
      id: gen('assignment', 'A-'),
      planId: plan.id,
      rationale: { ...(old.rationale ?? {}), carriedFromPlan: parent.id, note: '沿用上一版已确认安排，时段与教师不变' },
      supersedesAssignmentId: old.id,
      carriedFromAssignmentId: old.id,
      carriedConfirmation: true,
    };
    delete a.interruption;
    plan.assignments.push(a);
  }
  for (const school of new Set(plan.assignments.map((a) => a.school))) {
    plan.confirmations[school] = {
      at: new Date().toISOString(),
      carried: true,
      assignmentIds: plan.assignments.filter((a) => a.school === school).map((a) => a.id),
    };
  }
  // 为每个中断段拆分：请假窗口由替补覆盖；假期结束且需求仍在继续时，原教师接续（不漂移）。
  const windows = { planId: plan.id, matrix: state.travelMatrix, list: busyWindows(state, { ignoreAssignmentIds: ignoreIds }) };
  for (const a of plan.assignments) windows.list.push(busyOf(plan.id, a));
  for (const old of broken) {
    const demand = state.demands[old.demandId];
    // 请假窗口裁剪到该分配自身的服务区间（嵌套中断时不能越过原分配边界）。
    const leaveStart = iso(Math.max(ts(old.interruption.startsAt), ts(old.startsAt)));
    const leaveEnd = iso(Math.min(ts(old.interruption.endsAt), ts(old.endsAt)));
    if (ts(leaveEnd) <= ts(leaveStart)) continue;
    // 1) 替补只覆盖请假窗口（而非剩余整段）
    const cover = { id: `${demand.id}__cover__${old.id}`, school: demand.school, qualification: demand.qualification, startsAt: leaveStart, endsAt: leaveEnd };
    const coverResult = placeSegment(state, cover, plan.policy, windows, gen, {
      requireMinContinuous: false,
      demandId: demand.id,
      prefix: { rationale: { handoff: { kind: 'leave-cover', fromAssignment: old.id, fromTeacher: old.teacherId, coverStartsAt: leaveStart, coverEndsAt: leaveEnd } }, supersedesAssignmentId: old.id },
    });
    if (coverResult.assignment) {
      plan.assignments.push(coverResult.assignment);
      windows.list.push(busyOf(plan.id, coverResult.assignment));
    } else {
      plan.unmet.push({ school: demand.school, qualification: demand.qualification, startsAt: leaveStart, endsAt: leaveEnd, ...coverResult.unmet });
    }
    // 2) 假期结束后需求尚未结束：原教师接续，沿用原确认（教师不变即不漂移）
    if (ts(leaveEnd) < ts(old.endsAt)) {
      const teacher = state.teachers[old.teacherId];
      const tail = { id: `${demand.id}__resume__${old.id}`, school: demand.school, qualification: demand.qualification, startsAt: leaveEnd, endsAt: old.endsAt, ignoreUnavailableSources: [...new Set([...(old.ignoreUnavailableSources ?? []), old.id])] };
      const result = evaluateTeacher(teacher, tail, plan.policy, windows);
      if (result.ok) {
        const resume = {
          ...structuredClone(old),
          id: gen('assignment', 'A-'),
          planId: plan.id,
          startsAt: leaveEnd,
          endsAt: old.endsAt,
          busyStart: iso(result.win.busyStart),
          busyEnd: iso(result.win.busyEnd),
          travelMinutesEachWay: result.win.travelMinutesEachWay,
          state: 'confirmed',
          rationale: { ...(old.rationale ?? {}), carriedFromPlan: parent.id, note: '假期结束后原教师接续，教师不变' },
          supersedesAssignmentId: old.id,
          carriedFromAssignmentId: old.id,
          carriedConfirmation: true,
          ignoreUnavailableSources: [...new Set([...(old.ignoreUnavailableSources ?? []), old.id])],
          resumedAfter: { leaveStartsAt: leaveStart, leaveEndsAt: leaveEnd, coverAssignmentId: coverResult.assignment?.id ?? null },
        };
        delete resume.interruption;
        plan.assignments.push(resume);
        windows.list.push(busyOf(plan.id, resume));
        const c = plan.confirmations[demand.school] ?? { at: new Date().toISOString(), assignmentIds: [] };
        c.assignmentIds = [...new Set([...c.assignmentIds, resume.id])];
        plan.confirmations[demand.school] = c;
      } else {
        plan.unmet.push({ school: demand.school, qualification: demand.qualification, startsAt: leaveEnd, endsAt: old.endsAt, demandId: demand.id, reasons: [`original-teacher-resume-blocked:${result.reason}`], rejected: [{ teacherId: old.teacherId, reason: result.reason, detail: result.detail }] });
      }
    }
  }
  state.plans[plan.id] = plan;
  return plan;
}

// ---------- 撤销与恢复 ----------

export function cancelPlan(state, planId, { reason = null } = {}) {
  const plan = getPlan(state, planId);
  if (plan.state === 'cancelled') throw new DomainError('illegal-state', `计划 ${planId} 已撤销`);
  if (plan.state === 'superseded') throw new DomainError('illegal-state', '已被修订取代的历史版本不可撤销（保留用于复盘）');
  plan.stateBeforeCancel = plan.state;
  plan.state = 'cancelled';
  plan.cancelledAt = new Date().toISOString();
  plan.cancelReason = reason;
  return plan;
}

export function restorePlan(state, planId) {
  const plan = getPlan(state, planId);
  if (plan.state !== 'cancelled') throw new DomainError('illegal-state', `计划 ${planId} 未处于撤销状态`);
  const ignoreIds = new Set(plan.assignments.map((a) => a.id));
  const windows = { planId: plan.id, matrix: state.travelMatrix, list: busyWindows(state, { ignorePlan: plan.id, ignoreAssignmentIds: ignoreIds }) };
  for (const a of plan.assignments) {
    const result = evaluateTeacher(state.teachers[a.teacherId], { school: a.school, qualification: a.qualification, startsAt: a.startsAt, endsAt: a.endsAt }, plan.policy, windows);
    if (!result.ok) throw new DomainError('restore-conflict', `恢复失败：${a.id} 现有冲突 ${result.reason}`, { assignmentId: a.id, reason: result.reason, detail: result.detail });
    windows.list.push(busyOf(plan.id, a));
  }
  plan.state = plan.stateBeforeCancel ?? 'draft';
  delete plan.stateBeforeCancel;
  delete plan.cancelledAt;
  delete plan.cancelReason;
  return plan;
}

export function cancelAssignment(state, assignmentId, { reason = null } = {}) {
  const { plan, assignment } = findAssignment(state, assignmentId);
  if (assignment.state === 'cancelled') throw new DomainError('illegal-state', `分配 ${assignmentId} 已撤销`);
  assignment.stateBeforeCancel = assignment.state;
  assignment.state = 'cancelled';
  assignment.cancelledAt = new Date().toISOString();
  assignment.cancelReason = reason;
  const demand = state.demands[assignment.demandId];
  if (demand) plan.unmet.push({ demandId: demand.id, school: assignment.school, qualification: assignment.qualification, startsAt: assignment.startsAt, endsAt: assignment.endsAt, reasons: ['assignment-cancelled'], detail: { assignmentId, reason } });
  return { plan, assignment };
}

export function restoreAssignment(state, assignmentId) {
  const { plan, assignment } = findAssignment(state, assignmentId);
  if (assignment.state !== 'cancelled') throw new DomainError('illegal-state', `分配 ${assignmentId} 未处于撤销状态`);
  const windows = { planId: plan.id, matrix: state.travelMatrix, list: busyWindows(state, { ignoreAssignmentIds: new Set([assignmentId]) }) };
  const result = evaluateTeacher(state.teachers[assignment.teacherId], { school: assignment.school, qualification: assignment.qualification, startsAt: assignment.startsAt, endsAt: assignment.endsAt }, plan.policy, windows);
  if (!result.ok) throw new DomainError('restore-conflict', `恢复失败：${assignmentId} 现有冲突 ${result.reason}`, { reason: result.reason, detail: result.detail });
  assignment.state = assignment.stateBeforeCancel ?? 'proposed';
  delete assignment.stateBeforeCancel;
  delete assignment.cancelledAt;
  delete assignment.cancelReason;
  plan.unmet = plan.unmet.filter((u) => !(u.detail?.assignmentId === assignmentId && u.reasons?.includes('assignment-cancelled')));
  return { plan, assignment };
}

// ---------- 查询 ----------

export function getPlan(state, planId) {
  const plan = state.plans[planId];
  if (!plan) throw new DomainError('unknown-plan', `计划 ${planId} 不存在`);
  return plan;
}

export function findAssignment(state, assignmentId) {
  for (const plan of Object.values(state.plans)) {
    const assignment = plan.assignments.find((a) => a.id === assignmentId);
    if (assignment) return { plan, assignment };
  }
  throw new DomainError('unknown-assignment', `分配 ${assignmentId} 不存在`);
}

// 每个修订链上的最新版本（含已撤销状态，由各视图决定是否隐藏）；
// 旧版本即使最新修订被撤销也仍是 superseded，不会重新成为链头。
export function chainHeads(state) {
  const children = new Set();
  for (const plan of Object.values(state.plans)) {
    if (plan.revisionOfId) children.add(plan.revisionOfId);
  }
  return Object.values(state.plans).filter((p) => !children.has(p.id));
}

export function schoolArrangements(state, schoolId) {
  if (!state.schools[schoolId]) throw new DomainError('unknown-school', `学校 ${schoolId} 不存在`);
  const out = [];
  for (const plan of chainHeads(state)) {
    // 草案是协调员内部产物，撤销计划整体下线；待确认与生效版本才对校方可见。
    if (plan.state === 'draft' || plan.state === 'cancelled') continue;
    for (const a of plan.assignments) {
      if (a.school !== schoolId || a.state === 'cancelled') continue;
      // 脱敏：完整 rationale（含其他候选教师 id）只对协调员开放；
      // 校方只看本校安排的说明文字。
      const { rationale, ...rest } = a;
      out.push({
        planId: plan.id, planState: plan.state, revisionNo: plan.revisionNo, ...rest,
        rationaleNote: rationale ? { chosenBecause: rationale.chosenBecause ?? null, handoff: rationale.handoff ?? null } : null,
      });
    }
  }
  return { schoolId, arrangements: out };
}

// 未满足需求：汇总各修订链头的 unmet（含草案，协调员在排程当下就需要看到派不下去的需求），
// 以及完全没有任何计划覆盖的需求。
export function unmetReport(state) {
  const heads = chainHeads(state).filter((p) => p.state !== 'cancelled');
  const touched = new Set();
  const items = [];
  for (const plan of heads) {
    for (const a of plan.assignments) if (a.state !== 'cancelled') touched.add(a.demandId);
    for (const u of plan.unmet) {
      touched.add(u.demandId);
      items.push({ planId: plan.id, planState: plan.state, ...u });
    }
  }
  for (const demand of Object.values(state.demands)) {
    if (!touched.has(demand.id)) {
      items.push({ planId: null, planState: null, demandId: demand.id, school: demand.school, qualification: demand.qualification, startsAt: demand.startsAt, endsAt: demand.endsAt, reasons: ['never-scheduled'] });
    }
  }
  return { items };
}

// 某次调整的影响面：从事件记录与修订链推导“影响了谁”。
// 修订场景下，原样携带的安排归入 unchanged（证明它们没有漂移），
// 真正变化的只有中断的原教师与接续的替补。
export function adjustmentImpact(state, ref) {
  const event = ref.eventSeq != null ? state.events.find((e) => e.seq === ref.eventSeq) : null;
  const planId = ref.planId ?? event?.planId ?? event?.impact?.sourcePlanId ?? null;
  const plan = planId ? getPlan(state, planId) : null;
  const target = event ?? (plan ? { type: 'plan-snapshot', planId: plan.id } : null);
  if (!target) throw new DomainError('not-found', '未找到对应调整事件');

  const changed = [];
  const unchanged = [];
  const add = (bucket, a, change) => {
    bucket.push({ change, assignmentId: a.id, teacherId: a.teacherId, school: a.school, demandId: a.demandId, state: a.state, ...(a.carriedFromAssignmentId ? { carriedFromAssignmentId: a.carriedFromAssignmentId } : {}) });
  };

  // 修订事件按修订链分类（携带/替补/中断）；其他事件按事件登记的分配标记变化。
  const useRevisionView = plan && plan.revisionOfId && (event?.type === 'plan-repaired' || !event);
  if (event?.impact?.assignmentIds && plan && !useRevisionView) {
    for (const id of event.impact.assignmentIds) {
      const found = plan.assignments.find((a) => a.id === id) ?? state.plans[event.impact.sourcePlanId]?.assignments.find((a) => a.id === id);
      if (found) add(changed, found, event.type);
    }
  } else if (plan) {
    if (plan.revisionOfId) {
      const parent = state.plans[plan.revisionOfId];
      for (const a of plan.assignments) add(a.carriedConfirmation ? unchanged : changed, a, a.carriedConfirmation ? 'carried-unchanged' : 'substitute');
      for (const old of parent.assignments) if (old.state === 'interrupted') add(changed, old, 'interrupted');
    } else {
      plan.assignments.forEach((a) => add(changed, a, plan.state));
    }
  }
  const teachers = new Set(), schools = new Set(), demands = new Set();
  for (const a of changed) { teachers.add(a.teacherId); schools.add(a.school); demands.add(a.demandId); }
  return {
    event: event ? { seq: event.seq, type: event.type, at: event.at, details: event.details } : null,
    planId: target.planId,
    impactedTeachers: [...teachers], impactedSchools: [...schools], impactedDemands: [...demands],
    changedAssignments: changed,
    unchangedAssignments: unchanged,
  };
}
