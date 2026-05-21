# task-queue 控制面板 v0.2.0 设计

> **Status**: spec — 待用户审阅后由 writing-plans 转 plan
> **Date**: 2026-05-21
> **作者**: Claude (Opus 4.7) + Seth

---

## 1. 目标与动机

为 task-queue skill 加一个**本地 Web 控制面板**，让用户在浏览器看到：

- 已接入 task-queue 的**所有项目**的实时状态（聚合视图）
- 每个项目的当前 in_progress / 待办 / 待 review / 阻塞 / 今日完成 数量
- 任务列表（按状态分组），可点开看详情：desc、scope、priority、ctime、note、risk、question
- loop 心跳：最近一次唤醒的时间和模型
- **简单写操作**：skip 一条待办、改优先级、pause/resume loop

定位是"运维仪表盘"——给人看的，不替代命令行操作。

## 2. 架构总览

```
┌──────────────────────────────────────────┐
│  Browser (5s polling)                    │
│  http://127.0.0.1:5732                   │
└──────────────┬───────────────────────────┘
               │ HTTP/JSON
┌──────────────▼───────────────────────────┐
│  commands/dashboard.cjs (node:http)      │
│   静态: GET /, /app.js, /styles.css      │
│   读: GET /api/projects                  │
│        GET /api/projects/:slug           │
│   写: POST /api/projects/:slug/skip      │
│        POST /api/projects/:slug/priority │
│        POST /api/projects/:slug/pause    │
│        POST /api/projects/:slug/resume   │
└──────────────┬───────────────────────────┘
               │ fs (with lock)
   ┌───────────┴────────────────────┐
   ▼                                ▼
~/.task-queue/                <root>/.tasks/
  projects.json                 tasks.xlsx
                                run/heartbeat.json
                                run/loop-paused      (flag)
                                run/.xlsx.lock       (lockfile)
```

**核心约束**：
- 零新依赖（`node:http` + 已有 `exceljs`）
- 默认 bind `127.0.0.1`，无认证；`--host 0.0.0.0` 显式才暴露
- 写操作和 loop 共享一把文件锁，避免竞态

## 3. 数据流与关键决策

### 3.1 数据源：每次请求 lazy 读

不引入 daemon / 文件监听。前端 5s 轮询 `/api/projects`，后端每次：
1. 读 `~/.task-queue/projects.json` 得到 projects 列表
2. 对每个 project **并发**读 `.tasks/tasks.xlsx`、`.tasks/run/heartbeat.json`、检查 `.tasks/run/loop-paused`
3. 计算 status 汇总返回 JSON

xlsx 读取走只读路径（`ExcelJS.Workbook.xlsx.readFile`），不占锁——读不需要锁，只有写需要。

### 3.2 写竞态：文件锁

新增 `lib/lock.cjs`：自实现 mkdir 原子锁（不引 `proper-lockfile` 依赖）。

```
function withLock(lockDir, fn) {
  // mkdir 是原子的，存在即抛 EEXIST
  // 自旋等待最多 5s，间隔 100ms
  // 持锁时间过长（>30s）则视为 stale，强制接管
}
```

- 改造 `lib/workbook.cjs::withWorkbook(filePath, mutator)` —— 在 mutator 外层套 `withLock(path.join(dirname(filePath), 'run', '.xlsx.lock'))`
- 所有现有命令（claim/done/review/block/add-row）天然受保护，因为它们都走 withWorkbook
- dashboard 的 skip/priority 也通过 withWorkbook 写入，自动加锁

**stale 锁判定**：lockDir 是 mkdir 出来的目录，里面写 `pid + 时间戳`，超过 30s 自动接管（不杀进程，只接管锁）。

### 3.3 心跳协议（含"任务级状态"）

**核心理念**：心跳不是定时器，而是**状态变更的副作用**。claim/done/review/block 时刻就写心跳，面板能在 5s 轮询窗口内看到 loop 的真实进度。

新增 `lib/heartbeat.cjs::writeHeartbeat(projectRoot, patch)`，写 `.tasks/run/heartbeat.json`：

```json
{
  "ts": "2026-05-21T09:50:00Z",
  "model": "claude-opus-4-7",
  "phase": "executing",
  "currentTaskId": 12,
  "currentTaskDesc": "改 ReqConfig label",
  "lastFinishedId": 11,
  "lastFinishedAt": "2026-05-21T09:48:00Z"
}
```

`phase` 取值：`executing` / `idle` / `sleeping`。`currentTaskId` 仅在 `executing` 时非 null。

