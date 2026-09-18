# 跨校支教轮岗调度

县域教育共同体骨干教师跨校轮岗的排程服务。零三方依赖，Node.js 20+ 内置 `node:test` / `node:http`。

## 解决的问题

- **可执行计划先行**：依据教师资质、校区需求、课程时段、最低连续服务周期与路程矩阵生成草案；不可达、周期不足、无人胜任或休息间隔不够的需求进入未满足清单并附逐条原因。
- **最小改派、不漂移**：请假中断后生成修订版（revision），未受影响的已确认安排原样携带（教师、时段、占用窗口均不变），只为中断起的剩余时段挑选替补；已确认安排不会因无关变更漂移。
- **跨午夜与法定休息**：全部时间按毫秒时间戳比较，占用窗口 = 授课时段 ±（路程 + 缓冲），相邻两段之间强制最低休息间隔（默认 11 小时）。
- **不重复占用**：同一教师时间窗重叠（含路程/请假/缓冲）一律拒绝，拒绝原因记录在 `rationale.rejected`。
- **原子提交**：每个用例在深拷贝上执行，整体通过才落盘（临时文件 + rename）；批量确认、生效复检失败时磁盘与内存都不留下半套计划。
- **校方隔离**：校方密钥只能查看/确认本校安排；完整候选与落选原因（含其他教师信息）仅协调员可见。
- **可复盘**：JSON 文件持久化，重启后历史版本（含已被取代的 superseded 版本）与审计事件链均可查询。

## 计划生命周期

```
draft ──submit──▶ awaiting-school ──全校确认──▶ effective
                     ▲                            │ 请假/停课/资质变更
                     └──── restore（撤销恢复）      ▼
                                           interrupted
                                                │ repair
                                                ▼
                              修订版 awaiting-school（未受影响确认沿用）
                                                │ 受影响学校确认 + effectuate
                                                ▼
                          effective（旧版变 superseded，保留可复盘）
```

计划与单条分配均可 `cancel` / `restore`，恢复时做冲突复检。

## 运行

```bash
npm test                 # 14 项测试（含原基线格式校验）
COORDINATOR_KEY=secret \
SCHOOL_KEYS='S-RURAL-1=k1,S-RURAL-2=k2' \
ROTATION_DB=./data/rotation.json PORT=8080 \
  npm start
```

## HTTP 接口

协调员请求带 `x-coordinator-key`；校方请求带 `x-school-key`（只能访问本校）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/admin/schools` `/admin/teachers` `/admin/demands` | 登记学校/教师/需求 |
| POST | `/admin/travel` | 路程矩阵条目（`minutes: null` 表示不可达） |
| POST | `/admin/policy` | 调整 `minRestMinutes` / `minContinuousMinutes` / `travelBufferMinutes` |
| POST | `/plans` | 生成草案（可带 `demandIds` 只排部分需求） |
| POST | `/plans/:id/submit` | 提交校方确认 |
| POST | `/plans/:id/confirmations` | 校方确认（校方密钥自动绑定本校；可带 `assignmentIds` 批量确认） |
| POST | `/plans/:id/effectuate` | 全部确认后原子生效（含冲突复检） |
| POST | `/interruptions` | 请假中断（`planId` + `teacherId`/`assignmentId` + 时段） |
| POST | `/plans/:id/repair` | 生成最小改派修订版 |
| POST | `/plans/:id/cancel` `/restore` | 计划撤销/恢复 |
| POST | `/assignments/:id/cancel` `/restore` | 单条分配撤销/恢复 |
| GET | `/plans` `/plans/:id` `/plans/:id/chain` `/plans/:id/history` | 计划、版本链、历史快照 |
| GET | `/events/:seq/impact` | 某次调整影响了谁（changed / unchanged 分组） |
| GET | `/assignments/:id/rationale` | 为何选这位教师（排序依据、备选、全部落选原因） |
| GET | `/unmet` | 还有哪些需求无法满足及原因 |
| GET | `/schools/:id/arrangements` | 校方查询（仅本校、脱敏） |

## 模块

- `src/domain.js`：状态枚举、策略默认值、错误类型
- `src/time.js`：时间窗、跨午夜、路程矩阵、缓冲与休息间隔
- `src/store.js`：JSON 原子持久化与事务边界
- `src/engine.js`：排程、冲突检测、确认/生效、中断接续、撤销恢复、查询
- `src/service.js`：用例事务包装与审计事件
- `src/server.js`：HTTP 与密钥鉴权
- `fixtures/rotation-context.json`：资料样例（教师资质 / 校区需求 / 路程）

所有时间均采用带偏移量的 ISO 8601 字符串，路程分钟数表示校门到校门的常规耗时。各学校的实际人员信息与连接配置只能保存在受控环境中。
