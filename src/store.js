// JSON 文件持久化。每次提交的变更整体写入（临时文件 + rename），
// 因此“批量确认/生效”要么整包落盘，要么完全不写，不会留下半套计划。
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { policyDefaults } from './domain.js';

export function emptyState() {
  return {
    meta: { counters: { plan: 0, assignment: 0, demand: 0, event: 0 }, persistedAt: null },
    policies: { ...policyDefaults },
    teachers: {},
    schools: {},
    demands: {},
    travelMatrix: {},
    plans: {},
    events: [],
  };
}

export class Store {
  constructor(file) {
    this.file = file;
    this.state = emptyState();
    this.loaded = false;
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      this.state = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.state = emptyState();
    }
    this.loaded = true;
    return this.state;
  }

  async #persist() {
    this.state.meta.persistedAt = new Date().toISOString();
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state), 'utf8');
    await rename(tmp, this.file);
  }

  // 在深拷贝上执行变更；fn 抛错则状态与磁盘都不变（事务边界）。
  // fn 返回 {event, impact} 等附加信息，最终一并回传给调用方。
  async mutate(fn) {
    if (!this.loaded) await this.load();
    const next = structuredClone(this.state);
    const result = (await fn(next)) ?? {};
    this.state = next;
    await this.#persist();
    return result;
  }

  nextId(state, kind, prefix) {
    const n = ++state.meta.counters[kind];
    return `${prefix}${String(n).padStart(4, '0')}`;
  }
}
