// 排程器：在教师时间线上放置驻校片段。
// 占用 = 授课区间 + 校门到校门的路程 + 交通缓冲；相邻两段不同需求之间还要满足法定休息间隔。
// 全部比较使用 epoch 毫秒，跨午夜的晚课/早课与普通区间没有区别。
import { parse, countServiceDays } from './time.js';
import { travelMinutes } from './model.js';

// 候选评分权重（分值越小越优先），同时保留打分明细用于回答“为何选这位替补”。
const W_LOAD = 1000;   // 每位教师已承担的片段
const W_TRAVEL = 1;    // 新增路程分钟
const W_ID = 0.000001; // id 字典序兜底，保证结果确定

export { countServiceDays };

// 教师时间线：每名教师对应按开始时间排序的授课占用区间。
// 中断片段只占用到中断时刻（clipEndsAt）；路程与休息在可行性检查时即时计算。
export class Timeline {
  constructor() {
    this.entries = new Map(); // teacherId -> [{start, end, school, segmentId, rootId}]
    this.blocks = new Map();  // teacherId -> [{start, end, reason}]（请假等不可用窗口，epoch 毫秒）
  }

  add(teacherId, segment) {
    const start = parse(segment.startsAt);
    const end = parse(segment.clipEndsAt ?? segment.endsAt);
    if (end <= start) return; // 中断时刻恰好等于开始 => 无实际占用
    const list = this.entries.get(teacherId) ?? [];
    list.push({
      start, end,
      school: segment.schoolId,
      segmentId: segment.id,
      rootId: segment.rootId ?? segment.id,
    });
    list.sort((a, b) => a.start - b.start || a.end - b.end || a.segmentId.localeCompare(b.segmentId));
    this.entries.set(teacherId, list);
  }

  static fromSegments(segments, blocks = new Map()) {
    const tl = new Timeline();
    tl.blocks = blocks;
    for (const s of segments) {
      if (s.state === 'revoked' || s.state === 'proposed-cancelled') continue;
      tl.add(s.teacherId, s);
    }
    return tl;
  }

  // 返回不可行原因；null 表示可行。
  // interval: { id, rootId, startsAt, endsAt }；opts.fromAt 表示这是请假后的接续片段。
  check(teacher, demand, interval, ctx, opts = {}) {
    const start = parse(interval.startsAt);
    const end = parse(interval.endsAt);
    if (end <= start) return { reason: 'BAD_INTERVAL' };

    // 完整需求才受最低连续服务周期约束；请假后的“接续片段”允许短于完整周期。
    if (!opts.fromAt) {
      const days = countServiceDays(interval.startsAt, interval.endsAt);
      if (days < ctx.minContiguousDays) {
        return { reason: 'MIN_CONTIGUOUS', detail: { serviceDays: days, required: ctx.minContiguousDays } };
      }
    }

    const list = this.entries.get(teacher.id) ?? [];
    for (const e of list) {
      if (e.segmentId === interval.id) continue;
      if (start < e.end && e.start < end) {
        return { reason: 'TEACHING_CONFLICT', detail: { with: e.segmentId } };
      }
    }

    // 请假/资质停教窗口：开放中的教师级中断使该教师在此期间不可被再次分配。
    // 资质停教窗口只屏蔽对应学科，教师仍可承担其他资质的需求。
    for (const b of this.blocks.get(teacher.id) ?? []) {
      if (b.qualification && b.qualification !== demand.qualification) continue;
      if (start < b.end && b.start < end) {
        return { reason: 'TEACHER_ON_LEAVE', detail: { until: b.end === Infinity ? null : new Date(b.end).toISOString(), why: b.reason } };
      }
    }

    const prev = [...list].reverse().find((e) => e.end <= start && e.segmentId !== interval.id);
    const next = list.find((e) => e.start >= end && e.segmentId !== interval.id);
    // 同一条需求（同 rootId）的前后片段是同校交接，不产生行程，也不重复计算休息。
    const sameRoot = (e) => e && e.rootId === (interval.rootId ?? interval.id) && e.school === demand.school;

    if (prev && !sameRoot(prev)) {
      const bad = this.gap(prev.school, demand.school, prev.end, start, 'before', prev.segmentId, ctx);
      if (bad) return bad;
    } else if (!prev && teacher.homeSchool) {
      // 首段：教师从驻家学校出发，路程必须在矩阵中存在（可提前出发，不卡当天时刻）。
      const travel = travelMinutes(ctx.travel, teacher.homeSchool, demand.school);
      if (travel === null) return { reason: 'UNREACHABLE', detail: { from: teacher.homeSchool, to: demand.school } };
    }

    if (next && !sameRoot(next)) {
      const bad = this.gap(demand.school, next.school, end, next.start, 'after', next.segmentId, ctx);
      if (bad) return bad;
    }
    return null;
  }

