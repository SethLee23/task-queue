# task-queue loop 流程

**主 loop 固定运行在 Opus**（启动时由 `/loop` 决定的模型，dashboard 上切的"执行模型"切的是 worker 子任务，不影响主 loop 自身）。每条任务都通过 Agent 工具派发给独立 subagent 实际执行，主 loop 只做调度。串行模式每次派发单条任务；当 `project.config.js` 启用 `parallel.enabled=true` 时进入并行模式，一轮可同时派发多条任务。

你正在 `${PROJECT_ROOT}` 项目执行任务循环。每次唤醒严格按以下步骤：

## 唤醒触发

下面任一情况发生时都要从 Step 0 开始走一遍完整流程：

1. **ScheduleWakeup 定时唤醒**（Step 5 自己安排的）
2. **用户输入"扫一下"/"扫一下任务表"/"再扫一下"/等价短句** —— dashboard ⚡ 立即执行按钮在 tmux 启动的 loop 上就是通过 send-keys 把"扫一下"注入到这里;手动在 terminal 敲也算
3. **wake-now 旗子被发现存在**（见 Step 0.5;非 tmux 启动时面板 ⚡ 走这条路)

不管哪种触发,Step 0 → Step 5 一轮跑完。不要把 (2) 当对话消息回复"好的我马上扫一下",**直接进 Step 0**。

## 准备

读 `${PROJECT_ROOT}/.tasks/project.config.js`（必要时）。所有 CLI 命令前缀：

```
node ~/.claude/skills/task-queue/tasks.cjs <cmd> ${PROJECT_ROOT} [args...]
```

## Step 0: crash recovery

```
node ~/.claude/skills/task-queue/tasks.cjs recover ${PROJECT_ROOT}
```

如果输出 `recovered > 0`，说明上次有任务被中断已重新排队。

## Step 0.1: 上报主 loop 模型（面板显示用）

主 loop 死锁在 Opus，heartbeat 模型**固定**写：

```
node ~/.claude/skills/task-queue/tasks.cjs heartbeat ${PROJECT_ROOT} --model claude-opus-4-7
```

每轮唤醒都跑一次。子任务 subagent 有自己的模型，由 subagent 自己上报，不要在这里覆盖。

## Step 0.5: 读 status

```
node ~/.claude/skills/task-queue/tasks.cjs status ${PROJECT_ROOT}
```

读输出：

- `"paused": true` → 跳到 Step 5（不执行 next/dispatch）
- `"wakeNow": true`（无论 paused 与否）→ 调
  ```
  node ~/.claude/skills/task-queue/tasks.cjs clear-wake ${PROJECT_ROOT}
  ```
  然后正常继续
- 记下 `idleSleepSeconds`（Step 5 用，默认 270；范围 [60, 3600]）
- 记下 `counts.desiredModel`（Step 2 派发用，默认 `opus`）

设计意图：面板的 pause 只影响"取下一条"，不打断已派发的 subagent；wake-now 旗子仅在非 tmux 启动时使用,响应延迟 ≤ idleSleepSeconds;tmux 启动时面板 ⚡ 走 send-keys 直接注入"扫一下"到 stdin,~1s 响应,跳过 wake-now 旗子。

## Step 1: 取任务(串行 / 并行分流)

读 `.tasks/project.config.js` 的 `parallel.enabled`:

### Step 1a: 串行模式(parallel.enabled=false / 字段缺失)

```
node ~/.claude/skills/task-queue/tasks.cjs next ${PROJECT_ROOT}
```

- 输出 `null` → 跳到 Step 5
- 输出 JSON `{id, desc, scope, priority, note, model, ...}` → 进入 Step 2

`model` 字段是**任务级模型覆盖**：非空时优先级高于项目级 `desiredModel`；空字符串表示回退项目级。

### Step 1b: 并行模式(parallel.enabled=true)

```
node ~/.claude/skills/task-queue/tasks.cjs plan-batch ${PROJECT_ROOT}
```

输出 `{candidates, scopeMutex, maxConcurrency, allowSameScope}`。

