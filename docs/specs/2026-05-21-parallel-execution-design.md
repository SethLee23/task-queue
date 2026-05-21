# task-queue 并行执行设计

- 日期:2026-05-21
- 作者:Claude(brainstorming with Seth)
- 状态:草案(待用户复核 → 转 writing-plans)

## 背景

当前 task-queue skill 的 `/loop` 是严格串行:Step 1 取 1 条 todo,Step 2-4 跑完,才轮到下一条。当 Excel 里堆了多条互不相干的待办时(例:前端 i18n 一条、后端 Controller 改一条),整体吞吐受单条 build 时间制约,显著拖慢节奏。

本设计在保留现有串行兼容性的前提下,引入"同会话多 subagent 并行"能力。

## 设计原则与既定决策

| 决策点 | 选择 | 备注 |
|---|---|---|
| 并行场景 | 同一 /loop 会话派多个 subagent,主进程编排 | 不走多 terminal 多会话 |
| 互斥粒度 | AI 编排 + scope 兜底 | 默认同 scope 串行;主进程从 desc/note 推断同 scope 内能否独立 |
| 工作区隔离 | 每条任务一个 git worktree(临时),node_modules 用 symlink 共享主仓库 | 不走 worktree 池/不走 patch 隔离 |
| rebase 冲突 | 转 review + 保留 worktree | 不自动 retry |
| commit 顺序 | = merge 顺序(不等于 task id 顺序) | ftime 在 Excel 里保留真实完成时序 |

