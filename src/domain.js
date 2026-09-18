// 轮岗计划的统一领域枚举。
// 计划阶段：草案 → 等待校方确认 → 生效；被新一期计划替代后为 superseded。
export const scheduleStates = ['draft', 'awaiting-school', 'effective', 'superseded'];

// 中断原因：教师请假、学校停课/封闭、资质变更。
export const interruptionKinds = ['leave', 'school-closure', 'qualification-change'];

export const demandPriorities = ['normal', 'important', 'critical'];

// 片段状态：proposed 草案候选 → confirmed 已确认（随计划生效）；
// interrupted 被中断（clipEndsAt 之前的部分已履行）；completed 按自然时间结束；
// proposed-cancelled 为可恢复的撤销中间态；revoked 为随中断撤销而作废的替补候选。
export const assignmentStates = [
  'proposed',
  'confirmed',
  'interrupted',
  'completed',
  'proposed-cancelled',
  'revoked',
];

export const roles = ['coordinator', 'school'];
