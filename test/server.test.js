import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createApp } from '../src/server.js';

const file = `/tmp/rotation-http-${process.pid}.jsonl`;

const ctx = {
  teachers: [
    { id: 'T-01', qualifications: ['math-middle'], homeSchool: 'S-CENTRAL' },
    { id: 'T-02', qualifications: ['math-middle'], homeSchool: 'S-CENTRAL' },
  ],
  schools: [{ id: 'S-CENTRAL' }, { id: 'S-RURAL-1' }, { id: 'S-RURAL-2' }],
  demands: [
    { id: 'D-1', school: 'S-RURAL-1', qualification: 'math-middle',
      startsAt: '2026-09-14T08:00:00+08:00', endsAt: '2026-09-18T17:00:00+08:00', priority: 'critical' },
    { id: 'D-2', school: 'S-RURAL-2', qualification: 'math-middle',
      startsAt: '2026-09-21T08:00:00+08:00', endsAt: '2026-09-25T17:00:00+08:00' },
  ],
  travelMatrix: {
    'S-CENTRAL': { 'S-RURAL-1': 45, 'S-RURAL-2': 70 },
    'S-RURAL-1': { 'S-CENTRAL': 45, 'S-RURAL-2': 30 },
    'S-RURAL-2': { 'S-CENTRAL': 70, 'S-RURAL-1': 30 },
  },
  minContiguousDays: 3,
  minRestMinutes: 600,
  travelBufferMinutes: 20,
};

async function withServer(fn) {
  rmSync(file, { force: true });
  const { server } = createApp({ storeFile: file, now: () => '2026-09-01T08:00:00+08:00' });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(port, method, path, { role = 'coordinator', schoolId, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (role) headers['x-role'] = role;
  if (schoolId) headers['x-school-id'] = schoolId;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('完整 HTTP 流程：建草案→校方确认→生效→请假→替补确认', async () => {
  await withServer(async (port) => {
    const created = await call(port, 'POST', '/plans', { body: { planId: 'P1', context: ctx } });
    assert.equal(created.status, 200);
    assert.equal(created.json.state, 'draft');

    const conf = await call(port, 'POST', '/plans/P1/confirmations', { body: { schoolIds: ['S-RURAL-1', 'S-RURAL-2'] } });
    assert.equal(conf.status, 200);

    const act = await call(port, 'POST', '/plans/P1/activate');
    assert.equal(act.json.state, 'effective');

    const d1 = act.json.segments.find((s) => s.demandId === 'D-1');
    const leave = await call(port, 'POST', '/plans/P1/interruptions/leave',
      { body: { teacherId: d1.teacherId, at: '2026-09-16T10:00:00+08:00' } });
    assert.equal(leave.status, 200);
    const rep = leave.json.plan.segments.find((s) => s.seq === 1);

    const confirmRep = await call(port, 'POST', `/plans/P1/replacements/${rep.id}/confirm`,
      { role: 'school', schoolId: 'S-RURAL-1', body: { schoolId: 'S-RURAL-1' } });
    assert.equal(confirmRep.status, 200);

    const explain = await call(port, 'GET', `/plans/P1/interruptions/${leave.json.interruptionIds[0]}/explain`);
    assert.equal(explain.json.segments[0].replacement.teacherId, rep.teacherId);
  });
});

test('学校角色不能访问协调员接口', async () => {
  await withServer(async (port) => {
    const r = await call(port, 'POST', '/plans', { role: 'school', schoolId: 'S-RURAL-1', body: { context: ctx } });
    assert.equal(r.status, 403);
  });
});

test('学校查询只返回本校安排，且不能冒充他校', async () => {
  await withServer(async (port) => {
    await call(port, 'POST', '/plans', { body: { planId: 'P1', context: ctx } });
    await call(port, 'POST', '/plans/P1/confirmations', { body: { schoolIds: ['S-RURAL-1', 'S-RURAL-2'] } });
    await call(port, 'POST', '/plans/P1/activate');

    const mine = await call(port, 'GET', '/schools/S-RURAL-1/arrangements', { role: 'school', schoolId: 'S-RURAL-1' });
    assert.equal(mine.status, 200);
    assert.equal(mine.json.arrangements.length, 1);
    assert.equal(mine.json.arrangements[0].schoolId, 'S-RURAL-1');
    // 看不到他校任何信息：返回体只有本校一条
    assert.ok(mine.json.arrangements.every((a) => a.schoolId === 'S-RURAL-1'));

    const spoof = await call(port, 'GET', '/schools/S-RURAL-2/arrangements', { role: 'school', schoolId: 'S-RURAL-1' });
    assert.equal(spoof.status, 403);
  });
});

test('校方只能确认本校替补片段', async () => {
  await withServer(async (port) => {
    await call(port, 'POST', '/plans', { body: { planId: 'P1', context: ctx } });
    await call(port, 'POST', '/plans/P1/confirmations', { body: { schoolIds: ['S-RURAL-1', 'S-RURAL-2'] } });
    await call(port, 'POST', '/plans/P1/activate');
    const plan = (await call(port, 'GET', '/plans/P1')).json;
    const d1 = plan.segments.find((s) => s.demandId === 'D-1');
    const leave = await call(port, 'POST', '/plans/P1/interruptions/leave',
      { body: { teacherId: d1.teacherId, at: '2026-09-16T10:00:00+08:00' } });
    const rep = leave.json.plan.segments.find((s) => s.seq === 1);
    const other = await call(port, 'POST', `/plans/P1/replacements/${rep.id}/confirm`,
      { role: 'school', schoolId: 'S-RURAL-2', body: { schoolId: 'S-RURAL-2' } });
    assert.equal(other.status, 403);
  });
});

test('缺口与历史版本可通过 HTTP 查询', async () => {
  await withServer(async (port) => {
    const tight = JSON.parse(JSON.stringify(ctx));
    tight.teachers = tight.teachers.slice(0, 1); // 只留一名教师
    // 两条需求同期重叠：单人无法同时驻两校，必有一条无法满足
    tight.demands[1].startsAt = tight.demands[0].startsAt;
    tight.demands[1].endsAt = tight.demands[0].endsAt;
    await call(port, 'POST', '/plans', { body: { planId: 'P1', context: tight } });
    const gaps = await call(port, 'GET', '/plans/P1/gaps');
    assert.ok(gaps.json.gaps.length >= 1);
    const history = await call(port, 'GET', '/plans/P1/history');
    assert.ok(history.json.versions.length >= 1);
  });
});
