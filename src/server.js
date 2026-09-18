// 无第三方依赖的 HTTP JSON 服务。
// 角色：coordinator（协调员，全权）与 school（校方，仅能访问 x-school-id 指定的本校数据）。
import { createServer } from 'node:http';
import { EventStore } from './store.js';
import { RotationEngine } from './engine.js';

export function createApp({ storeFile = process.env.ROTATION_STORE ?? './data/rotation.jsonl', now } = {}) {
  const store = new EventStore(storeFile, now ? { now } : {});
  const engine = new RotationEngine(store, now ? { now } : {});

  const routes = [
    ['POST', /^\/plans$/, coordinator((ctx) => {
      const body = ctx.body ?? {};
      return engine.createPlan(body.context, { planId: body.planId, actor: ctx.actor, note: body.note });
    })],
    ['GET', /^\/plans$/, coordinator(() => ({ plans: engine.listPlans() }))],
    ['GET', /^\/plans\/([^/]+)$/, coordinator((ctx, m) => engine.planView(m[1]))],
    ['POST', /^\/plans\/([^/]+)\/confirmations$/, coordinator((ctx, m) => {
      const ids = ctx.body?.schoolIds;
      if (!Array.isArray(ids) || ids.length === 0) throw httpError(400, 'schoolIds 必须是非空数组');
      return engine.confirmSchools(m[1], ids, { actor: ctx.actor, note: ctx.body?.note });
    })],
    ['POST', /^\/plans\/([^/]+)\/activate$/, coordinator((ctx, m) =>
      engine.activate(m[1], { actor: ctx.actor, note: ctx.body?.note }))],
    ['POST', /^\/plans\/([^/]+)\/segments\/([^/]+)\/cancel$/, coordinator((ctx, m) =>
      engine.cancelDraftSegment(m[1], m[2], { actor: ctx.actor }))],
    ['POST', /^\/plans\/([^/]+)\/segments\/([^/]+)\/restore$/, coordinator((ctx, m) =>
      engine.restoreDraftSegment(m[1], m[2], { actor: ctx.actor }))],
    ['POST', /^\/plans\/([^/]+)\/interruptions\/leave$/, coordinator((ctx, m) =>
      engine.interruptTeacherLeave(m[1], requireBody(ctx.body, 'teacherId'),
        { at: requireField(ctx.body, 'at'), endsAt: ctx.body.endsAt ?? null, kind: ctx.body.kind ?? 'leave' },
        { actor: ctx.actor, note: ctx.body.note }))],
    ['POST', /^\/plans\/([^/]+)\/interruptions\/closure$/, coordinator((ctx, m) =>
      engine.interruptSchoolClosure(m[1], requireField(ctx.body, 'schoolId'),
        { at: requireField(ctx.body, 'at'), endsAt: ctx.body.endsAt ?? null },
        { actor: ctx.actor, note: ctx.body.note }))],
    ['POST', /^\/plans\/([^/]+)\/interruptions\/qualification$/, coordinator((ctx, m) =>
      engine.interruptQualificationChange(m[1],
        requireField(ctx.body, 'teacherId'), requireField(ctx.body, 'qualification'),
        requireField(ctx.body, 'at'), { actor: ctx.actor, note: ctx.body.note }))],
    // 替补确认：协调员可代操作；校方只能确认本校片段（以片段实际归属为准，不认自报）。
    ['POST', /^\/plans\/([^/]+)\/replacements\/([^/]+)\/confirm$/, (ctx, m) => {
      const schoolId = requireField(ctx.body, 'schoolId');
      const plan = engine.planView(m[1]);
      const seg = plan.segments.find((s) => s.id === m[2]);
      if (!seg) throw httpError(404, `未知片段: ${m[2]}`);
      if (ctx.role === 'school') {
        if (ctx.schoolId !== seg.schoolId) throw httpError(403, '校方只能确认本校安排');
      } else if (ctx.role !== 'coordinator') throw httpError(403, '未知角色');
      return engine.confirmReplacement(m[1], m[2], seg.schoolId, { actor: ctx.actor, note: ctx.body?.note });
    }],
    ['POST', /^\/plans\/([^/]+)\/interruptions\/([^/]+)\/revoke$/, coordinator((ctx, m) =>
      engine.revokeInterruption(m[1], m[2], { actor: ctx.actor, note: ctx.body?.note }))],
    ['GET', /^\/plans\/([^/]+)\/interruptions\/([^/]+)\/explain$/, coordinator((ctx, m) =>
      engine.explainAdjustment(m[1], m[2]))],
    ['GET', /^\/plans\/([^/]+)\/gaps$/, coordinator((ctx, m) => ({ planId: m[1], gaps: engine.listGaps(m[1]) }))],
    ['GET', /^\/plans\/([^/]+)\/history$/, coordinator((ctx, m) => ({ planId: m[1], versions: engine.history(m[1]) }))],
    ['GET', /^\/plans\/([^/]+)\/versions\/(\d+)$/, coordinator((ctx, m) => engine.planAt(m[1], Number(m[2])))],
    ['GET', /^\/commits\/(\d+)\/impact$/, coordinator((ctx, m) => engine.commitImpact(Number(m[1])))],
    // 学校查询：只返回本校安排。
    ['GET', /^\/schools\/([^/]+)\/arrangements$/, (ctx, m) => {
      if (ctx.role !== 'school') throw httpError(403, '请以校方身份查询');
      if (ctx.schoolId !== m[1]) throw httpError(403, '校方只能查询本校安排');
      return engine.schoolView(m[1]);
    }],
    ['GET', /^\/health$/, () => ({ ok: true })],
  ];

  const server = createServer(async (req, res) => {
    try {
      const ctx = { role: req.headers['x-role'] ?? 'coordinator', schoolId: req.headers['x-school-id'] ?? null, actor: req.headers['x-actor'] ?? null, body: null };
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST') ctx.body = await readJson(req);
      for (const [method, re, handler] of routes) {
        if (method !== req.method) continue;
        const m = re.exec(url.pathname);
        if (!m) continue;
        const data = handler(ctx, m);
        return send(res, 200, data);
      }
      send(res, 404, { error: '未找到接口', path: url.pathname });
    } catch (e) {
      const status = e.statusCode ?? 400;
      send(res, status, { error: e.message });
    }
  });

  return { server, engine };
}

function coordinator(fn) {
  return (ctx, m) => {
    if (ctx.role !== 'coordinator') throw httpError(403, '该接口仅协调员可用');
    return fn(ctx, m);
  };
}

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function requireBody(body, field) {
  if (!body || typeof body[field] !== 'string') throw httpError(400, `缺少字段 ${field}`);
  return body[field];
}

function requireField(body, field) {
  if (!body || body[field] === undefined || body[field] === null) throw httpError(400, `缺少字段 ${field}`);
  return body[field];
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5_000_000) reject(httpError(413, '请求体过大')); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(httpError(400, '非法 JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

// 直接运行时启动服务：node src/server.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const { server } = createApp();
  server.listen(port, () => console.log(JSON.stringify({ listening: port })));
}