  gap(beforeSchool, afterSchool, freeStart, freeEnd, label, withId, ctx) {
    const travel = travelMinutes(ctx.travel, beforeSchool, afterSchool);
    if (travel === null) return { reason: 'UNREACHABLE', detail: { from: beforeSchool, to: afterSchool } };
    const required = travel + ctx.travelBufferMinutes + ctx.minRestMinutes;
    const freeMin = Math.round((freeEnd - freeStart) / 60_000);
    if (freeMin < required) {
      return {
        reason: 'BUFFER_OR_REST',
        detail: { label, with: withId, freeMinutes: freeMin, travelMinutes: travel,
          bufferMinutes: ctx.travelBufferMinutes, restMinutes: ctx.minRestMinutes, requiredMinutes: required },
      };
    }
    return null;
  }
}

// 在给定时间线上为一个需求挑选最佳教师。
// 返回 { teacherId, candidates, why }；无人可选时 teacherId 为 null 并附全部落选原因。
export function selectTeacher(demand, interval, ctx, timeline, opts = {}) {
  const qualified = [...ctx.teachers.values()]
    .filter((t) => t.qualifications.includes(demand.qualification))
    .filter((t) => !opts.excludeTeacherIds?.includes(t.id));

  if (qualified.length === 0) {
    return { teacherId: null, candidates: [],
      why: { reason: 'NO_QUALIFIED_TEACHER', detail: { qualification: demand.qualification } } };
  }

  const candidates = [];
  const blockers = [];
  for (const t of qualified) {
    const bad = timeline.check(t, demand, interval, ctx, opts);
    const list = timeline.entries.get(t.id) ?? [];
    const prev = [...list].reverse().find((e) => e.end <= parse(interval.startsAt));
    const fromSchool = prev ? prev.school : (t.homeSchool ?? null);
    const inTravel = fromSchool ? travelMinutes(ctx.travel, fromSchool, demand.school) : 0;
    if (bad) { blockers.push({ teacherId: t.id, ...bad }); continue; }
    const score = list.length * W_LOAD + (inTravel ?? 0) * W_TRAVEL + idRank(t.id) * W_ID;
    candidates.push({ teacherId: t.id, score, load: list.length, fromSchool, inTravelMinutes: inTravel ?? 0 });
  }

  if (candidates.length === 0) {
    return { teacherId: null, candidates: [], why: { reason: 'ALL_CANDIDATES_BLOCKED', detail: { blockers } } };
  }

  candidates.sort((a, b) => a.score - b.score || a.teacherId.localeCompare(b.teacherId));
  for (let i = 0; i < candidates.length; i++) candidates[i].rank = i + 1;
  return { teacherId: candidates[0].teacherId, candidates, why: null };
}

function idRank(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 1_000_000;
  return h;
}

