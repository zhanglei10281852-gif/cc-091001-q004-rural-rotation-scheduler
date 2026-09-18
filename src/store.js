// 追加式事件日志。每个“提交”是一行 JSON（内含一个或多个事件）：
// 一次 writeFileSync(O_APPEND) 完成，要么整笔落盘，要么完全不存在——
// 批量确认失败时绝不会留下半套生效计划。重启后逐行回放即可得到全部历史版本。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class EventStore {
  constructor(file, { now = () => new Date().toISOString() } = {}) {
    this.file = file;
    this.now = now;
    this.committed = []; // [{commitId, at, actor, note, events:[...]}]
    this.#seq = 0;
  }

  #seq; // 序号按日志文件独立计数，重启回放后从文件内最大值续号。

  load() {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim());
    const commits = [];
    for (const [i, line] of lines.entries()) {
      let rec;
      try { rec = JSON.parse(line); }
      catch (e) { throw new Error(`事件日志第 ${i + 1} 行损坏: ${e.message}`); }
      if (!rec || !Array.isArray(rec.events)) throw new Error(`事件日志第 ${i + 1} 行缺少 events`);
      commits.push(rec);
      this.#seq = Math.max(this.#seq, rec.commitId);
    }
    this.committed = commits;
    return commits;
  }

  // 同步原子提交。Node 单线程内调用方串行执行；调用方必须在 commit 之前完成全部校验，
  // 校验失败直接抛错，不进入本方法，因此不会写入任何事件。
  commit(events, meta = {}) {
    if (!Array.isArray(events) || events.length === 0) throw new Error('空提交被拒绝');
    const rec = {
      commitId: ++this.#seq,
      at: meta.at ?? this.now(),
      actor: meta.actor ?? null,
      note: meta.note ?? null,
      events,
    };
    mkdirSync(dirname(this.file) || '.', { recursive: true });
    // 单行 JSON + 单次追加写：整笔记录对读进程要么可见要么不可见。
    writeFileSync(this.file, JSON.stringify(rec) + '\n', { flag: 'a' });
    this.committed.push(rec);
    return rec;
  }
}
