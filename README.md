# 跨校支教轮岗调度

县域教育共同体骨干教师跨校支教的排程服务。输入教师资质、校区需求、课程时段、最低连续服务周期与校门到校门的路程矩阵，系统先给出**可执行的轮岗草案**；在请假、停课、资质变更时**只重排受影响的需求链**，已确认的安排不会无故漂移；全部历史版本随事件日志持久化，重启后可复盘到任一提交点。

- 运行环境：Node.js 20+，无第三方依赖
- 校验：`npm test`（基于 `node:test`，39 个用例）
- 启动：`npm start`（默认 `PORT=3000`，日志位置由 `ROTATION_STORE` 指定，默认 `./data/rotation.jsonl`）

## 业务规则

| 规则 | 实现位置与行为 |
| --- | --- |
| 资质匹配 | 只有具备需求所要求资质的教师才能入选 |
| 不重复占用 | 每名教师一条时间线，授课区间重叠即冲突 |
| 交通缓冲 | 相邻两段不同学校之间必须容纳 `路程 + travelBufferMinutes` |
| 法定休息 | 间隙还须不少于 `minRestMinutes`（默认 10 小时），跨午夜按毫秒连续计算 |
| 路程矩阵 | 校门到校门分钟数；矩阵缺项视为**不可达**；同校交接不产生行程 |
| 最低连续服务周期 | 完整驻校需求覆盖的本地日历日数不得少于 `minContiguousDays`；请假后的接续片段不受此限 |
| 不可用窗口 | 请假教师（或资质停教的相应学科）在开放中断期间不会被再次分配 |
| 关键优先 | 草案按 critical > important > normal、再按开始时间排序逐需求安排 |
| 无静默丢弃 | 排不进去的需求进入 `unmet` 缺口清单，附全部候选被拒原因 |

所有时间均为带偏移量的 ISO 8601 字符串。日历日（连续服务周期）按时间戳**自身偏移量**计算；行程与休息间隔按 epoch 毫秒计算，因此 23:30 下课、次日 00:30 的行程只是普通的 60 分钟间隙。

## 计划生命周期

```
草案 draft ──首批校方确认──▶ awaiting-school ──全部相关学校确认──▶ 生效 effective
  │  （可撤销/恢复候选）                                        │
  │                                                  请假 / 停课 / 资质变更
  │                                                             ▼
  │                                              原片段 interrupted（剪断）
  │                                                   + 替补片段 proposed（仅受影响需求链）
  │                                                             │
  │                                              校方确认替补 → confirmed
  │                                              撤销中断 → 原片段恢复、替补 revoked
新一期计划生效时，旧计划 → superseded（历史仍可复盘）
```

**原子性**：每个命令（批量确认、生效、一次请假引发的多条改派）都是**一个提交、多个事件**，提交前完成全部校验，校验失败不写任何事件——不会留下半套生效计划。存储层为单行 JSON 追加写，整笔记录原子可见。

**增量、无漂移**：中断只剪断受影响片段并沿该需求的 `rootId` 链生成接续片段；其他片段的教师与时间永不改变。已确认的替补不能被“撤销”悄悄撤回（那会让已确认安排漂移），如需调整请对替补发起新的中断；连续改派必须从最近一次中断逐层往回撤。

## HTTP 接口

角色通过请求头区分：`x-role: coordinator`（协调员，全权）或 `x-role: school` + `x-school-id: <本校ID>`（校方，只能访问本校数据）。

### 协调员

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /plans` | 提交业务资料生成草案；body：`{planId?, context}` |
| `GET  /plans` / `GET /plans/:id` | 计划列表 / 计划详情（片段、确认情况、中断、缺口） |
| `POST /plans/:id/confirmations` | 批量校方确认；body：`{schoolIds:[...]}`，任一违例整批退回 |
| `POST /plans/:id/activate` | 全部相关学校确认后生效（同时作废旧计划） |
| `POST /plans/:id/segments/:sid/cancel` `/restore` | 草案候选的撤销与恢复 |
| `POST /plans/:id/interruptions/leave` | 教师请假；`{teacherId, at, endsAt?}`，无 `endsAt` 即无限期（覆盖其后所有安排） |
| `POST /plans/:id/interruptions/closure` | 学校停课；`{schoolId, at, endsAt?}` |
| `POST /plans/:id/interruptions/qualification` | 资质变更；`{teacherId, qualification, at}` |
| `POST /plans/:id/interruptions/:iid/revoke` | 撤销中断、恢复原安排（替补须尚未确认） |
| `GET  /plans/:id/interruptions/:iid/explain` | **影响了谁、为何选这位替补（候选打分明细）、还有哪些需求无法满足** |
| `GET  /commits/:n/impact` | 某次提交的精确变更片段清单 |
| `GET  /plans/:id/gaps` | 未满足需求清单及原因 |
| `GET  /plans/:id/history` / `/plans/:id/versions/:n` | 历史版本列表 / 复盘到第 n 个提交 |

### 校方

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /schools/:schoolId/arrangements` | **只返回本校安排**；以凭据中的学校为准，查询他校返回 403 |
| `POST /plans/:id/replacements/:sid/confirm` | 确认本校替补片段；片段归属以服务端记录为准，不能替他校确认 |

### 快速体验

```bash
npm start &
curl -s localhost:3000/plans -H 'content-type: application/json' \
  -d "{\"planId\":\"P1\",\"context\":$(cat fixtures/county-context.example.json)}"
curl -s -X POST localhost:3000/plans/P1/confirmations \
  -H 'content-type: application/json' -d '{"schoolIds":["S-RURAL-1","S-RURAL-2"]}'
curl -s -X POST localhost:3000/plans/P1/activate
curl -s -X POST localhost:3000/plans/P1/interruptions/leave \
  -H 'content-type: application/json' -d '{"teacherId":"T-301","at":"2026-09-16T10:00:00+08:00"}'
```

## 代码结构

```
src/
  domain.js    状态与原因枚举
  time.js      ISO 时间解析、本地日历日/连续服务天数、跨午夜间隔
  model.js     业务资料校验、路程矩阵
  scheduler.js 教师时间线、冲突/路程/休息/资质/不可用窗口校验、确定性候选评分
  engine.js    状态机与全部命令（先校验后单提交）、中断/替补/撤销、影响分析、历史回放
  store.js     追加式 JSONL 事件日志（整笔原子写，重启回放）
  server.js    无依赖 HTTP JSON 服务与角色控制
fixtures/      rotation-context.json（基线资料）、county-context.example.json（完整示例）
test/          time / scheduler / engine / server 四组测试
```

## 部署注意

各学校的实际人员信息与连接配置只能保存在受控环境中；生产部署应将 `x-role`/`x-school-id` 头替换为网关注入的认证身份，事件日志文件应放在受控目录并纳入备份。