- `candidates` 空 → 跳到 Step 5
- `candidates` 只有 1 条 → 退回 Step 1a 串行路径处理这 1 条(不值得开 worktree)
- ≥ 2 条 → 你自己做编排(不调外部命令):

**编排规则:**

1. **标 lane**:每条候选判定 `code`(desc 涉及改代码/改仓库文件)或 `non-code`(调研/问答/分析,无需改文件)。拿不准一律 code。note 顶部含 `[needs-code` 标记的强制 code。
2. **scope 互斥**:`scopeMutex` 里的 pair 默认不同批;`allowSameScope=true` 时,若两条 desc 明显改不同文件/目录可同批。non-code 不占 scope 互斥。
3. note 含 "依赖 #N" 且 #N 不在本批 → 推迟。
4. 总数 ≤ `maxConcurrency`。

输出一行编排理由(日志复盘用),例:
> 本轮并行 #7(code) #9(code) #11(non-code),理由:7/9 跨目录,11 纯调研

然后:

```
node ~/.claude/skills/task-queue/tasks.cjs claim-batch ${PROJECT_ROOT} <id1> <id2> ...
```

→ 进入 Step 2b。

## Step 2: 派发 subagent 执行任务

主 loop **不再自己 claim / 执行 / done**，全部交给 subagent 完成生命周期。

**决定 worker 模型**：

```
workerModel = task.model || desiredModel   // 都为空时 fallback 'opus'
```

**调用 Agent 工具派发**（`model` 参数必传 `opus` / `sonnet` / `haiku` 别名，不是具体版本 ID）：

```
Agent(
  subagent_type: "general-purpose",
  model: <workerModel>,
  description: "执行任务 #<id>",
  prompt: <Subagent 模式模板，见本文件末尾 ## Subagent 模式 段；填入 PROJECT_ROOT 与 TASK_ID>
)
```

派发失败定义：
- Agent 工具调用本身抛错
- subagent 返回内容最后一行不是 `STATUS: done|review|block`

派发失败处理（子任务未走完时，任务可能还是 TODO，状态机不允许 TODO→BLOCKED，需要先推到 IN_PROGRESS 再 block）：

```
node ~/.claude/skills/task-queue/tasks.cjs claim ${PROJECT_ROOT} <id>    # 若 subagent 已 claim 过，这里会报"非法转换"，忽略即可
node ~/.claude/skills/task-queue/tasks.cjs block ${PROJECT_ROOT} <id> "subagent 派发失败: <错误前 200 字>"
```

并按 Step 4 推送两通道通知。

## Step 3: 处理 subagent 返回(并行模式见 Step 3b)

subagent 已自行 claim / heartbeat / 执行 / done|review|block / 推送通知。主 loop 收到的最后一行格式为 `STATUS: done|review|block`，**仅作日志确认**，不要重复调结束命令、不要重复推送。

## Step 2b(并行模式): 建 worktree + 并发派 worker

**对每条 code 任务**先建 worktree(主 loop 跑):

```
node ~/.claude/skills/task-queue/tasks.cjs worktree-create ${PROJECT_ROOT} <id>
```

失败(报"已存在"以外的错)→ 该任务按串行 Step 2 的派发失败处理(claim 已完成,直接 block)。

然后**同一条 message 里**为每条任务发一个 Agent 调用(并发 tool_use),`model` = task.model || desiredModel:

- code 任务 → prompt 用本文件末尾 **## Parallel Code Worker 模式** 模板,填入 PROJECT_ROOT / TASK_ID / WORKTREE 路径 / 任务 desc / scope
- non-code 任务 → prompt 用 **## Non-code Worker 模式** 模板,填入 PROJECT_ROOT / TASK_ID / 任务 desc

## Step 3b(并行模式): 收 worker 返回,收尾

worker 返回顺序不定,**non-code 先回先归档,不等 code**。

**non-code worker 返回:**

- 末行 `STATUS: done` → `node ~/.claude/skills/task-queue/tasks.cjs done ${PROJECT_ROOT} <id> "<返回正文(完整答案)>" --expect-clean`
  - 命令把脏仓库自动还原+转 review,你无需自查 git status
