// 时间、路程缓冲与休息间隔的纯函数。入参为毫秒时间戳或可解析的时间串，
// 输出（除标注外）为毫秒。绝不做基于时钟小时数的判断，因此跨午夜天然正确。

export const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

export function ts(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const n = Date.parse(value);
  if (Number.isNaN(n)) throw new TypeError(`无法解析时间: ${String(value)}`);
  return n;
}

export function overlap(startA, endA, startB, endB) {
  return Math.max(startA, startB) < Math.min(endA, endB);
}

// 两个占用之间是否满足最低休息间隔。占用包含首尾路程，相邻时必须
// endA + rest <= startB（或反向）。同一教师同一校区可背靠背（路程为 0）。
export function restGapSufficient(endA, startB, minRestMs) {
  return startB - endA >= minRestMs;
}

// 路程矩阵查询。矩阵以 "A|B" 形式存储（校区 id 按字典序排列），缺对角线视为 0。
// 无法到达（Infinity / -1）返回 null。
export function travelMinutes(matrix, fromSchool, toSchool) {
  if (fromSchool === toSchool) return 0;
  const key = [fromSchool, toSchool].sort().join('|');
  const raw = matrix?.[key];
  if (raw === undefined || raw === null || raw < 0) return null;
  return raw;
}

// 一次赴任的完整占用窗口：出发（含缓冲）至返回（含缓冲）。
// 教师居住校为 homeSchool；缓冲在到校与离校两端各加一次。
export function travelWindow(demand, matrix, homeSchool, bufferMs) {
  const going = travelMinutes(matrix, homeSchool, demand.school);
  if (going === null) return null;
  const lead = going * MS.minute + bufferMs;
  const trailing = lead; // 对称缓冲，返程同样需要
  return {
    travelMinutesEachWay: going,
    busyStart: ts(demand.startsAt) - lead,
    busyEnd: ts(demand.endsAt) + trailing,
    serviceStart: ts(demand.startsAt),
    serviceEnd: ts(demand.endsAt),
  };
}
