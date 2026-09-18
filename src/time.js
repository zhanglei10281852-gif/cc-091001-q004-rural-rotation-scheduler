// 统一的时间工具：所有排程时间均为带偏移量的 ISO 8601 字符串，内部用 epoch 毫秒计算，
// 因此跨午夜的行程只是普通的毫秒加减，不会出现“日期翻篇算错”的问题。

export function parse(ts) {
  if (typeof ts !== 'string') throw new Error(`时间必须是 ISO 字符串，收到 ${typeof ts}`);
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new Error(`无法解析的时间: ${ts}`);
  return ms;
}

const DAY_MS = 86_400_000;

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

// 时间戳自带偏移量下的本地日历日序号（用于“最低连续服务周期”按天计数）。
export function dayIndexLocal(iso) {
  return Math.floor((parse(iso) + offsetMinutes(iso) * 60_000) / DAY_MS);
}

// 区间 [startsAt, endsAt) 覆盖的本地日历日数量；以起始时间的偏移量为准。
// 周一 08:00 ~ 周三 17:00 => 3 天；恰好在午夜结束不另计一天。
export function countServiceDays(startsAt, endsAt) {
  const off = offsetMinutes(startsAt) * 60_000;
  const first = Math.floor((parse(startsAt) + off) / DAY_MS);
  const last = Math.floor((parse(endsAt) - 1 + off) / DAY_MS);
  return last - first + 1;
}

function offsetMinutes(iso) {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`无法解析的时间: ${iso}`);
  if (!m[7] || m[7] === 'Z') return 0;
  const sign = m[7][0] === '-' ? -1 : 1;
  const hours = Number(m[7].slice(1, 3));
  const minutes = Number(m[7].length >= 5 ? m[7].slice(-2) : 0);
  return sign * (hours * 60 + minutes);
}

// 按时间戳自带的偏移量取本地日历日，返回 YYYY-MM-DD。
// 夜间课 23:30+08:00 与其后 00:30 的行程属于同一个工作日，次日 08:00 的课属于下一个工作日。
export function localDate(iso) {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`无法解析的时间: ${iso}`);
  let offsetMin = 0;
  if (m[7] && m[7] !== 'Z') {
    const sign = m[7][0] === '-' ? -1 : 1;
    const hours = Number(m[7].slice(1, 3));
    const minutes = Number(m[7].length >= 5 ? m[7].slice(-2) : 0);
    offsetMin = sign * (hours * 60 + minutes);
  }
  const shifted = new Date(parse(iso) + offsetMin * 60_000);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

// 半开区间 [start, end)：首尾相接不算占用冲突，休息间隔另行校验。
export function overlaps(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}

export function minutesBetween(aIso, bIso) {
  return Math.round((parse(bIso) - parse(aIso)) / 60_000);
}

export function assertChronological(label, startsAt, endsAt) {
  if (parse(endsAt) <= parse(startsAt)) {
    throw new Error(`${label}: 结束时间必须晚于开始时间 (${startsAt} ~ ${endsAt})`);
  }
}