**写入时机**（由 CLI 命令副作用触发，无需 loop-prompt 主动调）：

| 触发点 | phase | currentTaskId | 备注 |
|---|---|---|---|
| `claim <id>` 成功 | `executing` | `id` | 用户能立刻在面板看到"#id 开始执行" |
| `done/review/block <id>` 成功 | `idle` | `null` | `lastFinishedId/At` 更新 |
| `next` 返回 null（队列空时） | `sleeping` | `null` | loop 即将 ScheduleWakeup |
| 显式 `heartbeat` 子命令 | `idle` | 不变 | 兜底用，正常流程不调 |

`model` 字段从环境变量 `CLAUDE_MODEL` 读（loop 调用前 export），缺则保留上次值（避免 idle→executing 切换时丢失 model 标签）。

**面板根据 phase + ts 显示**：

- `executing` 且 ts < 90min → 绿色"运行中 #N \<desc\>"
- `idle` 且 ts < 5min → 绿色"刚完成 #N"
- `idle` 且 5-90min → 黄色"等待中"
- `sleeping` 且 ts < 90min → 黄色"队列空，已休眠"
- ts > 90min → 灰色"离线"（视为 loop 挂了，不论 phase）

**为什么这样设计**：

- 不依赖 loop-prompt 主动写 → 减少 loop-prompt 改动面（仅保留 Step 0.5 查 paused）
- claim 那一刻面板就更新 → 满足"知道任务有没有开始"的核心诉求
- done 后立刻 idle → 面板不会停留在"还在跑"的错觉里
- 队列空写 sleeping → 区分"挂了"和"没活干"

### 3.4 pause/resume

新增 flag 文件 `.tasks/run/loop-paused`（存在即暂停，文件内容 = 暂停原因）。

修改 `loop-prompt.md` Step 0 之后增加 Step 0.5：检查 flag，存在则跳到 Step 5 直接 ScheduleWakeup。

面板的 pause 写文件，resume 删文件。**无需走 xlsx 锁**，文件操作天然原子。

**pause 的语义边界**：

- `pause` **只影响下一次 `next`**——正在执行（已 claim 但未 done）的任务继续跑完
- 这样设计避免任务跑到一半被打断、留下脏 git 状态
- 面板 UI 显示要明示："已暂停（当前任务跑完后停下）"

### 3.5 heartbeat 写入失败的容忍

claim/done/review/block 内部调 `writeHeartbeat()` 是 **best-effort**：

- 写心跳异常（磁盘满、权限错）不能让主命令失败
- 内部 try-catch 后 log warn，主流程照常返回
- 面板长时间无心跳本来就会显示"离线"——能自动降级，无需上层处理

## 4. API 设计

### 4.1 `GET /api/projects`

返回所有注册项目的汇总。

```json
{
  "projects": [
    {
      "slug": "para-node-4-0",
      "root": "/Users/seth/Desktop/para/2026/para-node-4.0",
      "name": "para-node-4.0",
      "registeredAt": "2026-05-20T...",
      "phase": "executing",
      "online": "active",
      "lastHeartbeat": "2026-05-21T09:50:00Z",
      "lastModel": "claude-opus-4-7",
      "paused": false,
      "pauseReason": null,
      "counts": { "todo": 3, "in_progress": 1, "review": 2, "blocked": 0, "done_today": 5 },
      "currentTask": { "id": 12, "desc": "改 ReqConfig label", "scope": "web", "priority": "高" },
      "lastFinished": { "id": 11, "at": "2026-05-21T09:48:00Z" }
    }
  ]
}
```

字段映射：

- `phase` 直接来自 `heartbeat.phase`
- `online` 由 `phase + 距 now 时间` 推导（见 §3.3 末端的状态决策表）
- `currentTask` 在 `phase=executing` 时填，否则 null
- `lastFinished` 在 heartbeat 有 `lastFinishedId` 时填，否则 null
- `paused` = `.tasks/run/loop-paused` 文件是否存在；`pauseReason` 读其内容

**slug** = root 末段 + lowercase + 替换非字母数字为 `-`，碰撞时尾追 `-2`/`-3`。注册时计算并写入 projects.json。

### 4.2 `GET /api/projects/:slug`

返回单 project 的完整任务列表（包括已归档当日的）。