## §1. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  /loop 主会话(单 Claude 进程)                           │
│                                                          │
│  Step 1: next --limit 5  取前 5 条 todo                 │
│  Step 1.5: plan-batch 输出候选 + scope 互斥提示          │
│             ★ Claude 主进程编排:输出本轮并行批次        │
│  Step 2: claim-batch <ids...>  原子拿锁                  │
│  Step 3: worktree.createForTask 每条 ×1                  │
│          一条 message 派 K 个 Agent(并发 tool_use)     │
│           Agent 在 task-N/ 内改代码 + build + done-in-  │
│           worktree(只 commit 到 task-N 分支)            │
│  Step 4: 按 claim 顺序串行 merge-task                    │
│           ff-merge 成功 → 走原 done 流程归档             │
│           ff 失败 → 尝试 rebase                          │
│           rebase 冲突 → 转 review + 保留 worktree        │
│  Step 4.5: 推送(两条通道:PushNotification + test-push) │
│  Step 5: 立即回 Step 1 / ScheduleWakeup                  │
└─────────────────────────────────────────────────────────┘
```

### 文件布局

```
<project>/
├── .tasks/
│   ├── tasks.xlsx              (主 Excel,所有 worktree 共享,只主进程写)
│   ├── worktrees/
│   │   ├── task-7/
│   │   │   └── node_modules → ../../../node_modules (symlink)
│   │   └── task-9/
│   └── run/heartbeat.json      (主进程写,subagent 不动)
└── node_modules/               (主仓库,被 symlink 共享)
```

### 关键不变量

1. **Excel 单写**:只主进程能 `claim-batch`/`merge-task`/转 review。subagent 只读自己的 worktree,不读 Excel。
2. **工作区物理独立**:每个 subagent 有自己的 worktree,各自跑 build 验证。
3. **main 分支只在 merge-task 中改写**:subagent 的 commit 落在自己的 `task-N` 分支,主进程负责 ff-merge / rebase 回 main。
4. **失败默认保守**:任何 rebase 冲突或 subagent 异常 → 转 review,worktree 保留给人工。

## §2. 组件分解

### 新增

| 文件 | 职责 | 接口 |
|---|---|---|
| `lib/orchestrator.cjs` | 编排器的规则函数(纯函数)。LLM 推理在主 Claude 进程里做,此 lib 只校验数据 + 应用规则。 | `planBatch(rows, {maxConcurrency, scopePolicy}) → {parallel, deferred, reason}` |
| `lib/worktree.cjs` | git worktree 生命周期 + symlink node_modules | `createForTask(root, id, baseBranch) → {worktreePath, branch}` <br>`destroyForTask(root, id, {force, deleteBranch})` <br>`listOrphans(root) → [{taskId, branchMerged}]` |
| `commands/plan-batch.cjs` | Step 1.5 调用。输出候选给主 Claude 推理。 | `node tasks.cjs plan-batch <root> [--limit N]` |
| `commands/claim-batch.cjs` | 原子 claim 多条 id(全成或全回滚) | `node tasks.cjs claim-batch <root> <id1> <id2> ...` |
| `commands/done-in-worktree.cjs` | subagent 在 worktree 内调用。只 commit 到 task-N 分支,不动 Excel,不写 main。检测改了依赖文件则拒绝 commit + 返回失败。 | `node tasks.cjs done-in-worktree <root> <id>` |
| `commands/merge-task.cjs` | 主进程串行调用。ff-merge → 失败 rebase → 成功走原 done 归档流程;rebase 冲突转 review。 | `node tasks.cjs merge-task <root> <id>` |
| `commands/worktree-list.cjs` | 列出当前所有 worktree 和对应任务状态 | `node tasks.cjs worktree-list <root>` |
| `commands/worktree-discard.cjs` | 强制销毁 worktree + 分支(不动任务状态) | `node tasks.cjs worktree-discard <root> <id>` |

### 修改

| 文件 | 改动 |
|---|---|
| `commands/next.cjs` | 加 `--limit N` 可选参数,默认 1(向后兼容);返回数组时格式 `[{...}, ...]` |
| `commands/recover.cjs` | 启动时扫 `.tasks/worktrees/*` orphan,按 §3.5 决策矩阵处理 |
| `commands/done.cjs` | 拆出 `lib/done-core.cjs`;并行路径走 `commands/merge-task.cjs`;串行旧路径保留 |
| `lib/config.cjs` | 解析新字段 `parallel: { enabled: boolean, maxConcurrency: number, allowSameScope: boolean }` |
| `lib/heartbeat.cjs` | `currentTaskId` 变成 `currentTaskIds: number[]`(读时向后兼容旧字段) |
| `loop-prompt.md` | 加 Step 1.5(AI 编排) + Step 3 改为派多个 Agent + Step 4 改为串行 merge |
| `web/dashboard*` | UI 改成展示 `currentTaskIds[]` 多任务;旧 `currentTaskId` 单字段兼容读取 |

### 主进程 vs subagent 职责

```
主进程(单 Claude 会话)         │  Subagent(每条任务一个)
─────────────────────────────│──────────────────────────────
读写 Excel                     │  只读自己的 worktree
claim-batch / merge-task       │  按 desc 执行代码改动
git worktree add/remove        │  在 worktree 内跑 build 验证
git merge / rebase             │  done-in-worktree(commit 到 task 分支)
PushNotification               │  返回结果给主进程
ScheduleWakeup                 │  无循环职责
```

## §3. 数据流(一轮 /loop 端到端)

### Excel 初态

| id | desc | scope | status | note |
|---|---|---|---|---|
| 7 | 改登录页 i18n 中文 | poc-web | todo |  |
| 8 | fix 抽屉重复按钮 | poc-web | todo |  |
| 9 | AuthController 401 响应 | service-java | todo |  |
| 10 | AuthController 加 audit | service-java | todo |  |

### 流转(maxConcurrency=3)

1. **Step 0**:recover 扫无 orphan,跳过
2. **Step 0.1**:heartbeat 写 model
3. **Step 1.5**:`plan-batch --limit 5` 返回
   ```json
   {
     "candidates": [
       {"id":7,"desc":"改登录页 i18n","scope":"poc-web"},
       {"id":8,"desc":"fix 抽屉重复按钮","scope":"poc-web"},
       {"id":9,"desc":"AuthController 401","scope":"service-java"},
       {"id":10,"desc":"AuthController audit","scope":"service-java"}
     ],
     "scopeMutex": [[7,8],[9,10]]
   }
   ```
4. **主 Claude 编排**:Claude 读 candidates 数组的 desc/scope/note,在自己的 reasoning 里挑选可并行的 ids。同 scope 默认串行;desc 看不出同 scope 独立 → 推迟 #8 #10。本轮并行 [7,9]。Claude 决定后,在 stdout 写一句"本轮并行 #7 #9,理由:跨 scope,desc 无目录重叠",方便用户在日志里复盘。
5. **Step 2**:Claude 调 `claim-batch 7 9`(把选定 ids 作为命令参数传入)。Excel 同步标进行中。heartbeat:`currentTaskIds=[7,9]`,phase=executing。
6. **Step 3 准备 worktree**:
   - `git worktree add .tasks/worktrees/task-7 -b task-7 main`
   - `ln -s ../../node_modules .tasks/worktrees/task-7/node_modules`
   - 同上为 task-9。
7. **Step 3 派 Agent**:同一条 message,两个 Agent tool_use 并发。每个 prompt 指明 cwd、任务描述、要求结尾调 `done-in-worktree`。
8. **subagent 在 worktree 内**:改代码 → 跑 build →
   - **build 失败**:不调 done-in-worktree,直接把异常返回给主进程。主进程 → 转 review + 保留 worktree。
   - **build 成功**:调 `done-in-worktree 7` → 检查 changedFiles 无依赖文件 → `git add -A && git commit -m "<temp>"` 落到 task-7 分支。返回 `{ok, commitSha, changedFiles}`。
   - **改了依赖文件**(package.json/lock 等):done-in-worktree 拒绝 commit + 返回失败。主进程 → 转 review + 保留 worktree。
9. **Step 4 串行 merge**:
   - `merge-task 7`:`git merge --ff-only task-7` 成功 → 走 done 的版本号/changelog/commit message 流程 → 把临时 commit amend 成正式 commit → Excel 归档 #7 → `git worktree remove .tasks/worktrees/task-7` + `git branch -D task-7`。
   - `merge-task 9`:`git merge --ff-only task-9` 失败(main 已前进) → `cd task-9 && git rebase main`:
     - rebase 干净 → 回主仓库再 ff-merge → 同 #7 路径。
     - rebase 冲突 → 转 review,note 写 "worktree 在 .tasks/worktrees/task-9,人工解决后调 merge-task 9"。worktree 保留。
10. **Step 4.5**:两条通道推送 "任务 #7 #9 已完成(或部分 review)"。
11. **Step 5**:`status` 显示 todo=2(#8、#10)→ 立即回 Step 1。

### Excel 终态(全部成功路径)

进行中表清空,已完结表累积 4 行。`git log main` 顺序:
```
abc1  【web】改登录页 i18n           (#7,版本号 X.Y.Z)
def2  【service】AuthController 401  (#9,同版本号或 +1)
...
```

## §3.5 worktree 生命周期

| 时机 | 任务状态 | worktree | task-N 分支 |
|---|---|---|---|
| claim-batch 完成 | todo → 进行中 | 创建 + symlink node_modules | 从 main 拉 task-N |
| done-in-worktree 成功 | 进行中(主进程未 merge) | 保留 | 累积 1 个 commit |
| merge-task 成功 | 进行中 → 已完成 | **删** | **删** |
| merge-task rebase 冲突 | 进行中 → 已完成-待review | **保留** | **保留** |
| subagent 异常(build 红 / 改 deps / 超时) | 进行中 → 已完成-待review | **保留** | **保留** |
| recover 扫 orphan | 见下表 | 见下表 | 见下表 |

### recover orphan 决策矩阵

`orphan` = `.tasks/worktrees/task-N/` 存在但任务 N 不在进行中。

| 任务状态 | task-N 已 merge? | 处理 |
|---|---|---|
| review | * | 保留(预期) |
| done(已归档) | 已 merge | 删 worktree + 删分支 |
| done(已归档) | 未 merge | 不一致:挪回 review,note 写明,保留 worktree |
| todo | * | 不一致:转 review,保留 worktree |
| 不存在(被删) | * | 强制删 worktree + 删分支 |

### 用户介入回路

- **快路径**:用户在 worktree 解决冲突 → `tasks.cjs merge-task <root> <id>` 重试 → 成功自动清。
- **放弃路径**:`tasks.cjs worktree-discard <root> <id>`,强删 worktree + 分支,任务保留 review。

### 暴露给用户的命令

| 命令 | 用途 |
|---|---|
| `worktree-list <root>` | 列出 worktree + 任务状态 |
| `worktree-discard <root> <id>` | 强制销毁(不动任务) |
| `merge-task <root> <id>` | 重试 merge |

## §4. 异常路径

| 异常 | 触发 | 兜底 |
|---|---|---|
| subagent build 失败 | worktree 内跑 buildCommands[scope] 退出码非 0 | subagent 不调 done-in-worktree,异常返回主进程 → 转 review,保留 worktree |
| subagent 卡死/超时 | Agent 工具返回 timeout | 转 review,保留 worktree |
| subagent 改了依赖 | done-in-worktree detect `package.json`/lock/`pom.xml` | 拒绝 commit,转 review |
| worktree 创建失败 | 磁盘/锁/重名分支 | 重试 1 次(stale 锁先删),仍失败 → 转 review |
| symlink 失败 | OS 限制 / 目标缺失 | 退回 hard-link → 仍失败则 npm install 一份 + warn |
| claim-batch 原子失败 | 有 id 状态已变 | 整批回滚,主进程重新 plan-batch |
| Excel 锁竞争 | 罕见(done 应只走主进程) | lib/lock.cjs 5s timeout 兜底,超时转 review |
| 主进程崩溃 | OOM/kill -9/重启 | 下次 recover 扫 orphan,按矩阵处理 |
| AI 编排误判(scope 内说独立但撞) | 同 scope 两条改同文件 | rebase 冲突兜底 → 后 merge 的转 review |
| dashboard 读旧 schema | 升级期 | `currentTaskIds` 不存在时 fallback 读 `currentTaskId` |

## §5. 测试策略

| 层 | 内容 |
|---|---|
| 单元 | `orchestrator.planBatch` 纯函数:跨 scope/同 scope/超 maxConcurrency/note 标依赖。`worktree.createForTask` 在 tmp 仓库测 symlink/分支/重名报错。 |
| 集成 | `tests/fixtures/` mini 项目(scope-a + scope-b)跑完整轮:next/plan-batch/claim-batch/2 个 worker 子进程模拟 subagent/merge-task ×2 → 验证 Excel 终态 + git log + worktree 清理。 |
| 故障注入 | (a) 两 worker 改同文件 → rebase 冲突 review。(b) worker 改 package.json → done-in-worktree 拒绝。(c) kill -9 主进程 → recover orphan 清理矩阵。 |
| dashboard 兼容 | dashboard-server 测试喂新旧两种 heartbeat.json,UI 都能渲染。 |
| 回归 | `parallel.enabled=false` 时,next/claim/done 行为完全等同当前串行版。 |

**不测**:LLM 编排判断质量本身;长跑性能。

## 配置 schema 变更

`project.config.js` 新增字段(可选,缺省 enabled=false 保持向后兼容):

```js
module.exports = {
  // ...existing fields...
  parallel: {
    enabled: false,            // 默认关闭,逐项目 opt-in
    maxConcurrency: 3,         // 同时跑的 subagent 上限
    allowSameScope: false,     // 是否允许主进程在 scope 内 AI 判断独立时并行
  },
};
```

## 已知限制(本设计不解决)

1. **单 scope 项目无收益**:若项目只有一个 scope 且 `allowSameScope=false`,并行退化为串行。需用户拆 scope 或开 `allowSameScope`。
2. **node_modules 共享 = deps 变更被禁**:任务真要升级依赖,只能临时关 `parallel.enabled` 走串行老路。
3. **AI 编排判断错的成本**:即使有 rebase 兜底,subagent 已完成的工作还是会被丢到 review 走人工,浪费一次 build。

## 后续(本 spec 不涵盖)

- worktree 池化(slot 复用而非任务级临时)— 等本期跑稳定后看 worktree 创建开销是否成为瓶颈再做。
- 跨任务依赖图(note 里写 "依赖 #X 完成后") — 已为 orchestrator.planBatch 留接口位,但本期不实现完整 DAG。
- 跨 scope 共享依赖的项目(monorepo 顶层 node_modules 被多 worktree 共享)— 现 symlink 方案已部分覆盖。
