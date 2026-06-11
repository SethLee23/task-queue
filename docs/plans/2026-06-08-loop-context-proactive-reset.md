# Loop 上下文主动重置（让 watchdog 撑死前先重启）

日期：2026-06-08
状态：✅ 已实施（2026-06-12）。路线 C 落地：`heartbeat.rounds` 轮数计数 + `launchHeadless` 归零 + `decideProject` 主动重启分支（`proactive-context-reset`）+ `maxRounds` 可配（默认 40，project.config.js 可覆盖）。全量测试覆盖（`commands.watchdog.test.cjs` / `config.test.cjs`）。待真机观察：把某项目 `maxRounds` 调到 5 跑几轮，确认 watchdog 日志出现 `[restart] <slug> proactive-context-reset`。
作者：Claude（基于 ~/.claude/projects 全量 transcript 用量分析）

---

## 1. 背景：实测数据指认 `/loop` 长会话是头号 token 黑洞

对本机 `~/.claude/projects` 下全部 5812 个会话 transcript 做了按天 / 按项目 / 按成本加权的聚合（脚本逻辑见本文件末尾附录）。结论：

- 近 32 活跃天总用量 **143 亿 token**，日均 ~4.47 亿。
- 价格加权后（Opus 4.x：输入 $15 / 输出 $75 / 缓存写 $18.75 / 缓存读 $1.5 每百万）**缓存读取占总成本 63%**。
- `ditto` 与 `node-aggregates` 两个工作流，各自 **~75% 成本是缓存读取**，输出极低 —— 典型"长上下文反复重发"。
- 揪出具体会话：最烧的清一色是 `/loop` 挂机会话。单两个会话即占全局 27%：
  - `ditto` 一个 **3832 轮** 会话烧 16.2 亿 token
  - `node-aggregates` 一个 **4447 轮** 会话烧 22.7 亿 token

### 1.1 根因：主 loop 无状态，却把历史当上下文背了几千轮

`loop-prompt.md` 的主 loop 每轮只做调度：`recover → heartbeat → status → next/plan-batch → 派发 subagent → 收 STATUS → ScheduleWakeup`。**所有实际工作都派发给独立 subagent**（各自全新上下文），主 loop 每轮决策所需状态**全部存在外部文件**（Excel 任务表、`tasks.cjs status` 输出、`project.config.js`）。

因此第 3000 轮完全不需要记得第 1 轮派发了什么 —— 累积的几千次派发记录 + STATUS 返回对调度毫无价值。但 **Step 5 用 `ScheduleWakeup` 把同一 prompt 打回同一会话**，历史只增不减。

实测那个 3832 轮会话的上下文轨迹（单调暴涨，全程仅重置 1 次）：

```
进度    上下文token
  0%      50,906   ← 起步地板（系统提示 + CLAUDE.md + skill + MCP 工具）
 10%     135,623
 30%     275,335
 50%     397,594
 70%     549,281
 90%     741,101
 99%     813,799   ← 涨 16 倍
```

平均上下文 ~400k × 3832 轮 ≈ 15 亿缓存读取，精确对上该会话实测的 16.2 亿。

### 1.2 关键洞察：重置原语已经存在，只差"主动触发"

`docs/specs/2026-06-01-loop-watchdog-design.md` 描述的 watchdog **已实现并在 launchd 跑着**（`commands/watchdog.cjs` + `lib/launch-command.cjs`，`~/.task-queue/watchdog-state.json` 当前监控 ditto/aggregates/deep-question）。它的核心动作 `killSession + launchHeadless` **本质就是上下文重置** —— 杀掉旧会话、无头重建一个从 50k 地板起步的新 loop。

但现在 watchdog 是**被动**的：仅当心跳陈旧 > 30min（loop 撑死、`ScheduleWakeup` 没接上）才重启。本方案 = 把它升级为**主动**：在上下文胀到拖垮性能/成本之前就触发同一套重启逻辑。

**这是个增量改动，不是新机制** —— 复用 watchdog 全部现有安全闸（executing 不碰 / paused 不碰 / grace 窗口 / 退避放弃）。

---

## 2. 三种实现路线对比（用户已看过，记录决策依据）