// 生成整版草案：按 关键 > 重要 > 普通、开始时间、id 的确定顺序逐需求排程。
// seedSegments 为其他生效计划中仍占用教师的片段，草案不得与它们冲突。
export function buildAssignments(ctx, { idGen = defaultIdGen(), now = new Date().toISOString(), seedSegments = [], blocks = new Map() } = {}) {
  const timeline = Timeline.fromSegments(seedSegments, blocks);
  const assignments = [];
  const unmet = [];
  const order = [...ctx.demands.values()].sort(byPriorityThenTime);

  for (const demand of order) {
    const id = idGen('seg');
    const interval = { id, rootId: id, startsAt: demand.startsAt, endsAt: demand.endsAt };
    const picked = selectTeacher(demand, interval, ctx, timeline, { id });
    if (!picked.teacherId) {
      unmet.push({ demandId: demand.id, ...picked.why, at: now });
      continue;
    }
    const seg = {
      id,
      rootId: id,
      seq: 0,
      planId: null,
      demandId: demand.id,
      schoolId: demand.school,
      teacherId: picked.teacherId,
      qualification: demand.qualification,
      startsAt: demand.startsAt,
      endsAt: demand.endsAt,
      clipEndsAt: null,
      state: 'proposed',
      rationale: picked.candidates,
      interruptionId: null,
      replacedSegmentId: null,
      createdAt: now,
    };
    timeline.add(seg.teacherId, seg);
    assignments.push(seg);
  }
  return { assignments, unmet };
}

// 为中断片段挑选接续教师并构造接续片段（不动其他任何片段）。
// openInterval: { startsAt, endsAt, rootId, nextSeq, interruptionId, previousSegmentId }
export function buildReplacement(rootDemand, openInterval, ctx, segments, {
  excludeTeacherIds = [], idGen = defaultIdGen(), now = new Date().toISOString(), seedSegments = [], blocks = new Map(),
} = {}) {
  const timeline = Timeline.fromSegments([...segments, ...seedSegments], blocks);
  const id = idGen('seg');
  const interval = { id, rootId: openInterval.rootId, startsAt: openInterval.startsAt, endsAt: openInterval.endsAt };
  const picked = selectTeacher(rootDemand, interval, ctx, timeline,
    { excludeTeacherIds, fromAt: openInterval.startsAt, id });
  if (!picked.teacherId) return { segment: null, why: picked.why, candidates: picked.candidates };
  const seg = {
    id,
    rootId: openInterval.rootId,
    seq: openInterval.nextSeq,
    planId: null,
    demandId: rootDemand.id,
    schoolId: rootDemand.school,
    teacherId: picked.teacherId,
    qualification: rootDemand.qualification,
    startsAt: openInterval.startsAt,
    endsAt: openInterval.endsAt,
    clipEndsAt: null,
    state: 'proposed',
    rationale: picked.candidates,
    interruptionId: openInterval.interruptionId,
    replacedSegmentId: openInterval.previousSegmentId,
    createdAt: now,
  };
  return { segment: seg, why: null, candidates: picked.candidates };
}

// 对一组片段做整表校验（批量确认/生效前使用），返回全部违例。
// extraSegments 为其他生效计划中仍占用教师的片段；blocks 为请假等不可用窗口。
export function validateAll(assignments, ctx, extraSegments = [], blocks = new Map()) {
  const violations = [];
  const tl = Timeline.fromSegments([...assignments, ...extraSegments], blocks);
  for (const seg of assignments) {
    if (seg.state === 'revoked' || seg.state === 'interrupted') continue;
    const teacher = ctx.teachers.get(seg.teacherId);
    const demand = ctx.demands.get(seg.demandId);
    if (!teacher) { violations.push({ segmentId: seg.id, reason: 'UNKNOWN_TEACHER' }); continue; }
    if (!demand) { violations.push({ segmentId: seg.id, reason: 'UNKNOWN_DEMAND' }); continue; }
    if (!teacher.qualifications.includes(seg.qualification)) {
      violations.push({ segmentId: seg.id, reason: 'QUALIFICATION_LOST' });
    }
    const interval = { id: seg.id, rootId: seg.rootId, startsAt: seg.startsAt, endsAt: seg.clipEndsAt ?? seg.endsAt };
    const bad = tl.check(teacher, demand, interval, ctx, { fromAt: seg.seq > 0 ? seg.startsAt : null });
    if (bad) violations.push({ segmentId: seg.id, ...bad });
  }
  return violations;
}

const PRIORITY_RANK = { critical: 0, important: 1, normal: 2 };
function byPriorityThenTime(a, b) {
  return (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
    || parse(a.startsAt) - parse(b.startsAt)
    || a.id.localeCompare(b.id);
}

export function defaultIdGen(prefix = 'A') {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, '0')}`;
}
