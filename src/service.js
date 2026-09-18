// 应用服务层：每个用例对应一次 store.mutate 事务，事务内追加审计事件。
// 任何一步抛错，整笔回滚（含批量确认与生效），磁盘上不会出现半套计划。
import { Store } from './store.js';
import { DomainError } from './domain.js';
import * as eng from './engine.js';

export class SchedulerService {
  constructor(dbPath) {
    this.store = new Store(dbPath);
  }

  async init() { await this.store.load(); return this; }

  #record(state, type, planId, details = {}, impact = null) {
    const seq = ++state.meta.counters.event;
    const event = { seq, type, planId, details, impact, at: new Date().toISOString() };
    state.events.push(event);
    return event;
  }

  async #tx(label, fn) {
    return this.store.mutate(async (state) => {
      const gen = (kind, prefix) => this.store.nextId(state, kind, prefix);
      const out = await fn(state, gen);
      if (!out.event) throw new Error(`用例 ${label} 未记录事件`);
      return out;
    });
  }

  // ----- 基础资料 -----
  async registerSchool(school) {
    return this.#tx('registerSchool', (state) => {
      const saved = eng.upsertSchool(state, school);
      return { school: saved, event: this.#record(state, 'school-registered', null, { schoolId: saved.id }) };
    });
  }

  async registerTeacher(teacher) {
    return this.#tx('registerTeacher', (state) => {
      const saved = eng.upsertTeacher(state, teacher);
      return { teacher: saved, event: this.#record(state, 'teacher-registered', null, { teacherId: saved.id, homeSchool: saved.homeSchool, qualifications: saved.qualifications }) };
    });
  }

  async addDemand(demand) {
    return this.#tx('addDemand', (state) => {
      const d = eng.upsertDemand(state, demand);
      return { demand: d, event: this.#record(state, 'demand-added', null, { demandId: d.id, school: d.school, qualification: d.qualification }) };
    });
  }

  async setTravel(schoolA, schoolB, minutes) {
    return this.#tx('setTravel', (state) => {
      if (!state.schools[schoolA] || !state.schools[schoolB]) throw new DomainError('unknown-school', '路程两端的学校必须先登记');
      eng.setTravelEntry(state, schoolA, schoolB, minutes);
      return { travelMinutes: minutes, event: this.#record(state, 'travel-set', null, { between: [schoolA, schoolB].sort(), minutes }) };
    });
  }

  async setPolicy(patch) {
    return this.#tx('setPolicy', (state) => {
      Object.assign(state.policies, patch);
      return { policy: { ...state.policies }, event: this.#record(state, 'policy-set', null, { patch }) };
    });
  }

  // ----- 草案与确认 -----
  async createDraft(input = {}) {
    return this.#tx('createDraft', (state, gen) => {
      const plan = eng.generatePlan(state, gen, input);
      return {
        plan,
        event: this.#record(state, 'draft-generated', plan.id,
          { demandIds: input.demandIds ?? null, assignments: plan.assignments.length, unmet: plan.unmet.length },
          { assignmentIds: plan.assignments.map((a) => a.id) }),
      };
    });
  }

  async submit(planId) {
    return this.#tx('submit', (state) => {
      const plan = eng.submitPlan(state, planId);
      return { plan, event: this.#record(state, 'submitted-for-confirmation', planId, {}, { assignmentIds: plan.assignments.map((a) => a.id) }) };
    });
  }

  async confirm(planId, schoolId, assignmentIds = null) {
    return this.#tx('confirm', (state) => {
      const { plan, confirmed } = eng.confirmBySchool(state, planId, schoolId, assignmentIds);
      return { plan, confirmed, event: this.#record(state, 'school-confirmed', planId, { schoolId, assignmentIds: confirmed }, { sourcePlanId: planId, assignmentIds: confirmed }) };
    });
  }

  async effectuate(planId) {
    return this.#tx('effectuate', (state) => {
      // 先在副本上跑完整个生效流程；失败会直接抛错，状态与事件都不落盘。
      const plan = eng.effectuatePlan(state, planId);
      return {
        plan,
        event: this.#record(state, 'plan-effectuated', planId, { effectiveAt: plan.effectiveAt },
          { sourcePlanId: planId, assignmentIds: plan.assignments.map((a) => a.id) }),
      };
    });
  }

  // ----- 请假与替补 -----
  async interrupt(input) {
    return this.#tx('interrupt', (state) => {
      const { plan, assignments } = eng.interrupt(state, input);
      return {
        plan, assignments,
        event: this.#record(state, 'assignment-interrupted', plan.id,
          { kind: input.kind ?? 'leave', teacherId: input.teacherId ?? null, startsAt: input.startsAt ?? input.leaveStartsAt, endsAt: input.endsAt ?? input.leaveEndsAt, reason: input.reason ?? null },
          { sourcePlanId: plan.id, assignmentIds: assignments.map((a) => a.id) }),
      };
    });
  }

  async repair(planId, input = {}) {
    return this.#tx('repair', (state, gen) => {
      const plan = eng.repairPlan(state, gen, planId, input);
      const parentId = plan.revisionOfId;
      return {
        plan,
        event: this.#record(state, 'plan-repaired', plan.id,
          { parentPlanId: parentId, carried: plan.assignments.filter((a) => a.carriedConfirmation).length, rescheduled: plan.assignments.filter((a) => !a.carriedConfirmation).length, unmet: plan.unmet.length },
          { sourcePlanId: parentId, assignmentIds: plan.assignments.map((a) => a.id) }),
      };
    });
  }

  // ----- 撤销 / 恢复 -----
  async cancelPlan(planId, reason = null) {
    return this.#tx('cancelPlan', (state) => {
      const plan = eng.cancelPlan(state, planId, { reason });
      return { plan, event: this.#record(state, 'plan-cancelled', planId, { reason, fromState: plan.stateBeforeCancel }, { sourcePlanId: planId, assignmentIds: plan.assignments.map((a) => a.id) }) };
    });
  }

  async restorePlan(planId) {
    return this.#tx('restorePlan', (state) => {
      const plan = eng.restorePlan(state, planId);
      return { plan, event: this.#record(state, 'plan-restored', planId, { toState: plan.state }, { sourcePlanId: planId, assignmentIds: plan.assignments.map((a) => a.id) }) };
    });
  }

  async cancelAssignment(assignmentId, reason = null) {
    return this.#tx('cancelAssignment', (state) => {
      const { plan, assignment } = eng.cancelAssignment(state, assignmentId, { reason });
      return { plan, assignment, event: this.#record(state, 'assignment-cancelled', plan.id, { assignmentId, reason }, { sourcePlanId: plan.id, assignmentIds: [assignmentId] }) };
    });
  }

  async restoreAssignment(assignmentId) {
    return this.#tx('restoreAssignment', (state) => {
      const { plan, assignment } = eng.restoreAssignment(state, assignmentId);
      return { plan, assignment, event: this.#record(state, 'assignment-restored', plan.id, { assignmentId }, { sourcePlanId: plan.id, assignmentIds: [assignmentId] }) };
    });
  }

  // ----- 查询（只读，直接读已落盘状态）-----
  #s() { return this.store.state; }

  getPlan(planId) { return eng.getPlan(this.#s(), planId); }
  listPlans() {
    return Object.values(this.#s().plans).map((p) => ({
      id: p.id, name: p.name, state: p.state, revisionNo: p.revisionNo, revisionOfId: p.revisionOfId ?? null,
      createdAt: p.createdAt, effectiveAt: p.effectiveAt ?? null, assignments: p.assignments.length, unmet: p.unmet.length,
    }));
  }
  versionChain(planId) {
    const s = this.#s();
    let cur = eng.getPlan(s, planId);
    while (cur.revisionOfId) cur = s.plans[cur.revisionOfId];
    const chain = [];
    for (;;) {
      chain.push({ id: cur.id, state: cur.state, revisionNo: cur.revisionNo, createdAt: cur.createdAt, effectiveAt: cur.effectiveAt ?? null });
      const next = Object.values(s.plans).find((p) => p.revisionOfId === cur.id);
      if (!next) break;
      cur = next;
    }
    return chain;
  }
  schoolView(schoolId) { return eng.schoolArrangements(this.#s(), schoolId); }
  unmet() { return eng.unmetReport(this.#s()); }
  impact(ref) { return eng.adjustmentImpact(this.#s(), ref); }
  rationale(assignmentId) {
    const { plan, assignment } = eng.findAssignment(this.#s(), assignmentId);
    return { planId: plan.id, assignment: { id: assignment.id, teacherId: assignment.teacherId, school: assignment.school, demandId: assignment.demandId, startsAt: assignment.startsAt, endsAt: assignment.endsAt, state: assignment.state, travelMinutesEachWay: assignment.travelMinutesEachWay, busyStart: assignment.busyStart, busyEnd: assignment.busyEnd }, rationale: assignment.rationale ?? null };
  }
  events({ planId = null, limit = 100 } = {}) {
    const all = this.#s().events.filter((e) => !planId || e.planId === planId || e.impact?.sourcePlanId === planId);
    return all.slice(-limit);
  }
  // 重启后复盘：返回某历史版本完整快照与当时事件。
  historicalSnapshot(planId) {
    const plan = eng.getPlan(this.#s(), planId);
    const events = this.#s().events.filter((e) => e.planId === planId || e.impact?.sourcePlanId === planId);
    return { plan, events };
  }
}
