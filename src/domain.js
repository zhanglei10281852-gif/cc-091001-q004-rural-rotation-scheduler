// 轮岗领域的统一枚举与默认策略。所有时间在存储层均为带偏移量的 ISO 8601 字符串，
// 计算时统一换算为毫秒时间戳，因此跨午夜不会按“当天时钟”误判。

export const scheduleStates = ['draft', 'awaiting-school', 'effective', 'superseded'];
export const interruptionKinds = ['leave', 'school-closure', 'qualification-change'];
export const demandPriorities = ['normal', 'important', 'critical'];
// cancelled 不在最早的四态里：撤销是可恢复的挂起态，恢复后回到 cancelledFromState。
export const assignmentStates = ['proposed', 'confirmed', 'interrupted', 'completed', 'cancelled'];

// 法定休息间隔默认取 11 小时；最低连续服务周期默认 2 个自然日；可被计划/需求级配置覆盖。
export const policyDefaults = {
  minRestMinutes: 11 * 60,
  minContinuousMinutes: 2 * 24 * 60,
  travelBufferMinutes: 0,
};

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    Object.assign(this, details);
  }
}

export const priorityRank = (p) => {
  const i = demandPriorities.indexOf(p);
  return i === -1 ? demandPriorities.length : i;
};

// 可被校方确认、可被排程引擎提交的占用态。
export const ACTIVE_ASSIGNMENT_STATES = ['proposed', 'confirmed', 'interrupted', 'completed'];
export const LOCKED_ASSIGNMENT_STATES = ['confirmed', 'interrupted', 'completed'];

export function requireState(plan, allowed, operation) {
  if (!allowed.includes(plan.state)) {
    throw new DomainError(
      'illegal-state',
      `计划 ${plan.id} 当前为 ${plan.state}，不能执行 ${operation}`,
      { current: plan.state, allowed },
    );
  }
}
