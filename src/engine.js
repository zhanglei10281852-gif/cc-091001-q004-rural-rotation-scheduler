// 轮岗调度引擎：所有写操作都先完成全部校验，再以“一个提交、多个事件”的方式原子落盘。
// 重启后回放事件日志即可重建状态；任意提交点都可复盘历史版本。
import { validateContext } from './model.js';
import { parse } from './time.js';
import {
  buildAssignments, buildReplacement, validateAll, defaultIdGen,
} from './scheduler.js';
import { interruptionKinds } from './domain.js';

export class RotationEngine {
  constructor(store, { now = () => new Date().toISOString() } = {}) {
    this.store = store;
    this.now = now;
    this.state = emptyState();
    for (const rec of store.load()) reduce(this.state, rec.events, rec);
  }

  // ---------- 草案 ----------

  // 依据业务资料生成可执行草案：排不进去的需求不会被静默丢弃，会进入 unmet 清单。
  createPlan(context, { planId = `P-${Object.keys(this.state.plans).length + 1}`, actor = null, note = null } = {}) {
    if (this.state.plans[planId]) throw new Error(`计划 ${planId} 已存在`);
    const ctx = validateContext(context);
    const at = this.now();
    // 新草案不能占用当前生效计划中的教师。
    const seed = this.#externalLiveSegments();
    const { assignments, unmet } = buildAssignments(ctx, { idGen: defaultIdGen(planId), now: at, seedSegments: seed, blocks: this.#teacherBlocks() });
    const events = [
      { type: 'ContextRecorded', planId, context: canonicalContext(context) },
      { type: 'PlanCreated', planId, at },
      ...assignments.map((s) => ({ type: 'SegmentProposed', planId, segment: { ...s, planId } })),
      ...unmet.map((u) => ({
        type: 'RequirementUnmet', planId, at,
        gap: { key: `draft:${u.demandId}`, demandId: u.demandId, interruptionId: null, reason: u.reason, detail: u.detail ?? null },
      })),
    ];
    const rec = this.store.commit(events, { actor, note: note ?? `生成草案 ${planId}` });
    reduce(this.state, rec.events, rec);
    return this.planView(planId);
  }

  // 草案阶段撤销某候选安排（可恢复），不触碰其他候选或已确认安排。
  cancelDraftSegment(planId, segmentId, { actor = null, note = null } = {}) {
    const plan = this.#requirePlan(planId);
    if (plan.state !== 'draft') throw new Error('只有草案阶段可以撤销候选');
    const seg = this.#requireSegment(segmentId, planId);
    if (seg.state !== 'proposed') throw new Error(`片段 ${segmentId} 不是候选状态`);
    const rec = this.store.commit(
      [{ type: 'SegmentCancelled', planId, segmentId, at: this.now() }],
      { actor, note: note ?? `撤销候选 ${segmentId}` });
    reduce(this.state, rec.events, rec);
    return this.planView(planId);
  }

  restoreDraftSegment(planId, segmentId, { actor = null, note = null } = {}) {
    const plan = this.#requirePlan(planId);
    if (plan.state !== 'draft') throw new Error('只有草案阶段可以恢复候选');
    const seg = this.#requireSegment(segmentId, planId);
    if (seg.state !== 'proposed-cancelled') throw new Error(`片段 ${segmentId} 不是已撤销状态`);
    // 恢复前重新验证：恢复后的整表必须可行，否则整笔取消。
    const ctx = validateContext(plan.context);
    const simulated = this.#planSegments(planId).map((s) => s.id === segmentId ? { ...s, state: 'proposed' } : s);
    const violations = validateAll(simulated, ctx, this.#externalLiveSegments(planId), this.#teacherBlocks());
    if (violations.length) throw new Error(`恢复会造成冲突，整笔操作取消: ${JSON.stringify(violations)}`);
    const rec = this.store.commit(
      [{ type: 'SegmentRestored', planId, segmentId, at: this.now() }],
      { actor, note: note ?? `恢复候选 ${segmentId}` });
    reduce(this.state, rec.events, rec);
    return this.planView(planId);
  }

  // ---------- 校方确认与生效 ----------

  // 批量确认：先模拟“全部确认”后的整表做校验，任一违例则整批失败、不落任何事件。
  confirmSchools(planId, schoolIds, { actor = null, note = null } = {}) {
    const plan = this.#requirePlan(planId);
    if (plan.state !== 'draft' && plan.state !== 'awaiting-school') {
      throw new Error(`计划处于 ${plan.state}，不能确认`);
    }
    const ids = [...new Set(schoolIds)];
    for (const sid of ids) {
      if (!plan.context.schools?.some((s) => s.id === sid)) throw new Error(`未知学校: ${sid}`);
      if (plan.confirmations.has(sid)) throw new Error(`学校 ${sid} 已确认，请勿重复操作`);
    }
    const ctx = validateContext(plan.context);
    const simulated = this.#planSegments(planId)
      .filter((s) => s.state !== 'proposed-cancelled')
      .map((s) => ({ ...s, state: 'confirmed' }));
    const violations = validateAll(simulated, ctx, this.#externalLiveSegments(planId), this.#teacherBlocks());
    if (violations.length) throw new Error(`确认前校验失败，已整批退回，未作任何改动: ${JSON.stringify(violations)}`);

    const at = this.now();
    const rec = this.store.commit(
      ids.map((schoolId) => ({ type: 'SchoolConfirmed', planId, schoolId, at })),
      { actor, note: note ?? `校方确认: ${ids.join(',')}` });
    reduce(this.state, rec.events, rec);
    return this.planView(planId);
  }

  // 生效：所有有安排的学校都必须确认；整表再校验一次；单提交原子翻转（同时作废旧计划）。
  activate(planId, { actor = null, note = null } = {}) {
    const plan = this.#requirePlan(planId);
    if (plan.state !== 'draft' && plan.state !== 'awaiting-school') {
      throw new Error(`计划处于 ${plan.state}，不能生效`);
    }
    const live = this.#planSegments(planId).filter((s) => s.state !== 'proposed-cancelled' && s.state !== 'revoked');
    const owningSchools = new Set(live.map((s) => s.schoolId));
    const missing = [...owningSchools].filter((s) => !plan.confirmations.has(s));
    if (missing.length) throw new Error(`尚有学校未确认: ${missing.join(',')}`);
    const ctx = validateContext(plan.context);
    const violations = validateAll(this.#planSegments(planId), ctx, this.#externalLiveSegments(planId), this.#teacherBlocks());
    if (violations.length) throw new Error(`生效校验失败，计划未作任何改动: ${JSON.stringify(violations)}`);

    const at = this.now();
    const events = [];
    for (const other of Object.values(this.state.plans)) {
      if (other.id !== planId && other.state === 'effective') {
        events.push({ type: 'PlanSuperseded', planId: other.id, at });
      }
    }
    events.push({ type: 'PlanActivated', planId, at });
    const rec = this.store.commit(events, { actor, note: note ?? `计划 ${planId} 生效` });
    reduce(this.state, rec.events, rec);
    return this.planView(planId);
  }

  // ---------- 请假中断与替补接续 ----------

  // 教师请假：剪短在履行片段（endsAt 之内尚未开始的片段整段让出），
  // 只为受影响的需求链选择替补，其他安排一律不动（无漂移）。
  interruptTeacherLeave(planId, teacherId, { at, endsAt = null, kind = 'leave' } = {}, { actor = null, note = null } = {}) {
    if (!interruptionKinds.includes(kind)) throw new Error(`非法中断原因: ${kind}`);
    const plan = this.#requireEffective(planId);
    if (!plan.context.teachers?.some((t) => t.id === teacherId)) throw new Error(`未知教师: ${teacherId}`);
    parse(at);
    if (endsAt) parse(endsAt);

    const targets = this.#leaveTargets(plan, teacherId, at, endsAt);
    if (!targets.length) throw new Error(`教师 ${teacherId} 在该时段没有受影响的安排`);

    this.#pendingInterruptionCount = 0;
    const idGen = this.#idGen(planId);
    const work = { extra: [], blocks: this.#teacherBlocks() };
    pushBlock(work.blocks, teacherId, parse(at), endsAt ? parse(endsAt) : Infinity, kind);
    const events = [];
    const interruptionIds = [];
    for (const seg of targets) {
      const out = this.#interruptOne(plan, seg, { kind, at, excludeTeacherIds: [teacherId], idGen, work });
      events.push(...out.events);
      interruptionIds.push(out.interruptionId);
      if (out.replacement) work.extra.push(out.replacement); // 同次连续改派不得再占用这位替补
    }
    const rec = this.store.commit(events, { actor, note: note ?? `${teacherId} 请假中断` });
    reduce(this.state, rec.events, rec);
    return { plan: this.planView(planId), interruptionIds };
  }

  // 学校停课/封闭：中断时点本校全部在履行片段；停课期间不安排替补，撤销中断即恢复。
  interruptSchoolClosure(planId, schoolId, { at, endsAt = null }, { actor = null, note = null } = {}) {
    const plan = this.#requireEffective(planId);
    if (!plan.context.schools?.some((s) => s.id === schoolId)) throw new Error(`未知学校: ${schoolId}`);
    parse(at);
    const active = this.#planSegments(planId).filter((s) => s.schoolId === schoolId && this.#isActiveAt(s, at));
    if (!active.length) throw new Error(`学校 ${schoolId} 在 ${at} 没有正在履行的安排`);

    this.#pendingInterruptionCount = 0;
    const interruptionId = this.#nextInterruptionId(planId);
    const events = [{
      type: 'InterruptionRecorded', planId, at: this.now(),
      interruption: {
        id: interruptionId, planId, kind: 'school-closure', schoolId, teacherId: null,
        startsAt: at, endsAt, segmentIds: active.map((s) => s.id), status: 'open',
      },
    }];
    for (const seg of active) {
      events.push({ type: 'SegmentInterrupted', planId, segmentId: seg.id, at,
        clipEndsAt: this.#clip(seg, at), interruptionId, priorState: seg.state });
      events.push({
        type: 'RequirementUnmet', planId, at: this.now(),
        gap: {
          key: `${interruptionId}:${seg.rootId}`, demandId: seg.demandId, interruptionId,
          reason: 'SCHOOL_CLOSED', detail: { schoolId, until: endsAt },
        },
      });
    }
    const rec = this.store.commit(events, { actor, note: note ?? `${schoolId} 停课` });
    reduce(this.state, rec.events, rec);
    return { plan: this.planView(planId), interruptionId };
  }

  // 资质变更：教师丧失某项资质，其相关在履行片段全部中断并另寻有资质的替补。
  interruptQualificationChange(planId, teacherId, qualification, at, { actor = null, note = null } = {}) {
    const plan = this.#requireEffective(planId);
    parse(at);
    const active = this.#planSegments(planId)
      .filter((s) => s.teacherId === teacherId && s.qualification === qualification && this.#isActiveAt(s, at));
    if (!active.length) throw new Error(`教师 ${teacherId} 在 ${at} 没有资质 ${qualification} 的在履行安排`);
    this.#pendingInterruptionCount = 0;
    const idGen = this.#idGen(planId);
    const work = { extra: [], blocks: this.#teacherBlocks() };
    pushBlock(work.blocks, teacherId, parse(at), Infinity, 'qualification-change', qualification);
    const events = [];
    const interruptionIds = [];
    for (const seg of active) {
      const out = this.#interruptOne(plan, seg,
        { kind: 'qualification-change', at, excludeTeacherIds: [teacherId], idGen, work });
      events.push(...out.events);
      interruptionIds.push(out.interruptionId);
      if (out.replacement) work.extra.push(out.replacement);
    }
    const rec = this.store.commit(events, { actor, note: note ?? `${teacherId} 资质变更` });
    reduce(this.state, rec.events, rec);
    return { plan: this.planView(planId), interruptionIds };
  }

  // 构造单个片段的中断事件 + 替补（或缺口记录）。不直接落盘，由调用方合并为一个提交。
  // work 在同一命令的多片段连续改派之间共享，保证替补不会被重复占用。
  #interruptOne(plan, seg, { kind, at, excludeTeacherIds, idGen, work }) {
    const planId = plan.id;
    const interruptionId = this.#nextInterruptionId(planId);
    const clipEndsAt = this.#clip(seg, at);
    const chain = this.#chain(planId, seg.rootId);
    const nextSeq = Math.max(...chain.map((s) => s.seq)) + 1;
    const ctx = validateContext(plan.context);
    const demand = plan.context.demands.find((d) => d.id === seg.demandId);
    const result = buildReplacement(demand, {
      startsAt: clipEndsAt, endsAt: seg.endsAt, rootId: seg.rootId, nextSeq,
      interruptionId, previousSegmentId: seg.id,
    }, ctx, this.#planSegments(planId), {
      excludeTeacherIds, idGen, now: this.now(),
      seedSegments: [...this.#externalLiveSegments(planId), ...work.extra],
      blocks: work.blocks,
    });

    const events = [{
      type: 'InterruptionRecorded', planId, at: this.now(),
      interruption: {
        id: interruptionId, planId, kind, schoolId: null, teacherId: seg.teacherId,
        qualification: kind === 'qualification-change' ? seg.qualification : null,
        startsAt: at, endsAt: null, segmentIds: [seg.id], status: 'open',
      },
    }, {
      type: 'SegmentInterrupted', planId, segmentId: seg.id, at, clipEndsAt, interruptionId,
      priorState: seg.state,
    }];

    if (result.segment) {
      events.push({ type: 'ReplacementProposed', planId, at: this.now(), segment: { ...result.segment, planId } });
    } else {
      events.push({
        type: 'RequirementUnmet', planId, at: this.now(),
        gap: {
          key: `${interruptionId}:${seg.rootId}`, demandId: demand.id, interruptionId,
          reason: result.why.reason, detail: result.why.detail ?? null,
        },
      });
    }
    return { events, interruptionId, replacement: result.segment };
  }

  // 校方确认替补接续片段；确认前对整表做校验，失败则整笔取消。
  confirmReplacement(planId, segmentId, schoolId, { actor = null, note = null } = {}) {
    const plan = this.#requireEffective(planId);
    const seg = this.#requireSegment(segmentId, planId);
    if (seg.schoolId !== schoolId) throw new Error(`片段 ${segmentId} 不属于学校 ${schoolId}`);
    if (seg.state !== 'proposed' || seg.seq === 0) throw new Error(`片段 ${segmentId} 不是待确认的替补`);
    const ctx = validateContext(plan.context);
    const simulated = this.#planSegments(planId).map((s) => s.id === segmentId ? { ...s, state: 'confirmed' } : s);
    const violations = validateAll(simulated, ctx, this.#externalLiveSegments(planId), this.#teacherBlocks());
    if (violations.length) throw new Error(`替补确认校验失败，未作任何改动: ${JSON.stringify(violations)}`);
    const rec = this.store.commit(
      [{ type: 'ReplacementConfirmed', planId, segmentId, schoolId, at: this.now() }],
      { actor, note: note ?? `校方确认替补 ${segmentId}` });
    reduce(this.state, rec.events, rec);
    return this.planView(planId);
  }

  // ---------- 撤销恢复 ----------

  // 撤销一次中断：作废尚未确认的替补候选，恢复原片段；若当时无人可补则同时关闭缺口。
  // 若该链上还有更晚的中断（连续改派），必须从最近一次往回撤，避免越过后续调整。
  revokeInterruption(planId, interruptionId, { actor = null, note = null } = {}) {
    const plan = this.#requirePlan(planId);
    const inter = this.state.interruptions[interruptionId];
    if (!inter || inter.planId !== planId) throw new Error(`未知中断: ${interruptionId}`);
    if (inter.status !== 'open') throw new Error(`中断 ${interruptionId} 已关闭，不能重复撤销`);

    const events = [];
    for (const sid of inter.segmentIds) {
      const seg = this.#requireSegment(sid, planId);
      const child = this.#chain(planId, seg.rootId).find((s) => s.seq > 0 && s.interruptionId === interruptionId);
      if (child) {
        if (child.state === 'interrupted') {
          throw new Error(`需求 ${seg.demandId} 之后又发生了中断，请先撤销更近的中断 ${child.interruptionId}`);
        }
        if (child.state === 'confirmed') {
          throw new Error(`替补 ${child.id} 已经确认，撤销会让已确认安排漂移；如确需调整请对其发起新的中断`);
        }
        if (child.state === 'proposed') {
          events.push({ type: 'SegmentRevoked', planId, segmentId: child.id, at: this.now() });
        }
      }
      events.push({ type: 'SegmentRestored', planId, segmentId: sid, at: this.now() });
      const gapKey = `${interruptionId}:${seg.rootId}`;
      if (this.state.gaps.some((g) => g.planId === planId && g.key === gapKey && !g.resolvedBy)) {
        events.push({ type: 'GapResolved', planId, key: gapKey, at: this.now(), how: 'interruption-revoked' });
      }
    }
    events.push({ type: 'InterruptionClosed', planId, interruptionId, at: this.now(), how: 'revoked' });

    // 在投影副本上验证恢复后的整表可行，再决定提交。
    const projected = this.#project(events);
    const ctx = validateContext(plan.context);
    const violations = validateAll(
      Object.values(projected.segments).filter((s) => s.planId === planId),
      ctx,
      Object.values(projected.segments).filter((s) => s.planId !== planId &&
        (s.state === 'confirmed' || s.state === 'interrupted')),
      this.#teacherBlocks(projected));
    if (violations.length) throw new Error(`撤销后计划不再可行，操作取消: ${JSON.stringify(violations)}`);

    const rec = this.store.commit(events, { actor, note: note ?? `撤销中断 ${interruptionId} 并恢复原安排` });
    reduce(this.state, rec.events, rec);
    return this.planView(planId);
  }

  // ---------- 查询 ----------

  planView(planId, { asOf = this.now() } = {}) {
    const plan = this.#requirePlan(planId);
    const segments = this.#planSegments(planId).map((s) => this.#segmentView(s, asOf));
    const liveSegs = segments.filter((s) => s.state !== 'proposed-cancelled' && s.state !== 'revoked');
    const schools = Object.fromEntries(
      plan.context.schools.map((s) => [s.id, {
        confirmed: plan.confirmations.has(s.id),
        segmentIds: liveSegs.filter((g) => g.schoolId === s.id).map((g) => g.id),
      }]));
    return {
      id: planId,
      state: plan.state,
      createdAt: plan.createdAt,
      segmentCount: liveSegs.length,
      schools,
      segments,
      interruptions: Object.values(this.state.interruptions).filter((i) => i.planId === planId),
      unmet: this.listGaps(planId),
    };
  }

  // 学校视角：只返回本校安排，看不到其他学校与教师在他校的行程。
  schoolView(schoolId) {
    const out = [];
    for (const plan of Object.values(this.state.plans)) {
      if (plan.state === 'superseded') continue;
      if (!plan.context.schools?.some((s) => s.id === schoolId)) continue;
      for (const seg of this.#planSegments(plan.id)) {
        if (seg.schoolId !== schoolId) continue;
        if (seg.state === 'proposed-cancelled' || seg.state === 'revoked') continue;
        out.push({ planId: plan.id, planState: plan.state, ...this.#segmentView(seg, this.now()) });
      }
    }
    return { schoolId, arrangements: out };
  }

  listGaps(planId) {
    this.#requirePlan(planId);
    const plan = this.state.plans[planId];
    return this.state.gaps
      .filter((g) => g.planId === planId && !g.resolvedBy)
      .map((g) => ({ ...g, demand: plan.context.demands.find((x) => x.id === g.demandId) ?? null }));
  }

  // 某次调整影响了谁、为何选择某位替补、还有哪些需求无法满足。
  explainAdjustment(planId, interruptionId) {
    this.#requirePlan(planId);
    const inter = this.state.interruptions[interruptionId];
    if (!inter || inter.planId !== planId) throw new Error(`未知中断: ${interruptionId}`);

    const affectedSegments = [];
    for (const sid of inter.segmentIds) {
      const original = this.#requireSegment(sid, planId);
      const chain = this.#chain(planId, original.rootId);
      const replacement = chain.find((s) => s.seq > 0 && s.interruptionId === interruptionId) || null;
      const openGap = this.state.gaps.find((g) => g.planId === planId && g.key === `${interruptionId}:${original.rootId}` && !g.resolvedBy);
      affectedSegments.push({
        demandId: original.demandId,
        schoolId: original.schoolId,
        originalTeacherId: original.teacherId,
        clippedAt: original.clipEndsAt,
        replacement: replacement && {
          segmentId: replacement.id,
          teacherId: replacement.teacherId,
          state: this.#segmentView(replacement, this.now()).state,
          // 候选打分明细：为何是这位替补。
          rankedCandidates: (replacement.rationale ?? []).map((c) => ({
            teacherId: c.teacherId, rank: c.rank, load: c.load,
            fromSchool: c.fromSchool, inTravelMinutes: c.inTravelMinutes, chosen: c.rank === 1,
          })),
        },
        unmet: openGap ? { reason: openGap.reason, detail: openGap.detail } : null,
      });
    }

    return {
      interruption: { id: inter.id, kind: inter.kind, startsAt: inter.startsAt, endsAt: inter.endsAt, status: inter.status },
      actor: inter.actor ?? null,
      affectedTeacherIds: [...new Set(affectedSegments.flatMap((a) =>
        [a.originalTeacherId, a.replacement?.teacherId].filter(Boolean)))],
      affectedSchoolIds: [...new Set(affectedSegments.map((a) => a.schoolId))],
      segments: affectedSegments,
      // 增量重排只产生本中断关联的片段；显式声明没有其他安排漂移。
      driftPolicy: 'only-interrupted-chains',
    };
  }

  // 某次提交（调整）的变更清单：前后状态对比，回答“影响了谁”。
  commitImpact(commitId) {
    const rec = this.store.committed.find((r) => r.commitId === commitId);
    if (!rec) throw new Error(`未知提交版本: ${commitId}`);
    const before = snapshot(this.store.committed.filter((r) => r.commitId < commitId));
    const after = snapshot(this.store.committed.filter((r) => r.commitId <= commitId));
    const beforeSegs = Object.values(before.segments);
    const afterSegs = Object.values(after.segments);
    const changed = [];
    for (const seg of afterSegs) {
      const old = beforeSegs.find((s) => s.id === seg.id);
      if (!old) changed.push({ segmentId: seg.id, change: 'created', teacherId: seg.teacherId, schoolId: seg.schoolId, state: seg.state });
      else if (old.state !== seg.state || old.clipEndsAt !== seg.clipEndsAt || old.teacherId !== seg.teacherId) {
        changed.push({
          segmentId: seg.id, change: 'updated',
          from: { state: old.state, teacherId: old.teacherId, clipEndsAt: old.clipEndsAt },
          to: { state: seg.state, teacherId: seg.teacherId, clipEndsAt: seg.clipEndsAt },
        });
      }
    }
    for (const old of beforeSegs) {
      if (!afterSegs.some((s) => s.id === old.id)) {
        changed.push({ segmentId: old.id, change: 'removed', teacherId: old.teacherId, schoolId: old.schoolId });
      }
    }
    return { commitId, at: rec.at, note: rec.note, actor: rec.actor, eventCount: rec.events.length, changed };
  }

  // 历史版本列表与任一提交点的复盘。
  history(planId) {
    this.#requirePlan(planId);
    return this.store.committed
      .filter((rec) => rec.events.some((e) => e.planId === planId))
      .map((rec) => ({ commitId: rec.commitId, at: rec.at, note: rec.note, actor: rec.actor, eventTypes: rec.events.map((e) => e.type) }));
  }

  planAt(planId, commitId) {
    this.#requirePlan(planId);
    const snap = snapshot(this.store.committed.filter((r) => r.commitId <= commitId));
    const plan = snap.plans[planId];
    if (!plan) throw new Error(`提交 ${commitId} 时计划 ${planId} 尚不存在`);
    return {
      id: planId, state: plan.state, createdAt: plan.createdAt,
      segments: Object.values(snap.segments).filter((s) => s.planId === planId),
      confirmations: [...plan.confirmations],
    };
  }

  listPlans() {
    return Object.values(this.state.plans).map((p) => ({ id: p.id, state: p.state, createdAt: p.createdAt }));
  }

  // ---------- 内部 ----------

  #idGen(planId) {
    let n = this.#planSegments(planId).length;
    return () => `${planId}-S-${String(++n).padStart(3, '0')}`;
  }

  #nextInterruptionId(planId) {
    const n = Object.values(this.state.interruptions).filter((i) => i.planId === planId).length
      // 同一命令内尚未写入 state 的中断也要占号。
      + this.#pendingInterruptionCount;
    this.#pendingInterruptionCount++;
    return `${planId}-I-${String(n + 1).padStart(3, '0')}`;
  }

  #pendingInterruptionCount = 0;

  #leaveTargets(plan, teacherId, at, endsAt) {
    const t = parse(at);
    // 未给出结束时间的请假视为无限期：该教师此后所有安排都受影响。
    const until = endsAt ? parse(endsAt) : Infinity;
    return this.#planSegments(plan.id)
      .filter((s) => s.teacherId === teacherId && (s.state === 'confirmed' || (s.state === 'proposed' && s.seq > 0)))
      .filter((s) => {
        const st = parse(s.startsAt);
        const en = parse(s.endsAt);
        if (t >= st && t < en) return true;                         // 正在履行/待确认的接续
        return st >= t && st < until;                              // 请假窗口内尚未开始
      })
      .sort((a, b) => parse(a.startsAt) - parse(b.startsAt));
  }

  #isActiveAt(seg, at) {
    const t = parse(at);
    // 已确认片段与待确认的接续候选都可能因请假而再次改派。
    return (seg.state === 'confirmed' || (seg.state === 'proposed' && seg.seq > 0))
      && t >= parse(seg.startsAt) && t < parse(seg.endsAt);
  }

  #clip(seg, at) {
    const t = parse(at);
    return t <= parse(seg.startsAt) ? seg.startsAt : at; // 出发前请假：片段尚未开始，整段让出
  }

  #chain(planId, rootId) {
    return this.#planSegments(planId).filter((s) => s.rootId === rootId)
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  }

  #planSegments(planId) {
    return Object.values(this.state.segments).filter((s) => s.planId === planId);
  }

  // 其他生效计划中仍然占用教师的片段（同一时刻只允许一个生效计划，这里用于草案期预检）。
  #externalLiveSegments(excludePlanId = null) {
    const out = [];
    for (const plan of Object.values(this.state.plans)) {
      if (plan.state !== 'effective' || plan.id === excludePlanId) continue;
      for (const s of Object.values(this.state.segments)) {
        if (s.planId !== plan.id) continue;
        if (s.state === 'confirmed' || s.state === 'interrupted') out.push(s);
      }
    }
    return out;
  }

  // 教师不可用窗口：由开放中的教师级中断推导（请假、资质停教）。
  // 未给出结束时间的请假按“无限期”处理，撤销中断即解除。
  #teacherBlocks(state = this.state) {
    const blocks = new Map();
    for (const inter of Object.values(state.interruptions)) {
      if (inter.status !== 'open' || !inter.teacherId) continue;
      const start = parse(inter.startsAt);
      const end = inter.endsAt ? parse(inter.endsAt) : Infinity;
      const list = blocks.get(inter.teacherId) ?? [];
      list.push({ start, end, reason: inter.kind, qualification: inter.qualification ?? null });
      blocks.set(inter.teacherId, list);
    }
    return blocks;
  }

  #project(events) {
    const projected = snapshot(this.store.committed);
    reduce(projected, events);
    return projected;
  }

  #requirePlan(planId) {
    const p = this.state.plans[planId];
    if (!p) throw new Error(`未知计划: ${planId}`);
    return p;
  }

  #requireEffective(planId) {
    const p = this.#requirePlan(planId);
    if (p.state !== 'effective') throw new Error(`计划 ${planId} 处于 ${p.state}，只有生效计划可以中断`);
    return p;
  }