```json
{
  "project": { /* 同上 */ },
  "tasks": {
    "in_progress": [{ "id": 12, "desc": "...", "scope": "web", "priority": "高", "ctime": "...", "note": "" }],
    "todo": [...],         // 按 priority 排序
    "review": [...],       // 含 risk 字段
    "blocked": [...],      // 含 question 字段
    "done_today": [...]    // 从归档 sheet 读今日完成
  }
}
```

### 4.3 写操作

| 端点 | body | 行为 |
|---|---|---|
| `POST /api/projects/:slug/skip` | `{ id }` | 状态置 `跳过` |
| `POST /api/projects/:slug/priority` | `{ id, priority: "高"\|"中"\|"低" }` | 改 priority |
| `POST /api/projects/:slug/pause` | `{ reason }` | 写 loop-paused 文件 |
| `POST /api/projects/:slug/resume` | — | 删 loop-paused 文件 |

- 所有写操作 200 = `{ ok: true }`，校验失败 400，project 不存在 404，锁超时 503
- skip/priority 只允许操作 `待办` 状态的行，否则 409 Conflict（防止 in_progress 中途被改）

## 5. 注册表

### 5.1 文件

`~/.task-queue/projects.json`：

```json
{
  "version": 1,
  "projects": [
    {
      "slug": "para-node-4-0",
      "root": "/Users/seth/Desktop/para/2026/para-node-4.0",
      "name": "para-node-4.0",
      "registeredAt": "2026-05-20T13:00:00Z"
    }
  ]
}
```

### 5.2 触发时机

- `init-write` 末尾自动调 `registry.add(root)` —— 已 init 过的项目第二次 init 是幂等的
- 提供手动管理命令：
  - `dashboard register <root>` —— 兜底，针对早期 init 时没 register 的旧项目
  - `dashboard unregister <root>` —— 移除（不删 .tasks/）
  - `dashboard list` —— 列出已注册项目

### 5.3 失联处理

启动 dashboard 时，对每个 project 校验：
1. root 目录存在？
2. `.tasks/tasks.xlsx` 存在？

任一失败标 `online: "missing"`，前端 UI 显示"项目失联"卡片，提供"从面板移除"按钮（调 unregister）。

## 6. 前端

单页应用，零编译，原生 ES 模块。

### 6.1 文件结构

- `web/index.html` —— 骨架 + 引入 app.js / styles.css
- `web/app.js` —— 30-50 行原生 JS：fetch + 渲染 + 5s 轮询
- `web/styles.css` —— 20-30 行布局，深色主题

### 6.2 布局

```
┌───────────────────────────────────────────────┐
│  task-queue dashboard                  [⟳]    │
├─────────────────┬─────────────────────────────┤
│  PROJECTS       │  para-node-4.0 ● active     │
│  ─────────      │  in_progress: 1             │
│  ● para-node-4-0│  ┌─ 当前任务 ─────────┐    │
│    1 进行中      │  │ #12 改 ReqConfig... │    │
│  ◐ another-proj │  │ scope: web 高       │    │
│    3 待办        │  └────────────────────┘    │
│  ○ stale-proj   │                              │
│    离线          │  待办 (3) ▼                  │
│                 │  待 review (2) ▼             │
│                 │  阻塞 (0)                    │
│                 │  今日完成 (5) ▼              │
│                 │                              │
│                 │  [pause loop]                │
└─────────────────┴─────────────────────────────┘
```

- 左侧项目列表，点击切换
- 右侧详情：当前任务（in_progress）卡片 + 分组列表（折叠）
- 每条任务右侧三按钮：`改优先级` / `skip` / `详情`
- 右下角 pause/resume 按钮

### 6.3 状态色

- 绿色：active / 待办（高）
- 黄色：idle / 待 review
- 红色：阻塞
- 灰色：offline / 已归档

## 7. 启动入口

```
node ~/.claude/skills/task-queue/tasks.cjs dashboard [--port 5732] [--host 127.0.0.1]
```

- 默认 `127.0.0.1:5732`（5732 是 task-q 的字符位移 t=20,a=1,s=19,k=11 → 5732 较低冲突区段）
- 启动时打印 `dashboard ready at http://127.0.0.1:5732`
- 收到 SIGINT/SIGTERM 优雅退出
- **不**自动打开浏览器（避免不同平台兼容问题；用户自己复制 URL）

## 8. 安全

- 默认仅监听 loopback，不接收外部连接
- `--host 0.0.0.0` 显式后才开放，但仍无认证 —— 文档明示"仅供局域网信任环境"
- 输入校验：slug 用正则 `^[a-z0-9-]+$`；id 必须是数字；priority 必须在白名单
- 静态文件路径 join 后做 `startsWith(webRoot)` 防止穿越