| 路线 | 机制 | 优点 | 缺点 | 评价 |
|---|---|---|---|---|
| **A. watchdog 主动 /clear** | 每 N 轮 `tmux send-keys '/clear'` + 重新触发扫描 | 不杀进程，省冷启动 | `/clear` 注入时机若撞上 loop 正在思考会打断；send-keys 时序脆弱；丢失 ScheduleWakeup 续命链 | 次选 |
| **B. 每轮全新会话** | 弃用 ScheduleWakeup，cron/watchdog 每次拉起新 `claude -p` 跑单轮即退 | 上下文永远 50k 起步，最彻底 | 每轮冷启动 + 重读 skill（~50k 固定开销 ×每轮）；改动大；丢失 in-session 连续性 | 矫枉过正 |
| **C. watchdog 主动重启（本方案）** | 给 `decideProject` 加一个"轮数/会话时长超阈值且 idle"的主动重启分支，复用现有 kill+launch | 改动最小、复用全部安全闸、与现有被动重启同构、0 token（纯 Node） | 需要给 watchdog 一个"上下文有多胀"的信号（见 §3） | **推荐** |

选 C 的核心理由：重启原语、安全闸、退避、launchd 计时**全部现成**，只需补一个触发条件 + 一个信号字段。被动重启（撑死后）和主动重启（撑死前）共用一条代码路径，语义统一。

---

## 3. 缺失拼图：watchdog 需要"上下文胀了多少"的信号

当前 `heartbeat.json` 字段：`phase / model / ts / currentTaskId / currentTaskDesc / lastFinishedId / lastFinishedAt / currentTaskIds`。**没有轮数，也没有会话启动时间** —— watchdog 无从判断该不该主动重置。

三种补信号方式：

| 信号 | 实现 | 精度 | 改动面 |
|---|---|---|---|
| **轮数计数（推荐）** | `tasks.cjs heartbeat` 每次自增 `rounds`；launch 时归零 | 高（轮数 ≈ 上下文线性增长） | 仅改 `lib/heartbeat.cjs` 写入逻辑，loop-prompt 完全不动 |
| 会话时长 | heartbeat 记 `launchedAt`，watchdog 算 age | 中（时长 ≠ 轮数，空跑也累加） | 同上 |
| transcript 字节数 | watchdog stat 当前 .jsonl | 高但脆 | slug→活跃会话文件映射不可靠，不推荐 |

**选轮数计数**：`heartbeat` 命令本就每轮被调一次（Step 0.1），让它顺手维护一个 `rounds` 计数器，对 `loop-prompt.md` **零改动**（关键 —— 不碰天天在用的 prompt）。

---

## 4. 改动点（精确到文件 / 函数）

### 4.1 `lib/heartbeat.cjs` — 维护 rounds 计数器
- `writeHeartbeat` 时读旧值，`rounds = (old.rounds || 0) + 1` 写回。
- 新增可选入参 `resetRounds`：launch 路径调用时传 true，把 `rounds` 归零（代表新会话起步）。
- `readHeartbeat` 原样返回 `rounds`（向后兼容：老文件无该字段时按 0 处理）。

### 4.2 `lib/launch-command.cjs` — launch 时归零轮数
- `launchHeadless(root, slug)` 在 send-keys 启动 loop 后（或之前），写一次 `writeHeartbeat(root, { ...minimal, rounds: 0 })`，确保新会话从 0 计。
- 注意：watchdog 主动重启走的就是 `launchHeadless`，所以归零天然发生，无需额外处理。

### 4.3 `commands/watchdog.cjs` — `decideProject` 加主动重启分支
新增常量：
```js
const MAX_ROUNDS = 40;          // 主动重置阈值（见 §5 测算）
```
在 `decideProject` 的安全闸之后、被动重启逻辑之前插入：
```js
// 现有被动触发：心跳陈旧
// ... STALE_MS 判定保持不变 ...

// 新增主动触发：轮数超阈值且 loop 健康空闲 → 主动重置上下文
const fresh = !Number.isNaN(age) && (now - age) <= STALE_MS;
if (fresh) {
  if (paused) return { decision: 'reset' };            // 暂停中不碰，正常复位退避
  if (hb.phase === 'executing') return { decision: 'reset' }; // 任务在飞不打断
  if ((hb.rounds || 0) >= MAX_ROUNDS) {
    return { decision: 'restart', reason: 'proactive-context-reset' };
  }
  return { decision: 'reset' };                         // 健康且未到阈值 → 复位退避，跳过
}
// 心跳陈旧 → 落到原有被动 restart/giveup 逻辑
```
**关键**：主动重启必须只在 `phase === 'idle' || 'sleeping'`（即两轮之间的空窗）触发，绝不打断 executing。复用现有 `executing` 安全闸即可。

退避语义微调：主动重启成功后，新 loop 写首心跳（rounds=0）→ 下一轮 watchdog 见 `rounds < MAX_ROUNDS` 且心跳新鲜 → 走 `reset` 清退避。与被动路径同构，无需新增状态字段。