  #requireSegment(id, planId) {
    const s = this.state.segments[id];
    if (!s || s.planId !== planId) throw new Error(`未知片段: ${id}`);
    return s;
  }

  #segmentView(seg, asOf) {
    let state = seg.state;
    if (state === 'confirmed' && parse(seg.endsAt) <= parse(asOf)) state = 'completed';
    return { ...seg, state, statusAt: asOf };
  }
}

// ---------- 事件回放归约 ----------

function emptyState() {
  return { plans: {}, segments: {}, interruptions: {}, gaps: [] };
}

// 从一组提交重放出完整状态（用于重启加载、历史复盘、撤销预演）。
function snapshot(commits) {
  const state = emptyState();
  for (const rec of commits) reduce(state, rec.events, rec);
  return state;
}

function reduce(state, events, rec = null) {
  for (const e of events) {
    switch (e.type) {
      case 'ContextRecorded':
        if (!state.plans[e.planId]) {
          state.plans[e.planId] = {
            id: e.planId, state: 'draft', createdAt: rec?.at ?? null,
            context: e.context, confirmations: new Set(),
          };
        } else state.plans[e.planId].context = e.context;
        break;
      case 'PlanCreated':
        state.plans[e.planId].state = 'draft';
        state.plans[e.planId].createdAt = e.at;
        break;
      case 'PlanActivated':
        state.plans[e.planId].state = 'effective';
        for (const s of Object.values(state.segments)) {
          if (s.planId === e.planId && s.state === 'proposed') s.state = 'confirmed';
        }
        break;
      case 'PlanSuperseded':
        state.plans[e.planId].state = 'superseded';
        break;
      case 'SchoolConfirmed':
        state.plans[e.planId].confirmations.add(e.schoolId);
        if (state.plans[e.planId].state === 'draft') state.plans[e.planId].state = 'awaiting-school';
        break;
      case 'SegmentProposed':
      case 'ReplacementProposed':
        state.segments[e.segment.id] = { ...e.segment };
        break;
      case 'SegmentCancelled':
        state.segments[e.segmentId].state = 'proposed-cancelled';
        break;
      case 'SegmentRestored': {
        const s = state.segments[e.segmentId];
        if (s.priorStateOnInterruption) {
          // 从一次中断中恢复：回到中断前的状态（已确认或待确认的接续候选）。
          s.state = s.priorStateOnInterruption;
          s.priorStateOnInterruption = null;
        } else {
          s.state = 'proposed'; // 草案候选恢复
        }
        s.clipEndsAt = null;
        break;
      }
      case 'SegmentInterrupted': {
        const s = state.segments[e.segmentId];
        // 连续改派：被再次中断的替补候选本身已挂在前一次中断上，保留原关联，另记新中断。
        if (s.interruptionId && s.interruptionId !== e.interruptionId) {
          s.reInterruptedBy = e.interruptionId;
        } else {
          s.interruptionId = e.interruptionId;
        }
        s.state = 'interrupted';
        s.clipEndsAt = e.clipEndsAt;
        s.priorStateOnInterruption = e.priorState ?? 'confirmed';
        break;
      }
      case 'ReplacementConfirmed':
        state.segments[e.segmentId].state = 'confirmed';
        break;
      case 'SegmentRevoked':
        state.segments[e.segmentId].state = 'revoked';
        break;
      case 'InterruptionRecorded':
        state.interruptions[e.interruption.id] = { ...e.interruption, recordedAt: e.at, actor: rec?.actor ?? null };
        break;
      case 'InterruptionClosed':
        state.interruptions[e.interruptionId].status = 'closed';
        state.interruptions[e.interruptionId].closedAt = e.at;
        state.interruptions[e.interruptionId].closeHow = e.how;
        break;
      case 'RequirementUnmet':
        state.gaps.push({
          planId: e.planId, key: e.gap.key, demandId: e.gap.demandId,
          interruptionId: e.gap.interruptionId, reason: e.gap.reason, detail: e.gap.detail ?? null,
          openedAt: e.at, resolvedBy: null,
        });
        break;
      case 'GapResolved': {
        const g = state.gaps.find((x) => x.planId === e.planId && x.key === e.key && !x.resolvedBy);
        if (g) { g.resolvedBy = e.how; g.resolvedAt = e.at; }
        break;
      }
      default:
        throw new Error(`未知事件类型: ${e.type}`);
    }
  }
  return state;
}

function canonicalContext(ctx) {
  return JSON.parse(JSON.stringify(ctx));
}

function pushBlock(blocks, teacherId, start, end, reason, qualification = null) {
  const list = blocks.get(teacherId) ?? [];
  list.push({ start, end, reason, qualification });
  blocks.set(teacherId, list);
}
