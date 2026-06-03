# task-queue 并行执行设计 v2(双 lane)

- 日期:2026-06-03
- 作者:Claude(brainstorming with Seth)
- 状态:已确认(用户批准 → 转 writing-plans)
- 取代:`2026-05-21-parallel-execution-design.md`(草案,从未实现)

## 背景

当前 /loop 严格串行:Step 1 取 1 条 todo → 派 1 个 subagent → 跑完才轮下一条。多条互不相干的待办堆积时吞吐被单条任务时长卡死。v1 spec(2026-05-21)已完整设计过并行方案但从未实现;本 v2 在 v1 基础上做三处修订后落地:

1. **新增双 lane**:任务分 code(改仓库文件)/ non-code(调研、问答、分析,不动 git 跟踪文件)两条路;non-code 不开 worktree。
2. **推荐配置改激进**:`allowSameScope: true` 进推荐缺省(用户实际项目多为单 scope,保守缺省会让 code 并行退化为串行)。
3. 合并执行者、失败状态维持 v1 决策:**主 loop 串行 merge,失败转 review**。

## 设计原则与既定决策

| 决策点 | 选择 | 备注 |
|---|---|---|
| 并行场景 | 同一 /loop 会话派多个 subagent,主进程编排 | 不走多 terminal 多会话 |
| 任务分 lane | 主 Claude 在 plan-batch 编排时判定 code / non-code | non-code 误判有 needs-code 回流护栏 |
| 互斥粒度 | AI 编排 + scope 兜底;non-code 不占 scope 互斥 | 同 scope 并行需 `allowSameScope=true` + AI 判定文件不重叠 |
| 工作区隔离 | code:每任务一个临时 git worktree,node_modules symlink 共享;non-code:无 worktree | |
| merge 执行者 | 主 loop 串行 merge(ff → rebase) | 不派 subagent 做 merge |
| merge/build 失败 | 转 review + 保留 worktree | 不进 block,不自动 retry |
| non-code 产出 | 写 `.tasks/` 下文件或落 note/通知,禁改 git 跟踪文件 | 与 merge 零冲突,可任意并行 |
| commit 顺序 | = merge 顺序(不等于 task id 顺序) | ftime 在 Excel 里保留真实完成时序 |