## 9. 文件清单

### 9.1 新建

```
commands/
  dashboard.cjs           # 入口 + 子命令派发（list/register/unregister/serve）
  dashboard-server.cjs    # http 服务（被 dashboard.cjs 调用）
  heartbeat.cjs           # heartbeat 子命令实现
lib/
  registry.cjs            # ~/.task-queue/projects.json 读写
  lock.cjs                # mkdir 文件锁（30 行内）
  heartbeat.cjs           # heartbeat 文件读写
web/
  index.html
  app.js
  styles.css
tests/
  lib.lock.test.cjs       # 锁的获取/释放/stale 接管
  lib.registry.test.cjs   # 注册表 add/remove/list 幂等
  lib.heartbeat.test.cjs
  commands.heartbeat.test.cjs
  commands.dashboard-register.test.cjs
  commands.dashboard-unregister.test.cjs
  commands.dashboard-list.test.cjs
  dashboard-server.api.test.cjs   # 启动 server 跑 HTTP fetch 验 API
```

### 9.2 改动

```
lib/workbook.cjs          # withWorkbook 套 lock
commands/init-write.cjs   # 末尾自动 registry.add
commands/claim.cjs        # 成功后 writeHeartbeat(phase=executing, currentTaskId)
commands/done.cjs         # 成功后 writeHeartbeat(phase=idle, lastFinishedId)
commands/review.cjs       # 成功后 writeHeartbeat(phase=idle, lastFinishedId)
commands/block.cjs        # 成功后 writeHeartbeat(phase=idle, lastFinishedId)
commands/next.cjs         # 返回 null 时 writeHeartbeat(phase=sleeping)
loop-prompt.md            # 加 Step 0.5（查 paused）；不再需要主动写 heartbeat
tasks.cjs                 # 注册 dashboard / heartbeat 子命令
SKILL.md                  # 用户喊词表 + 子命令一览同步更新
```

## 10. 取舍与未来工作

**v0.2.0 不做**：

- WebSocket / SSE 实时推送 —— 5s 轮询足够，多 project 也不会刷爆
- 跨 project 任务依赖 / 并行 —— 用户问题 #2 回答："不支持，先不引入"
- 鉴权 —— 本地工具，不暴露公网
- 历史趋势图 / 速率统计 —— 留 v0.3.0
- 在面板直接加任务 —— `add-row` CLI 已够用，避免重复实现
- 从面板手动 done 一条任务 —— 容易跟 loop 状态冲突，先不开放
- VS Code 集成 —— 与 skill 跨平台理念冲突

**风险与缓解**：

- **同 project 多 loop 同时跑**：仍不安全，但 v0.2.0 加锁后从"互相覆盖"变成"互相阻塞"——可观察、可恢复。文档明示"建议单 loop"。
- **xlsx 大表格读取慢**：当任务数过千时单次刷新可能 >200ms；前端可加 loading 态，后端缓存归档 sheet（每分钟失效）—— v0.2.0 仅做前端 loading，缓存留观察。
- **heartbeat 漏写**：loop 异常退出会留旧 ts，面板看着像"刚活跃"——通过 `> 90min` 强降级 + 文档说明缓解。

## 11. 验收标准

v0.2.0 交付时应能：

1. `tasks.cjs dashboard` 启动后浏览器访问 `127.0.0.1:5732` 看到至少一个已注册项目
2. **对该项目 `claim <id>` 成功后 5s 内**，面板对应卡片显示"运行中 #id <desc>"
3. 同条任务 `done` 后 5s 内，面板卡片切换为"刚完成 #id"
4. 对该项目跑一次 `add-row` + `claim` + `done`，面板 5s 内刷新到对应状态计数
5. 在面板点 "skip" 一条待办，对应行从 todo 消失（状态变 `跳过`），且 loop 下次 `next` 不取它
6. 在面板点 "pause"，loop 下次唤醒立刻跳到 Step 5 ScheduleWakeup（不取任务），点 "resume" 后恢复
7. 改优先级：高 → 低后，loop 的 `next` 顺序按新优先级走
8. 把项目目录改名（模拟失联），面板显示该卡片为 "missing" 状态，"移除"按钮可调通
9. 单进程内并发 2 个 `done` 命令（手工测试）—— 第二个等锁 ~50ms 后正常完成，无写冲突
10. 全套测试通过 + dashboard 集成测试至少 6 个用例
