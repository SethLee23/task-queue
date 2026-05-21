---
name: task-queue
description: 任务队列自动化 — 用户在 Excel 加任务，配合 /loop 唤醒 Claude 自动读取、执行、commit、推送通知。多项目通用，通过 .tasks/project.config.js 适配各项目的提交规范和编译命令。当用户说"扫一下任务"、"看看任务表"、"开始干"、"启动任务循环"、"task-queue init / start / add"时使用。
---

# task-queue skill

把 Excel 任务表 → Claude 自动执行的工作流封装为跨项目通用 skill。

## 用户喊词识别

| 用户说 | 行动 |
|---|---|
| `/task-queue init` / "在这个项目接入任务队列" | 走 §init 流程 |
| `/task-queue start` / "启动任务循环" / "开始干" | 走 §start 流程 |
| `/task-queue add <desc>` / "加一条任务" | 走 §add 流程 |
| "测试推送" / "测下通知" / "试试桌面通知" | 跑 `test-push` 命令验证桌面通道 |
| "扫一下任务表" / "看看任务表" | 跑 `status` 命令展示队列概况 |
| "处理一条任务" | 跑 1 轮 Step 1-4.5（不进 loop） |
| `/task-queue dashboard` / "启动面板" / "打开控制台" | 跑 `dashboard` 启动 Web 服务，告知 URL |
| "暂停队列" / "pause loop" | 跑 `dashboard pause <slug>` 或提示在面板操作 |
| "恢复队列" / "resume loop" | 跑 `dashboard resume <slug>` 或提示在面板操作 |

## §init 流程

新项目首次接入，4 个问题搞定。

### Step 1: 探测

```bash
node ~/.claude/skills/task-queue/tasks.cjs detect <project-root>
```

读输出 JSON。

### Step 2: 用 AskUserQuestion 收集答案（最多 4 题）

**Q1 自动 commit 名单**（基于 detect.packages 推 scope 名）：
- 多 package（monorepo）→ 选项列出每个 scope，让用户多选
- 单 package → 选项：是 / 否
- 推荐：仅 web 类 scope，core 类不允许

**Q2 commit 模板预览**（带 preview）：
- 用 detect.commitPattern.detected 渲染示例（用当前版本号 + 一个示例模块名）
- 选项：A 确认 / B 修改（修改时让用户在 Other 里写）

**Q3 候选模块名**：
- preview 显示 detect.packages[].candidateModules 的并集
- 选项：A 全接受 / B 增删（让用户在 Other 里写差异）

**Q4 同日复用版本号**：
- 推荐基于 detect.sameDayShareVersion 的判断（likely_true → A 默认推荐）
- 选项：A 是 / B 否

### Step 3: 拼装 answers JSON 并调 init-write

收集完答案，构造 answers 对象（结构见 `commands/init-write.cjs` 头部注释），传给：

```bash
node ~/.claude/skills/task-queue/tasks.cjs init-write <project-root> '<answers-json>'
```

### Step 4: 提交配置入 git（关键）

为避免首次 `done` 把 `.tasks/` 整个目录一起 commit（`.gitignore` 在 init 期间是 untracked，`git add` 时会被一并加入），init-write 一旦成功，立刻显式提交 `.gitignore` 和 `.tasks/project.config.js`：

```bash
cd <project-root>
git add .gitignore .tasks/project.config.js
git commit -m "task-queue: 接入任务队列配置"
```

注意：**必须显式列文件**，禁止 `git add -A` / `git add .` —— 用户工作区可能有 in-progress 改动，不能误带入。

### Step 5: 收尾

告诉用户 init 完成，提醒：
- 任务表在 `<root>/.tasks/tasks.xlsx`
- 配置在 `<root>/.tasks/project.config.js`（已 git ignore 任务表和日志）
- 启动 loop：让我用 `/task-queue start`

## §start 流程

启动持续任务循环。