## §1. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  /loop 主会话(单 Claude 进程)                                │
│                                                               │
│  Step 1.5: plan-batch --limit 5 输出候选 + scope 互斥提示     │
│            ★ 主 Claude 编排:标 lane + 挑本轮并行批次         │
│  Step 2:   claim-batch <ids...> 原子拿锁                      │
│  Step 3:   code 任务逐条 worktree.createForTask               │
│            一条 message 派 K 个 Agent(并发 tool_use)         │
│            ├─ code agent:在 task-N/ 改代码 + build +          │
│            │   done-in-worktree(commit 到 task-N 分支)        │
│            └─ non-code agent:主仓库 cwd,只读代码,产出写      │
│                .tasks/reports/ 或返回正文;禁改跟踪文件        │
│  Step 4:   non-code 返回即归档(无 commit,不等 code)         │
│            code 按完成序串行 merge-task:                      │
│              ff-merge 成功 → 原 done 流程归档                  │
│              ff 失败 → rebase;冲突 → review + 保留 worktree   │
│  Step 4.5: 推送(PushNotification + test-push 双通道)         │
│  Step 5:   status 有 todo → 立即回 Step 1 / 否则 ScheduleWakeup│
└──────────────────────────────────────────────────────────────┘
```

### 文件布局

```
<project>/
├── .tasks/
│   ├── tasks.xlsx              (主 Excel,只主进程写)
│   ├── worktrees/
│   │   ├── task-7/
│   │   │   └── node_modules → ../../../node_modules (symlink)
│   │   └── task-9/
│   ├── reports/                (non-code 任务产出,git ignore 内)
│   │   └── task-11.md
│   └── run/heartbeat.json      (主进程写,currentTaskIds[])
└── node_modules/               (主仓库,被 symlink 共享)
```

### 关键不变量

1. **Excel 单写**:只主进程 claim-batch / merge-task / 转 review / 归档。subagent 不读写 Excel。
2. **工作区物理独立**:每个 code subagent 有自己的 worktree,各自跑 build。
3. **main 分支只在 merge-task 中改写**:code subagent 的 commit 落 task-N 分支;主进程负责 merge 回 main。
4. **non-code 不碰 git**:不改任何 git 跟踪文件,不 commit;产出只进 `.tasks/` 或返回正文。
5. **失败默认保守**:rebase 冲突 / build 红 / 改依赖 / subagent 异常 → 转 review,worktree 保留给人工。

## §2. 双 lane 判定与流转

### 判定(Step 1.5,主 Claude 推理)

| | code lane | non-code lane |
|---|---|---|
| 判定依据 | desc 涉及改代码 / 改仓库文件 | 调研、问答、分析、统计类,无需改文件 |
| 隔离 | worktree + task-N 分支 | 无 worktree,主仓库 cwd 只读 |
| 产出 | commit 到 task 分支 → 主 loop merge | `.tasks/reports/task-N.md` 或 note/通知正文 |
| 完成 | merge-task → 版本号/changelog/正式 commit → 归档 | 主 loop 直接 done 归档(无 commit) |
| 并发约束 | scope 互斥(allowSameScope 时由 AI 判文件不重叠) | 只占 maxConcurrency 名额 |

拿不准的 desc 一律按 code 处理(反向误判无害:merge 空分支直接归档)。

### needs-code 回流护栏

non-code subagent 的 prompt 明令禁止改仓库文件。执行中发现需要改代码 → 不改,返回 `STATUS: needs-code` + 说明。主进程:任务放回 todo,note 顶部追加「[needs-code] <说明>」,本轮不计完成;下轮 plan-batch 见标记强制走 code lane。回流仅允许一次:已带 [needs-code] 标记的任务再次返回 needs-code → 转 review。

## §3. 数据流(一轮端到端,混合批次)

Excel 初态(maxConcurrency=3,allowSameScope=true):

| id | desc | scope | status |
|---|---|---|---|
| 7 | 改登录页 i18n 中文 | poc | todo |
| 8 | fix 抽屉重复按钮 | poc | todo |
| 11 | 调研竞品 API 限流方案 | poc | todo |

1. **Step 0**:recover 扫 orphan(v1 决策矩阵,见 §3.5)。
2. **Step 1.5**:plan-batch 返回 3 条候选。主 Claude 标 lane:#7 code、#8 code、#11 non-code。#7 #8 同 scope,但 desc 看(登录页 vs 抽屉)文件大概率不重叠 → 放行并行。stdout 写一句编排理由供复盘。
3. **Step 2**:claim-batch 7 8 11;heartbeat `currentTaskIds=[7,8,11]`,phase=executing。
4. **Step 3**:建 worktree ×2(#7 #8);同一条 message 派 3 个 Agent。
5. **#11 先回**(报告写 `.tasks/reports/task-11.md`,摘要在返回正文)→ 主进程立即归档 #11(summary 落 note 顶部),不等 #7 #8。
6. **#7 #8 回** → 按完成序 merge-task:ff/rebase 成功走 done 归档;冲突 → review + 保留 worktree。
7. **Step 4.5**:推送「#7 #8 #11 完成(或部分 review)」。
8. **Step 5**:status 有 todo → 立即回 Step 1。

## §3.5 worktree 生命周期与 recover

沿用 v1 全表(见 v1 spec §3.5),要点:

- merge 成功 → 删 worktree + 删分支;转 review → 都保留。
- recover orphan 决策矩阵不变;non-code 任务无 worktree,天然不进矩阵。
- 用户介入:worktree 解决冲突后 `merge-task <root> <id>` 重试;放弃走 `worktree-discard <root> <id>`。

## §4. 组件分解

### 新增

| 文件 | 职责 |
|---|---|
| `lib/orchestrator.cjs` | 编排规则纯函数:校验候选 + 应用 scope/并发规则,输出给主 Claude 推理的结构 |
| `lib/worktree.cjs` | worktree 生命周期 + symlink(createForTask / destroyForTask / listOrphans) |
| `commands/plan-batch.cjs` | 候选 + scope 互斥提示输出(JSON) |
| `commands/claim-batch.cjs` | 原子 claim 多条(全成或全回滚) |
| `commands/done-in-worktree.cjs` | code subagent 调:检测依赖文件改动(拒绝)→ commit 到 task-N 分支 |
| `commands/merge-task.cjs` | 主进程串行调:ff → rebase → 走 done 归档;冲突转 review |
| `commands/worktree-list.cjs` / `worktree-discard.cjs` | 人工回路 |

### 修改

| 文件 | 改动 |
|---|---|
| `commands/next.cjs` | 加 `--limit N`(默认 1,向后兼容) |
| `commands/recover.cjs` | 启动扫 orphan 按矩阵处理 |
| `commands/done.cjs` | 拆 `lib/done-core.cjs`;merge-task 复用;non-code 走无 commit 归档路径 |
| `lib/config.cjs` | 解析 `parallel: {enabled, maxConcurrency, allowSameScope}` |
| `lib/heartbeat.cjs` | `currentTaskId` → `currentTaskIds[]`(读旧字段兼容) |
| `loop-prompt.md` | Step 1.5 编排 + lane 标注;Step 3 多 Agent;Step 4 non-code 即时归档 + code 串行 merge |
| `web/dashboard*` | 展示 `currentTaskIds[]`;旧单字段兼容 |
| `commands/init-write.cjs` | init 时写入推荐并行配置(见下) |

## §5. 配置 schema

`project.config.js`:

```js
module.exports = {
  // ...existing fields...
  parallel: {
    enabled: true,             // 推荐缺省(spec v1 为 false;存量项目缺字段时按 false 兼容)
    maxConcurrency: 3,
    allowSameScope: true,      // 推荐缺省:同 scope 由主 Claude 判文件不重叠后放行
  },
};
```

- **存量项目**:config 无 `parallel` 字段 → 按 `enabled: false` 处理,行为与现串行版完全一致(回归保障)。
- **新 init 项目**:init-write 写入上述推荐值。
- 用户在 init Q&A 或手改 config 可覆盖。

## §6. 异常路径

v1 §4 全表沿用,新增:

| 异常 | 触发 | 兜底 |
|---|---|---|
| non-code 改了跟踪文件 | 返回后主进程 `git status` 检出主仓库脏(非 .tasks/) | 主进程 `git checkout -- <files>` 还原 + 任务转 review,note 写明 |
| needs-code 二次回流 | 已带 [needs-code] 标记再返回 needs-code | 转 review |
| lane 误判 code→实际没改文件 | merge 时 task-N 分支无 commit | 直接归档,无害 |

## §7. 测试策略

v1 §5 全表沿用(单元:orchestrator/worktree;集成:fixtures 双 scope 完整轮;故障注入:同文件冲突/改 deps/kill -9;dashboard 新旧 heartbeat 兼容;回归:enabled=false 等同串行),新增:

| 层 | 内容 |
|---|---|
| 单元 | lane 判定边界数据结构(纯调研/纯改码/混合 desc 的候选输出格式);needs-code 标记读写 |
| 集成 | 混合批次(2 code + 1 non-code):non-code 先归档不等 merge;non-code 产出落 .tasks/reports/ |
| 故障注入 | non-code 改跟踪文件 → 还原 + review;needs-code 一次回流成功、二次转 review |

**不测**:LLM lane 判定与编排判断质量本身;长跑性能。

## 已知限制

1. 单 scope 项目在 `allowSameScope=false` 时 code lane 退化串行(推荐配置已默认 true 规避)。
2. node_modules 共享 = deps 变更任务被禁,只能临时关 parallel 走串行老路。
3. AI 编排/lane 误判成本:浪费一轮 build 或一次回流,有 review 兜底但需人工。
4. 并行 N 个 subagent = N 份独立 token 消耗 + N 份并行 build 机器压力,maxConcurrency 调大需自担。

## 后续(本 spec 不涵盖)

- worktree 池化;跨任务依赖 DAG(note「依赖 #X」);v1 既留接口位,本期不实现。
