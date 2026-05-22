# task-queue loop 流程

你正在 `${PROJECT_ROOT}` 项目执行任务循环。每次唤醒严格按以下步骤：

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

## Step 0.1: 上报模型 ID（面板显示用）

从系统提示中读取当前会话的模型精确 ID（例如 `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5-20251001`），写入 heartbeat：

```
node ~/.claude/skills/task-queue/tasks.cjs heartbeat ${PROJECT_ROOT} --model <claude-model-id>
```

每轮唤醒都跑一次（成本极低，覆盖会话切换/模型升级场景）。dashboard 会读这个字段显示"模型 xxx"。

## Step 0.5: 检查暂停 & 唤醒旗子

```
node ~/.claude/skills/task-queue/tasks.cjs status ${PROJECT_ROOT}
```

读输出：

- `"paused": true` → 跳到 Step 5（不执行 next/claim）
- `"wakeNow": true`（无论 paused 与否）→ 调
  ```
  node ~/.claude/skills/task-queue/tasks.cjs clear-wake ${PROJECT_ROOT}
  ```
  然后正常继续（旗子仅用作 UI 反馈/防误点，清掉避免下轮误判）
- 记下 `idleSleepSeconds` 字段值（Step 5 要用，默认 270）

设计意图：面板的 pause 只影响"取下一条"，不打断正在执行的任务；wake-now 旗子是 dashboard "⚡ 立即执行" 按钮触发的，loop 见到后只需消费旗子，实际响应延迟由 idleSleepSeconds 控制。

## Step 1: 取下一条任务

```
node ~/.claude/skills/task-queue/tasks.cjs next ${PROJECT_ROOT}
```

- 输出 `null` → 跳到 Step 5（决定下次唤醒间隔）
- 输出 JSON `{id, desc, scope, priority, note}` → 进入 Step 2

## Step 2: claim

```
node ~/.claude/skills/task-queue/tasks.cjs claim ${PROJECT_ROOT} <id>
```

claim 完成后，**必须**检查 `note` 字段顶部是否含 `[<用户名> 回复 LATEST YYYY-MM-DD HH:mm] ...` 块：

- 有 → 这是用户对此前 review/block 的**最新**答复，**必须**先把答复完整读完再开工；按答复要求调整方案/范围/做法
- 无 → 正常按 desc 执行

note 里只可能有 **1 个** `[<用户名> 回复 LATEST ...]` 块（每次新 reply 都会自动把现存 LATEST 降级为 OBSOLETE）。看到 `[<用户名> 回复 OBSOLETE ...]` 或更老的 `[reply OBSOLETE ...]` 块表示这是更早的历史回复，**仅作背景理解，不要按它执行**——否则你会重复犯之前已经被新 LATEST 推翻的错误。

reply 块两种形态：
- 普通追加：`[<用户名> 回复 LATEST 时间] 答复内容`（用户只是补充信息，task 状态没变）
- 恢复型（阻塞/review 转 todo 时）：
  ```
  [<用户名> 回复 LATEST 时间]
  A: 用户的答复
  Q: AI 此前提的疑问 / Risk: AI 此前标的风险
  ```
  这是完整 Q&A 上下文，**A 行在前是为了让用户一眼看见自己说了什么**；AI 原疑问/风险已从 question/risk 字段迁移到此处，**字段会被清空属预期行为**，历史在 note 里保全。

reply 块只用于读取上下文，**不要清除或改写它**；done/review/block 自然会把新内容追加到 note 顶部，旧块自动保留为历史。

## Step 3: 执行任务

按 `desc` 字段描述执行，严格遵守：

- 任务范围 `scope` 必须严守，不动 scope 外的文件
- 编辑前先 Read 相关文件
- 改完后跑 `project.config.js` 中 `buildCommands[scope]` 验证编译
- 严守 `CLAUDE.md` 中的性能纪律（"配置期贵运行期贱"）、TypeScript/SCSS 规范
- 严守安全护栏：禁止 push、reset --hard、checkout --、--no-verify、--amend
- 严守 scope 外目录禁触碰（core/static/gwadmin、snackbar、yaum-login 等 CLAUDE.md 明示的外部资源）

## Step 4: 根据结果调用结束命令

四类结局（必须三选一）。**路径引用约定**（写 `<风险描述>` / `<疑问>` / done 后追加 note 时都适用）：

- 引用项目内文件 → 写**相对项目根**的完整路径：`web/src/foo.tsx`、`web/src/foo.tsx:42`、`web/src/foo.tsx:42:7`
- 引用项目外文件 → 写**绝对路径**：`/Users/...` 或 `~/.claude/...`
- 引用 URL → 完整 `https://...`
- **禁止**：单独写文件名（如 `foo.tsx`）—— dashboard 解析为相对根目录会找不到；除非该文件确实在项目根目录

dashboard 会自动识别这些路径并渲染成可点击的链接（点击用 VS Code 打开，没装就用系统默认）。完整路径是让点击真能跳到文件的硬要求。

### 4a. 全部成功

```
node ~/.claude/skills/task-queue/tasks.cjs done ${PROJECT_ROOT} <id> "<summary>"
```

summary **必传且不能省略**,是给人看的"完成回复",落到任务 note 顶部 `[done 时间]` 块,dashboard "今日完成"区直接显示。空 summary = 用户在 dashboard 上看不到你做了什么/答了什么 = 用户会愤怒。

