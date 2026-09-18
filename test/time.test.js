import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, localDate, countServiceDays, overlaps } from '../src/time.js';

test('跨午夜的时间差按毫秒计算，日期翻篇不影响', () => {
  assert.equal(
    parse('2026-09-15T00:30:00+08:00') - parse('2026-09-14T23:30:00+08:00'),
    60 * 60_000,
  );
});

test('本地日历日按时间戳自带偏移量计算', () => {
  // 同一时刻在不同偏移量下属不同日历日
  assert.equal(localDate('2026-09-14T23:30:00+08:00'), '2026-09-14');
  assert.equal(localDate('2026-09-14T23:30:00+00:00'), '2026-09-14');
  assert.equal(localDate('2026-09-15T00:30:00+08:00'), '2026-09-15');
  assert.equal(localDate('2026-09-14T16:30:00+00:00'), '2026-09-14'); // +08 已翻篇，但以自身偏移为准
});

test('最低连续服务周期按本地日历日计数，午夜整点结束不另计一天', () => {
  assert.equal(countServiceDays('2026-09-14T08:00:00+08:00', '2026-09-14T17:00:00+08:00'), 1);
  assert.equal(countServiceDays('2026-09-14T08:00:00+08:00', '2026-09-16T17:00:00+08:00'), 3);
  assert.equal(countServiceDays('2026-09-14T08:00:00+08:00', '2026-09-17T00:00:00+08:00'), 3);
  // 跨午夜的晚课：23:00 到次日 01:00 覆盖两个本地日
  assert.equal(countServiceDays('2026-09-14T23:00:00+08:00', '2026-09-15T01:00:00+08:00'), 2);
});

test('半开区间首尾相接不算冲突', () => {
  assert.ok(overlaps([0, 10], [10, 20]) === false);
  assert.ok(overlaps([0, 11], [10, 20]) === true);
});

test('非法时间被拒绝', () => {
  assert.throws(() => parse('not-a-time'));
  assert.throws(() => localDate('2026-13-40T99:99:00'));
});