- 末行 `STATUS: needs-code` →
  - 该任务 note 里**已有** `[needs-code` 标记(claim-batch 输出的 note 里看)→ 二次回流,`review <id> "二次 needs-code,请人工拆解: <worker 说明前 100 字>"`
  - 否则 → `requeue ${PROJECT_ROOT} <id> "<worker 说明前 200 字>"`(下一轮强制 code lane)
- 末行 `STATUS: block` / 无 STATUS 行 → `block <id> "<原因>"`

**code worker 全部返回后,按返回顺序逐条串行:**

- 末行 `STATUS: done`(worker 已跑过 done-in-worktree 且 ok:true)→
  ```
  node ~/.claude/skills/task-queue/tasks.cjs merge-task ${PROJECT_ROOT} <id> "<worker 返回的 summary>"
  ```
  - `{ok:true}` → 完成,worktree 已清
  - `{ok:false}` → 已自动转 review,worktree 保留,**不要重试**
- 末行 `STATUS: review` → `review <id> "<worker 给的风险>"`(worktree 保留)
- 末行 `STATUS: block` / Agent 调用失败 / 无 STATUS 行 → `block <id> "<原因前 200 字>"`(worktree 保留)

**每条任务收尾后立刻双通道推送**(同串行 S5 文案格式):PushNotification + test-push。

全部收尾后 → Step 5。

## Step 4: 推送通知（仅派发失败时由主 loop 发）(并行模式见 Step 3b)

正常路径下 subagent 自己推了。只在 Step 2 末尾派发失败时由主 loop 发：

```
PushNotification(message: "任务 #<id> 阻塞: subagent 派发失败 - <错误前 40 字>", status: "proactive")
node ~/.claude/skills/task-queue/tasks.cjs test-push "任务 #<id> 阻塞: subagent 派发失败 - <错误前 40 字>" --project-root ${PROJECT_ROOT}
```

## Step 5: 决定下次唤醒间隔

读 `idleSleepSeconds`（Step 0.5 已读过可直接复用）。

- `todo > 0` → 还有积压，立刻回 Step 1 继续（不睡）
- `todo == 0 && (review > 0 || blocked > 0)` → `ScheduleWakeup <idleSleepSeconds>s "等用户处理 review/blocked（cap 内可被面板立即执行唤醒）"`
- 全 0 → `ScheduleWakeup <idleSleepSeconds>s "队列空（cap 内可被面板立即执行唤醒）"`

## 异常路径

如果 tasks.cjs 任何命令退出码非 0 且 stderr 含 "task-queue 错误"：
- 不前进任何状态
- 推送 "task-queue 异常: <错误头部>，请检查 .tasks/logs/"（两通道）
- `ScheduleWakeup 3600s "skill 异常等修复"`

如果 Excel 文件被锁（命令输出含 "EAGAIN" 或类似）：
- 推送 "Excel 正在打开，本轮跳过"（两通道）
- `ScheduleWakeup 60s "等 Excel 关闭"`

---

## Subagent 模式

**仅当你被主 loop 通过 Agent 工具派发执行单条任务时按本节执行。** 你收到的 prompt 顶部应有 `PROJECT_ROOT=<...>` 和 `TASK_ID=<...>` 两行。所有 CLI 命令前缀同主 loop：

```
node ~/.claude/skills/task-queue/tasks.cjs <cmd> ${PROJECT_ROOT} [args...]
```

### S1. claim 任务

```
node ~/.claude/skills/task-queue/tasks.cjs claim ${PROJECT_ROOT} <TASK_ID>
```

claim 输出 JSON `{id, desc, scope, priority, note, model, ...}`。

**必须**检查 `note` 字段顶部是否含 `[<用户名> 回复 LATEST YYYY-MM-DD HH:mm] ...` 块：

- 有 → 这是用户对此前 review/block 的**最新**答复，**必须**先把答复完整读完再开工；按答复要求调整方案/范围/做法
- 无 → 正常按 desc 执行

