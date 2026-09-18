// 极简 HTTP 接口，零三方依赖。
// 鉴权：x-coordinator-key 拥有全部协调员接口；x-school-key 必须匹配
// SCHOOL_KEYS 中 "<学校id>=<key>" 的登记，且只能访问本校数据。
import { createServer } from 'node:http';
import { SchedulerService } from './service.js';
import { DomainError } from './domain.js';

const STATUS = {
  'bad-input': 400, 'empty-plan': 400,
  'unconfirmed-assignments': 409, 'illegal-state': 409, 'not-confirmable': 409,
  'no-impact': 409, 'nothing-to-repair': 409,
  'conflict-at-effectuation': 409, 'restore-conflict': 409,
  'unknown-school': 404, 'unknown-plan': 404, 'unknown-assignment': 404,
  'unknown-demand': 404, 'not-found': 404,
  'travel-unreachable': 422,
  'forbidden-school': 403,
};

export async function createApp({ dbPath, coordinatorKey, schoolKeys = {} }) {
  const service = await new SchedulerService(dbPath).init();

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) reject(new DomainError('bad-input', '请求体过大')); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new DomainError('bad-input', '请求体不是合法 JSON')); }
    });
  });

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;
    try {
      const cKey = req.headers['x-coordinator-key'];
      const sKey = req.headers['x-school-key'];
      const isCoord = coordinatorKey && cKey === coordinatorKey;
      const schoolForKey = Object.entries(schoolKeys).find(([, k]) => k === sKey)?.[0] ?? null;

      const route = (pattern) => {
        const m = p.match(pattern);
        return m && m.groups ? { ...m.groups } : null;
      };

      // ---- 校方接口：只返回本校安排；密钥学校与查询学校必须一致 ----
      if (method === 'GET') {
        let r;
        if ((r = route(/^\/schools\/(?<id>[^/]+)\/arrangements$/))) {
          if (!schoolForKey) throw new DomainError('forbidden-school', '该接口需校方密钥');
          if (schoolForKey !== r.id) throw new DomainError('forbidden-school', `此密钥属于 ${schoolForKey}，不能查询 ${r.id} 的安排`);
          return send(res, 200, service.schoolView(r.id));
        }
        // 以下均为协调员专属只读接口；持校方密钥或无密钥一律 403。
        const requireCoord = () => { if (!isCoord) throw new DomainError('forbidden-school', '该接口仅限协调员'); };
        if (p === '/plans') { requireCoord(); return send(res, 200, { plans: service.listPlans() }); }
        if (p === '/unmet') { requireCoord(); return send(res, 200, service.unmet()); }
        if (p === '/events') { requireCoord(); return send(res, 200, { events: service.events({ planId: url.searchParams.get('planId') }) }); }
        if ((r = route(/^\/plans\/(?<id>[^/]+)$/))) { requireCoord(); return send(res, 200, service.getPlan(r.id)); }
        if ((r = route(/^\/plans\/(?<id>[^/]+)\/history$/))) { requireCoord(); return send(res, 200, service.historicalSnapshot(r.id)); }
        if ((r = route(/^\/plans\/(?<id>[^/]+)\/chain$/))) { requireCoord(); return send(res, 200, { chain: service.versionChain(r.id) }); }
        if ((r = route(/^\/events\/(?<seq>\d+)\/impact$/))) { requireCoord(); return send(res, 200, service.impact({ eventSeq: Number(r.seq) })); }
        if ((r = route(/^\/assignments\/(?<id>[^/]+)\/rationale$/))) { requireCoord(); return send(res, 200, service.rationale(r.id)); }
      }

      if (method === 'POST') {
        // 校方确认：协调员或本校密钥均可；其他写接口仅协调员。
        let r;
        if ((r = route(/^\/plans\/(?<id>[^/]+)\/confirmations$/))) {
          const body = await readBody(req);
          if (!isCoord) {
            if (!schoolForKey) throw new DomainError('forbidden-school', '确认需要协调员或校方密钥');
            if (body.schoolId && body.schoolId !== schoolForKey) throw new DomainError('forbidden-school', '不能替其他学校确认');
            body.schoolId = schoolForKey;
          } else if (!body.schoolId) {
            throw new DomainError('bad-input', '协调员代为确认时需提供 schoolId');
          }
          const out = await service.confirm(r.id, body.schoolId, body.assignmentIds ?? null);
          return send(res, 200, { plan: out.plan, confirmed: out.confirmed });
        }
        if (!isCoord) throw new DomainError('forbidden-school', '写操作需要协调员密钥');
        const body = await readBody(req);
        if (p === '/admin/schools') return send(res, 201, { school: (await service.registerSchool(body)).school });
        if (p === '/admin/teachers') return send(res, 201, { teacher: (await service.registerTeacher(body)).teacher });
        if (p === '/admin/demands') return send(res, 201, { demand: (await service.addDemand(body)).demand });
        if (p === '/admin/travel') return send(res, 201, await service.setTravel(body.schoolA, body.schoolB, body.minutes));
        if (p === '/admin/policy') return send(res, 200, await service.setPolicy(body));
        if (p === '/plans') return send(res, 201, { plan: (await service.createDraft(body)).plan });
        if ((r = route(/^\/plans\/(?<id>[^/]+)\/submit$/))) return send(res, 200, { plan: (await service.submit(r.id)).plan });
        if ((r = route(/^\/plans\/(?<id>[^/]+)\/effectuate$/))) return send(res, 200, { plan: (await service.effectuate(r.id)).plan });
        if ((r = route(/^\/plans\/(?<id>[^/]+)\/cancel$/))) return send(res, 200, { plan: (await service.cancelPlan(r.id, body.reason ?? null)).plan });
        if ((r = route(/^\/plans\/(?<id>[^/]+)\/restore$/))) return send(res, 200, { plan: (await service.restorePlan(r.id)).plan });
        if ((r = route(/^\/plans\/(?<id>[^/]+)\/repair$/))) return send(res, 201, { plan: (await service.repair(r.id, body)).plan });
        if (p === '/interruptions') return send(res, 201, await service.interrupt(body));
        if ((r = route(/^\/assignments\/(?<id>[^/]+)\/cancel$/))) return send(res, 200, await service.cancelAssignment(r.id, body.reason ?? null));
        if ((r = route(/^\/assignments\/(?<id>[^/]+)\/restore$/))) return send(res, 200, await service.restoreAssignment(r.id));
      }
      send(res, 404, { error: 'not-found', message: `无此接口: ${method} ${p}` });
    } catch (err) {
      if (err instanceof DomainError) {
        const { name, code, message, ...details } = err;
        return send(res, STATUS[code] ?? 400, { error: code, message, ...(Object.keys(details).length ? { details } : {}) });
      }
      send(res, 500, { error: 'internal', message: err.message });
    }
  };

  const server = createServer(handler);
  server.service = service;
  return server;
}

function parseSchoolKeys(raw) {
  const out = {};
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, key] = part.split('=');
    if (id && key) out[id] = key;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await createApp({
    dbPath: process.env.ROTATION_DB ?? './data/rotation.json',
    coordinatorKey: process.env.COORDINATOR_KEY ?? 'dev-coordinator',
    schoolKeys: parseSchoolKeys(process.env.SCHOOL_KEYS),
  });
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => console.log(JSON.stringify({ listening: port, db: process.env.ROTATION_DB ?? './data/rotation.json' })));
}