```
建议在一个独立的常驻 terminal 里启动这个 loop，关掉这个会话不影响。

启动命令（请你复制到目标终端执行 /loop）：

  /loop 读 ~/.claude/skills/task-queue/loop-prompt.md 并按流程执行 ${PROJECT_ROOT} 的任务

将 ${PROJECT_ROOT} 替换为：<absolute project root>

启动后，每 15-60 分钟 Claude 会自动扫一次任务表。
```

不要在当前会话直接调用 /loop（除非用户明示）—— 当前会话用来设计/初始化，loop 应该跑在独立会话避免冲突。

## §add 流程

用户说"加一条任务 xxx"，你直接：

1. 拆解用户描述 → 推断 scope（看任务描述里提到的目录关键字；match `web/` → web，match `core/` → core）
2. 推断优先级（用户语气："紧急/急/立刻" → 高，普通 → 中，"有空再做" → 低）
3. 调 `add-row`：

```bash
node ~/.claude/skills/task-queue/tasks.cjs add-row <project-root> "<desc>" <scope> [priority] [note]
```

例：

```bash
node ~/.claude/skills/task-queue/tasks.cjs add-row /path/proj "登录按钮没居中" web 中
```

- `priority` 不传默认 `中`；只接受 `高`/`中`/`低`
- `scope` 必须在 project.config.js 已知 scopes 中，否则命令报错
- id 留空，由后续 `claim` 时自动分配为最大 id + 1
- 不要让用户直接打开 Excel 加 —— 走命令一致性更好

## 子命令一览（速查）

| 命令 | 用途 |
|---|---|
| `detect <root>` | 静态分析，输出 JSON |
| `init-write <root> <answers-json>` | 落盘 .tasks/ 目录和 project.config.js |
| `add-row <root> <desc> <scope> [priority] [note]` | 追加一条待办任务（id 留空，待 claim 时自动分配） |
| `test-push [message]` | 触发 macOS 原生桌面通知，绕过 Claude 60s 反打扰；用于随时测试通道 |
| `next <root>` | 输出下一条待办（按优先级排序） |
| `claim <root> <id\|auto>` | 状态置进行中 |
| `done <root> <id>` | 标完成，根据 config 决定 auto commit |
| `review <root> <id> "<风险>"` | 标待 review |
| `block <root> <id> "<疑问>"` | 标阻塞 |
| `status <root>` | 输出 `{todo, in_progress, review, blocked, done_today}` |
| `sweep <root>` | 把已完成/跳过剪到已完结 sheet |
| `recover <root>` | crash recovery |
| `dashboard [serve\|register\|unregister\|list] [--port 5732] [--host 127.0.0.1]` | 启动本地 Web 面板 / 管理注册表 |
| `heartbeat <root> [--phase <executing\|idle\|sleeping>]` | 兜底手工写心跳（claim/done 等已自动写，正常流程不需要调） |

## 必读约束

执行 loop 时严格按 `loop-prompt.md`：
- 必须每条任务结束都 PushNotification
- 必须用 ScheduleWakeup 自适应 pacing（15min/3600s）
- 必须在 Step 0 跑 recover
- 严守 CLAUDE.md 项目规范
- 安全护栏：禁 push / 禁 reset --hard / 禁 --no-verify / 禁触 scope 外目录

## §dashboard 流程

### 启动面板

```bash
node ~/.claude/skills/task-queue/tasks.cjs dashboard
```

默认 `127.0.0.1:5732`。打开浏览器访问该 URL 即可看到所有已注册项目的实时状态。

面板能力：
- 看每个项目的 `phase`（运行中/等待中/离线）+ 当前任务 desc
- 点 "skip" 跳过一条待办
- 点 "改优先级" 调整待办的高/中/低
- 点 "pause" 暂停 loop（正在执行的任务跑完后停下；下一轮 next 不取）
- 点 "resume" 恢复

### 多项目聚合

`init-write` 自动把项目加入 `~/.task-queue/projects.json` 注册表。早期 init 时漏注册的项目可手动补：

```bash
node ~/.claude/skills/task-queue/tasks.cjs dashboard register /path/to/project
```

### 安全

默认仅监听 loopback。若需局域网访问：`--host 0.0.0.0`，但无认证，请勿暴露公网。