note 里只可能有 **1 个** `[<用户名> 回复 LATEST ...]` 块（每次新 reply 都会自动把现存 LATEST 降级为 OBSOLETE）。看到 `[<用户名> 回复 OBSOLETE ...]` 或更老的 `[reply OBSOLETE ...]` 块表示这是更早的历史回复，**仅作背景理解，不要按它执行**——否则你会重复犯之前已经被新 LATEST 推翻的错误。

reply 块两种形态：
- 普通追加：`[<用户名> 回复 LATEST 时间] 答复内容`（用户只是补充信息，task 状态没变）
- 恢复型（阻塞/review 转 todo 时）：
  ```
  [<用户名> 回复 LATEST 时间]
  Q: AI 此前提的疑问 / Risk: AI 此前标的风险
  A: 用户的答复
  ```
  按时间线排列（Q/Risk 先发生，A 后发生）；AI 原疑问/风险已从 question/risk 字段迁移到此处，字段会被清空属预期行为，历史在 note 里保全。

reply 块只用于读取上下文，**不要清除或改写它**；done/review/block 自然会把新内容追加到 note 顶部，旧块自动保留为历史。

### S2. 上报子任务真实模型 ID

从系统提示中读取你自己的会话精确模型 ID（`claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5-20251001`），写 heartbeat：

```
node ~/.claude/skills/task-queue/tasks.cjs heartbeat ${PROJECT_ROOT} --model <claude-model-id>
```

这条覆盖主 loop 的 opus 上报，dashboard 显示的就是子任务实际执行模型。

### S2.5. 拆解 / 推进 checklist（可选但强烈推荐）

claim 返回的 JSON 含 `checklist` 字段（JSON 字符串，可能为空）。用于让用户在 dashboard 卡片上看到你打算做什么、做到哪步。

**checklist 为空**：先把任务拆成 2-6 步可勾选的子任务，写入：

```
node ~/.claude/skills/task-queue/tasks.cjs set-checklist ${PROJECT_ROOT} <id> "step1|step2|step3"
```

拆解原则：
- 拆细到"勾掉一项 = 完成一段可独立验证的工作"
- 描述短句即可（≤20 字），用户扫一眼能知道你在干啥
- 太琐碎的任务（"改一行注释"这种）可以跳过本步，不拆

**checklist 非空**：说明上一轮没干完。读 `checklist` JSON，找到第一个 `done: false` 的项 = 你这一轮要干的事。

**任务执行期间**：
- 干完一步立刻 `tick-checklist ${PROJECT_ROOT} <id> <1-based-index>`
- 干到一半发现要补步骤：`add-checklist ${PROJECT_ROOT} <id> "新步骤"`
- 发现某步不需要做了：`del-checklist ${PROJECT_ROOT} <id> <index>`

向后兼容：**任务的 checklist 不是必需的**。完全跳过 S2.5 直接干 S3 也合法（老任务、琐碎任务都这么走）。但拆过 checklist 的任务，干完要把所有项都 tick 完，否则 dashboard 上会显示"还差几项"造成误导。

**强制护栏**：如果 checklist 有未勾项时调 `done`，命令会**自动拒绝并把任务回退到 TODO**（note 顶部加 `[done 被拒]` 块保留你的 summary），下一轮 loop 重新派发让你从首个未勾项续做。不要尝试用"全部完成"的 summary 绕过——子项没勾就是没勾。正确做法：要么按顺序 tick 完所有项再 done，要么如果某项确实不需要做，先 `del-checklist` 删掉它再 done。

### S3. 执行任务

按 `desc` 字段描述执行，严格遵守：

- 任务范围 `scope` 必须严守，不动 scope 外的文件
- 编辑前先 Read 相关文件
- 改完后跑 `project.config.js` 中 `buildCommands[scope]` 验证编译
- 严守 `CLAUDE.md` 中的性能纪律（"配置期贵运行期贱"）、TypeScript/SCSS 规范
- 严守安全护栏：禁止 push、reset --hard、checkout --、--no-verify、--amend
- 严守 scope 外目录禁触碰（core/static/gwadmin、snackbar、yaum-login 等 CLAUDE.md 明示的外部资源）