按任务类型决定 summary 内容与长度:

**执行型任务**(改代码 / 加测试 / 配置变更等):1-2 句话简述
- 关键改动文件/模块(超过 3 个只点一两个代表)
- 关键决策或权衡(为什么这么做,不是怎么做)
- 后续注意事项(若有)

示例:
- `"改 ReqConfig.tsx 把'请求名称' label 简化为'名称';顺手把 minWidth 从 120 调到 96 收紧表格"`
- `"Playwright config + 1 个 router e2e case 落地;约定 baseURL=127.0.0.1:3000 复用 dev server"`

**回答型任务**(desc 含"是什么"/"为什么"/"怎么"/"?"/"解释"/"分析"等,或贴图问"这是啥"):summary **就是完整答案**,放开写。dashboard "今日完成"区是单列宽栏,有足够空间显示多段落长文本。换行 + 文件路径直接写 —— linkifyText 会自动把路径/URL 渲染成可点击链接。

示例:
- `"这 5 个文件分两组:\ndocs/ 内容(按生成顺序):\n1. para-ui-issues.csv — 历史手记,14 条具体问题(TextField onChange...)\n2. para-ui-reflections.md — 组件级反思笔记\n3. scripts/gen-findings.cjs — 单源生成脚本,把上面两个手记合成下面产物\n4. para-ui-findings.md — 给 paraui 团队看的 POC 自检报告 Markdown 版\n5. para-ui-findings.xlsx — 同源 Excel 版\n\n简化:csv + reflections.md 是原料,gen-findings.cjs 是加工脚本,findings.md/.xlsx 是成品"`

done 命令内部决定是否 auto commit:
- scope.autoCommit=true 且无 inferModule 失败 → 自动 commit + 归档(note 顶部块含 commit hash · 【模块】 版本号 + summary)
- 否则 → 自动转 review 流程(summary 在这条路径会丢失,你可以把关键信息塞进下面 4b 的 review 风险描述里)

### 4b. 软失败（功能完成但有担心需 review）

```
node ~/.claude/skills/task-queue/tasks.cjs review ${PROJECT_ROOT} <id> "<风险描述>"
```

例：单测红、改了热路径、修了公共组件、touched 文件超出预期范围。

### 4c. 硬失败（任务描述卡壳）

```
node ~/.claude/skills/task-queue/tasks.cjs block ${PROJECT_ROOT} <id> "<疑问>"
```

例：文件路径不存在、需求歧义、TS 报错改不出来、build 失败。

### 4d. 环境失败

先重试 1 次（rm -rf node_modules && npm install / 重新跑 build）。仍败按 4c 硬失败处理。

## Step 4.5: 推送通知（必须，每条任务都推；两条通道都要发）

无论 done/review/block 之后，必须**并行调用两个推送通道** —— 单独哪一条都可能失效：

### 通道 A：Claude 内置 PushNotification（手机/Remote Control）

```
PushNotification(message: "任务 #<id> <短结果>: <desc 前 60 字>", status: "proactive")
```

走 Claude Code 应用本身的通知通道，能同步到手机 Remote Control。**但在 macOS 15+ 上**，如果系统设置里没给 Claude Code 开通知权限、或权限被通知中心静默丢弃，本机就看不到桌面横幅。

### 通道 B：桌面 dialog 兜底（osascript System Events，本机 100% 可见）

```bash
node ~/.claude/skills/task-queue/tasks.cjs test-push "任务 #<id> <短结果>: <desc 前 60 字>"
```

默认走 `system-events-dialog` 通道，弹一个浮在所有窗口最前的对话框，60 秒后自动消失（可用 `TASK_QUEUE_DIALOG_TIMEOUT` 覆盖）。这条路径绕开通知中心 codesign 限制，是本机唯一稳定可见的桌面提醒方式（macOS 15.6 已验证 terminal-notifier / osascript display notification 都会被静默丢弃）。

**两条都要发**，顺序不限。消息文案保持一致，例：

- "任务 #3 已完成: 改 ReqConfig label 中文"
- "任务 #5 待 review: 改了 core 热路径 resolveAgent"
- "任务 #7 阻塞: web/src/foobar.tsx 不存在?"

## Step 5: 决定下次唤醒间隔

```
node ~/.claude/skills/task-queue/tasks.cjs status ${PROJECT_ROOT}
```

读 `idleSleepSeconds`（Step 0.5 已读过可直接复用，默认 270；范围 [60, 3600]）。

- `todo > 0` → 还有积压，立刻回 Step 1 继续（不睡）
- `todo == 0 && (review > 0 || blocked > 0)` → `ScheduleWakeup <idleSleepSeconds>s "等用户处理 review/blocked（cap 内可被面板立即执行唤醒）"`
- 全 0 → `ScheduleWakeup <idleSleepSeconds>s "队列空（cap 内可被面板立即执行唤醒）"`

## 异常路径

如果 tasks.cjs 任何命令退出码非 0 且 stderr 含 "task-queue 错误"：
- 不前进任何状态
- 推送 "task-queue 异常: <错误头部>，请检查 .tasks/logs/"（两条通道都发，同 Step 4.5）
- `ScheduleWakeup 3600s "skill 异常等修复"`

如果 Excel 文件被锁（命令输出含 "EAGAIN" 或类似）：
- 推送 "Excel 正在打开，本轮跳过"（两条通道都发）
- `ScheduleWakeup 60s "等 Excel 关闭"`