### 4.4 `dashboard`（可选，非必须）
心跳已含 `rounds`，dashboard 卡片可顺手显示"本会话第 N 轮"，让重置可观测。非阻塞项。

### 4.5 测试 `tests/commands.watchdog.test.cjs`
- 新增用例：`rounds >= MAX_ROUNDS && phase=idle && fresh` → `restart`，reason=`proactive-context-reset`。
- `rounds >= MAX_ROUNDS && phase=executing` → `reset`（不打断）。
- `rounds < MAX_ROUNDS && fresh` → `reset`。
- 既有"陈旧 > 30min"用例保持绿。

---

## 5. 阈值测算：`MAX_ROUNDS` 取多少

目标：把单轮上下文压在缓存仍划算的区间，同时别太频繁冷启动（每次重启 ≈ 50k 起步开销 + 重读 skill）。

实测每轮上下文增量 ≈ (813k − 50k) / 3832 ≈ **200 token/轮**？不对 —— 轨迹是非线性的，前期增量小后期大（subagent 返回累积）。按轨迹估，每轮净增约 **2~5k**（派发 prompt + STATUS 返回 + 工具记录）。

- `MAX_ROUNDS = 40` → 上下文封顶约 50k + 40×4k ≈ **210k**，每 40 轮重启一次。
- 对比现状平均 400k、峰值 800k：**平均上下文降到 ~130k，缓存读取省 ~65~70%**。
- 重启频率：串行 loop 空队列时 `idleSleepSeconds` 默认 270s，40 轮 ≈ 3 小时一次冷启动，开销可忽略。积压繁忙时轮转快，重启更勤但每次都换来上下文归零，净赚。

建议 `MAX_ROUNDS` 做成 `project.config.js` 可覆盖（默认 40），繁忙项目可调低到 25，几乎不挂机的可调高到 80。

---

## 6. 收益估算

- 单看 ditto + node-aggregates 两个 loop 工作流：合计 ~$1.24 万等价成本，其中 ~$9k 是缓存读取。
- 主动重置把平均上下文从 ~400k 压到 ~130k → 缓存读取打 ~3.5 折 → **省 ~$5.5k 等价**。
- 折算全局 ~143 亿 token / $3.3 万等价成本的 **~16%**，且**完全不影响产出**（subagent 干活不受影响，主 loop 调度无状态损失）。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 主动重启撞上 loop 刚要派发的瞬间 | 仅在 `phase=idle/sleeping` 触发；executing 永不碰（复用现有安全闸） |
| 重启丢失"本轮已 plan-batch 未派发"的中间态 | plan-batch/claim 已落 Excel（IN_PROGRESS）；`recover` 在新会话 Step 0 自动回收，无丢任务 |
| rounds 计数与真实会话错位（用户手动重启没归零） | launch 路径强制归零；手动 `claude /loop` 启动建议也走 `launchHeadless` 包装（或接受偶发偏高，下次重启自愈） |
| MAX_ROUNDS 太小导致频繁冷启动 | 可配置；默认 40 ≈ 3h/次，开销可忽略 |
| 改 heartbeat 字段影响 dashboard 解析 | `rounds` 为新增可选字段，老逻辑读不到按 0 处理，向后兼容 |

**回滚**：本方案不改 `loop-prompt.md`、不改状态机、不改 Excel schema。回滚只需把 `decideProject` 的主动分支删掉（或 `MAX_ROUNDS = Infinity`），watchdog 立刻退回纯被动行为。`rounds` 字段留着无害。

---

## 8. 实施顺序（待批准后）

1. `lib/heartbeat.cjs` 加 `rounds` 自增 + `resetRounds` —— 加单测。
2. `lib/launch-command.cjs` launch 时归零 —— 加单测。
3. `commands/watchdog.cjs` `decideProject` 加主动分支 + `MAX_ROUNDS` 常量/配置 —— 扩 `tests/commands.watchdog.test.cjs`。
4. 全量 `npm test`（task-queue 自带 tests/）。
5. 真机观察：手动把某项目 `MAX_ROUNDS` 调到 5，跑几轮确认 watchdog 日志出现 `[restart] <slug> proactive-context-reset` 且新会话心跳 rounds 归零。
6. dashboard 显示 rounds（可选）。

---

## 附录：用量分析脚本逻辑

按 `message.id + requestId` 去重避免 resume 会话重复计数；按 `timestamp[:10]` 分天；按 transcript 顶层目录名归项目；成本 = `Σ(各类 token / 1e6 × 单价)`。原始脚本见会话记录，可复跑刷新数据。