### S4. 根据结果调用结束命令

四类结局（必须三选一）。**路径引用约定**（写 `<风险描述>` / `<疑问>` / done 后追加 note 时都适用）：

- 引用项目内文件 → 写**相对项目根**的完整路径：`web/src/foo.tsx`、`web/src/foo.tsx:42`、`web/src/foo.tsx:42:7`
- 引用项目外文件 → 写**绝对路径**：`/Users/...` 或 `~/.claude/...`
- 引用 URL → 完整 `https://...`
- **禁止**：单独写文件名（如 `foo.tsx`）—— dashboard 解析为相对根目录会找不到；除非该文件确实在项目根目录

dashboard 会自动识别这些路径并渲染成可点击的链接。

#### S4a. 全部成功

```
node ~/.claude/skills/task-queue/tasks.cjs done ${PROJECT_ROOT} <id> "<summary>"
```

summary **必传且不能省略**，是给人看的"完成回复"，落到任务 note 顶部 `[done 时间]` 块，dashboard "今日完成"区直接显示。空 summary = 用户看不到你做了什么 = 用户会愤怒。

按任务类型决定 summary 内容与长度：

**执行型任务**（改代码 / 加测试 / 配置变更等）：1-2 句话简述
- 关键改动文件/模块（超过 3 个只点一两个代表）
- 关键决策或权衡（为什么这么做，不是怎么做）
- 后续注意事项（若有）

示例：
- `"改 ReqConfig.tsx 把'请求名称' label 简化为'名称';顺手把 minWidth 从 120 调到 96 收紧表格"`
- `"Playwright config + 1 个 router e2e case 落地;约定 baseURL=127.0.0.1:3000 复用 dev server"`

**回答型任务**（desc 含"是什么"/"为什么"/"怎么"/"?"/"解释"/"分析"等，或贴图问"这是啥"）：summary **就是完整答案**，放开写。dashboard "今日完成"区是单列宽栏，有足够空间显示多段落长文本。换行 + 文件路径直接写 —— linkifyText 会自动把路径/URL 渲染成可点击链接。

done 命令内部决定是否 auto commit：
- scope.autoCommit=true 且无 inferModule 失败 → 自动 commit + 归档
- 否则 → 自动转 review 流程

#### S4b. 软失败（功能完成但有担心需 review）

```
node ~/.claude/skills/task-queue/tasks.cjs review ${PROJECT_ROOT} <id> "<风险描述>"
```

例：单测红、改了热路径、修了公共组件、touched 文件超出预期范围。

**⚠️ 只有一个字符串参数，禁止加任何 `--flag`**（比如不要写 `review <id> --summary "xxx"`）。命令把 args[1] 当字面 risk 写入 Excel，写错就会在 dashboard 看到 `Risk: --summary` 这种乱码。

#### S4c. 硬失败（任务描述卡壳）

```
node ~/.claude/skills/task-queue/tasks.cjs block ${PROJECT_ROOT} <id> "<疑问>"
```

例：文件路径不存在、需求歧义、TS 报错改不出来、build 失败。

**⚠️ 同样只有一个字符串参数，禁止加 `--flag`**。block 会拒绝 `--` 开头的 question 字符串。

#### S4d. 环境失败

先重试 1 次（rm -rf node_modules && npm install / 重新跑 build）。仍败按 S4c 硬失败处理。

### S5. 推送通知（必须，每条任务都推；两条通道都要发）

无论 done/review/block 之后，必须**并行调用两个推送通道**——单独哪一条都可能失效：

#### 通道 A：Claude 内置 PushNotification（手机/Remote Control）

```
PushNotification(message: "任务 #<id> <短结果>: <desc 前 60 字>", status: "proactive")
```

走 Claude Code 应用本身的通知通道，能同步到手机 Remote Control。**但在 macOS 15+ 上**，如果系统设置里没给 Claude Code 开通知权限、或权限被通知中心静默丢弃，本机就看不到桌面横幅。

