// 输入资料的校验与规整。业务资料包括：教师资质、校区需求、课程时段、
// 最低连续服务周期（天）与路程矩阵（校门到校门的分钟数）。
import { parse, assertChronological } from './time.js';
import { demandPriorities } from './domain.js';

export function validateContext(ctx) {
  const errors = [];
  const teachers = new Map();
  const schools = new Map();
  const demands = new Map();

  if (!ctx || typeof ctx !== 'object') throw new Error('排程上下文必须是对象');

  for (const t of ctx.teachers ?? []) {
    if (!t || typeof t.id !== 'string') { errors.push('教师缺少 id'); continue; }
    if (teachers.has(t.id)) { errors.push(`教师 id 重复: ${t.id}`); continue; }
    if (!Array.isArray(t.qualifications) || t.qualifications.length === 0) {
      errors.push(`教师 ${t.id} 缺少资质`);
    }
    if (t.homeSchool !== undefined && typeof t.homeSchool !== 'string') {
      errors.push(`教师 ${t.id} 的 homeSchool 必须是字符串`);
    }
    teachers.set(t.id, {
      id: t.id,
      name: t.name ?? t.id,
      qualifications: [...new Set(t.qualifications ?? [])],
      homeSchool: t.homeSchool ?? null,
    });
  }

  for (const s of ctx.schools ?? []) {
    if (!s || typeof s.id !== 'string') { errors.push('学校缺少 id'); continue; }
    if (schools.has(s.id)) { errors.push(`学校 id 重复: ${s.id}`); continue; }
    schools.set(s.id, { id: s.id, name: s.name ?? s.id });
  }

  for (const d of ctx.demands ?? []) {
    if (!d || typeof d.id !== 'string') { errors.push('需求缺少 id'); continue; }
    if (demands.has(d.id)) { errors.push(`需求 id 重复: ${d.id}`); continue; }
    try {
      assertChronological(`需求 ${d.id}`, d.startsAt, d.endsAt);
      parse(d.startsAt);
    } catch (e) { errors.push(e.message); continue; }
    if (!schools.has(d.school)) errors.push(`需求 ${d.id} 引用了未知学校: ${d.school}`);
    if (typeof d.qualification !== 'string') errors.push(`需求 ${d.id} 缺少资质`);
    const priority = d.priority ?? 'normal';
    if (!demandPriorities.includes(priority)) {
      errors.push(`需求 ${d.id} 优先级非法: ${priority}`);
    }
    demands.set(d.id, {
      id: d.id,
      school: d.school,
      qualification: d.qualification,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
      priority,
    });
  }

  const travel = {};
  if (ctx.travelMatrix && typeof ctx.travelMatrix === 'object') {
    for (const [a, row] of Object.entries(ctx.travelMatrix)) {
      if (!row || typeof row !== 'object') { errors.push(`路程矩阵行 ${a} 不是对象`); continue; }
      for (const [b, minutes] of Object.entries(row)) {
        if (!Number.isFinite(minutes) || minutes < 0) {
          errors.push(`路程 ${a}->${b} 必须是非负数字`);
          continue;
        }
        travel[key(a, b)] = Math.round(minutes);
      }
    }
  }

  const minContiguousDays = toFinite(ctx.minContiguousDays, 1);
  if (minContiguousDays < 1) errors.push('minContiguousDays 必须 >= 1');
  const minRestMinutes = toFinite(ctx.minRestMinutes, 0);
  const travelBufferMinutes = toFinite(ctx.travelBufferMinutes, 0);

  if (errors.length) throw new Error(`资料校验失败:\n- ${errors.join('\n- ')}`);

  return {
    teachers,
    schools,
    demands,
    travel,
    minContiguousDays: Math.max(1, Math.round(minContiguousDays)),
    minRestMinutes: Math.max(0, Math.round(minRestMinutes)),
    travelBufferMinutes: Math.max(0, Math.round(travelBufferMinutes)),
  };
}

function toFinite(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

// 路程矩阵的键：校门到校门。同校为 0，缺省按 null 处理（不可达）。
function key(a, b) { return a + '->' + b; }

export function travelMinutes(travel, fromSchool, toSchool) {
  if (fromSchool === toSchool) return 0;
  const v = travel[key(fromSchool, toSchool)];
  return Number.isFinite(v) ? v : null;
}