#### 通道 B：桌面 dialog 兜底（osascript System Events，本机 100% 可见）

```
node ~/.claude/skills/task-queue/tasks.cjs test-push "任务 #<id> <短结果>: <desc 前 60 字>" --project-root ${PROJECT_ROOT}
```

默认走 `system-events-dialog` 通道，弹一个浮在所有窗口最前的对话框，60 秒后自动消失（可用 `TASK_QUEUE_DIALOG_TIMEOUT` 覆盖）。`--project-root` 让对话框标题显示项目名（例：`para-node-4.0`），不传时退化为 `task-queue`。这条路径绕开通知中心 codesign 限制，是本机唯一稳定可见的桌面提醒方式。

**两条都要发**，顺序不限。消息文案保持一致，例：

- "任务 #3 已完成: 改 ReqConfig label 中文"
- "任务 #5 待 review: 改了 core 热路径 resolveAgent"
- "任务 #7 阻塞: web/src/foobar.tsx 不存在?"

### S6. 最后一行输出 STATUS

输出完所有信息后，**最后一行必须**是以下三选一（小写、无多余空格、无标点）：

```
STATUS: done
STATUS: review
STATUS: block
```

主 loop 用这行判断派发是否成功；没有这行视为派发失败。

---

## Parallel Code Worker 模式

**仅当主 loop 以并行模式派发你执行单条 code 任务时按本节执行。** prompt 顶部有 `PROJECT_ROOT=` / `TASK_ID=` / `WORKTREE=`(形如 `<root>/.tasks/worktrees/task-N`)三行。

1. **只在 WORKTREE 目录内工作**。读代码、改代码都以 WORKTREE 为根。
2. 按任务 desc 执行;严守 scope、CLAUDE.md 规范、S3 同款安全护栏。
3. 改完在 WORKTREE 内跑 `buildCommands[scope]` 验证;失败重试 1 次,仍败 → 不 commit,直接返回。
4. build 通过 → `node ~/.claude/skills/task-queue/tasks.cjs done-in-worktree ${PROJECT_ROOT} ${TASK_ID}`
   - 输出 `ok:true` → 成功;`ok:false`(改了依赖文件)→ 按失败返回,reason 写进返回正文

**与串行 Subagent 模式的区别(重要,全部禁止):**
- ❌ claim / done / review / block / mark-done(主 loop 管 Excel)
- ❌ set-checklist / tick-checklist 等 checklist 命令
- ❌ heartbeat 上报
- ❌ PushNotification / test-push(主 loop 统一推)
- ❌ 触碰主仓库工作区(${PROJECT_ROOT} 下 WORKTREE 之外的文件)
- ❌ 改 package.json / 任何锁文件

**返回格式:**
- 正文 = 1-2 句 summary(改了什么/关键决策,主 loop 直接用作 commit 归档的 summary)
- 失败时正文 = 原因(风险或疑问)
- 最后一行三选一:`STATUS: done` / `STATUS: review` / `STATUS: block`

## Non-code Worker 模式

**仅当主 loop 以并行模式派发你执行单条 non-code 任务时按本节执行。** prompt 顶部有 `PROJECT_ROOT=` / `TASK_ID=` 两行。

1. 在主仓库内**只读**:可以读代码/文档/git log,可以联网调研。
2. **禁止改任何 git 跟踪文件,禁止 commit**。Excel/checklist/heartbeat/推送同样禁止(主 loop 管)。
3. 产出:
   - 篇幅长(> 30 行)→ 写 `${PROJECT_ROOT}/.tasks/reports/task-${TASK_ID}.md`(目录不存在先 mkdir -p),返回正文给摘要 + 报告路径
   - 篇幅短 → 直接写在返回正文
   - 返回正文会被主 loop 原样用作 done summary(dashboard 完成区展示),按"回答型任务"标准放开写
4. **执行中发现其实需要改代码** → 什么都不要改,返回正文写清楚要改什么/为什么,最后一行 `STATUS: needs-code`

**返回格式:** 最后一行三选一:`STATUS: done` / `STATUS: needs-code` / `STATUS: block`
