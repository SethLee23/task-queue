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
| "立即执行" / "马上扫" / "wake now" | 在面板点 ⚡ 立即执行 或 POST `/api/projects/<slug>/scan-now`：tmux 启动的 loop 走 send-keys 注入 stdin ~1s 响应；否则降级 wake-now 旗子（≤ idleSleepSeconds，默认 270s） |
| "在面板上接入/新建项目" | 提示打开 dashboard 点侧栏底部「＋ 接入项目」，向导等价于 §init 流程 |

## §init 流程

新项目首次接入，4 个问题搞定。也可以不走会话：dashboard 侧栏底部「＋ 接入项目」提供等价的 Web 向导（支持接入已有目录 / 从零新建）。

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

收集完答案，构造 answers 对象（结构见 `lib/init-core.cjs` 的 initCore JSDoc），传给：

```bash
node ~/.claude/skills/task-queue/tasks.cjs init-write <project-root> '<answers-json>'
```

### Step 4: 提交 .gitignore 入 git（关键）

`.tasks/` 整个目录都不进 git（任务表、配置、日志、附件全部属于本地工作区状态）。init-write 已在 `.gitignore` 追加 `.tasks/`，紧接着只提交 `.gitignore` 这一个文件：

```bash
cd <project-root>
git add .gitignore
git commit -m "task-queue: 接入任务队列（ignore .tasks/）"
```

注意：**必须显式列文件**，禁止 `git add -A` / `git add .` —— 用户工作区可能有 in-progress 改动，不能误带入；尤其不能把 `.tasks/` 任何内容 add 进来。

### Step 5: 收尾

告诉用户 init 完成，提醒：
- 任务表在 `<root>/.tasks/tasks.xlsx`
- 配置在 `<root>/.tasks/project.config.js`（整个 `.tasks/` 已 git ignore，本机持久，不进仓库）
- 启动 loop：让我用 `/task-queue start`

## §start 流程

启动持续任务循环。**推荐 tmux 启动**（dashboard ⚡ 按钮才能即时唤醒,不受 idleSleepSeconds 限制）。

最简流程：

```
在独立 terminal 里跑 loop，关掉当前会话不影响。

最快的做法：先打开 dashboard 面板，点项目顶上的「📋 复制启动命令」，
拿到 tmux 启动脚本（已替换 ${PROJECT_ROOT}），粘到 terminal 执行即可。

脚本形态（多行,逐行执行；session 名规约为 task-queue-loop-<slug>）：

  SESSION='task-queue-loop-<slug>'
  PROMPT_FILE="${TMPDIR:-/tmp}/tq-loop-<slug>.prompt"
  cat > "$PROMPT_FILE" <<'TQ_PROMPT_END'
  <loop-prompt.md 全文,PROJECT_ROOT 已替换>
  TQ_PROMPT_END
  tmux new-session -ds "$SESSION" -c '<project-root>' "$SHELL"
  tmux send-keys -t "$SESSION" "claude --dangerously-skip-permissions \"/loop \$(cat '$PROMPT_FILE')\"" Enter
  tmux attach -t "$SESSION"

启动后，dashboard 面板「⚡ 立即执行」按钮通过 tmux send-keys 把"扫一下"
注入 loop stdin，~1s 内 loop 响应；没用 tmux 启动则降级 wake-now 旗子，
响应延迟 ≤ idleSleepSeconds（默认 270s）。
```

**Fallback（不用 tmux）：** 用户明确不想要 tmux 时,旧形态一行命令仍然可用：

```
/loop 读 ~/.claude/skills/task-queue/loop-prompt.md 并按流程执行 ${PROJECT_ROOT} 的任务
```

但此时面板 ⚡ 按钮只能走 wake-now 文件旗子,响应延迟 ≤ idleSleepSeconds。

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
- id 在 add-row 时按 max+1 即时分配（输出 JSON 中包含 id）
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
| `done <root> <id> [summary] [--expect-clean]` | 标完成 + summary 落 note 顶部(dashboard 完成区显示),根据 config 决定 auto commit；`--expect-clean` 供 non-code lane 用（跳过 dirty-tree 警告） |
| `review <root> <id> "<风险>"` | 标待 review |
| `block <root> <id> "<疑问>"` | 标阻塞 |
| `mark-done <root> <id> "<说明>"` | 把 待review/阻塞 任务手动标记为已完成并归档（不 commit；说明落 note 顶部） |
| `status <root>` | 输出 `{todo, in_progress, review, blocked, done_today}` |
| `sweep <root>` | 把已完成/跳过剪到已完结 sheet |
| `recover <root>` | crash recovery |
| `clear-wake <root>` | 清除 wake-now 旗子（loop 在 Step 0.5 自动调，正常流程不需要手动用） |
| `dashboard [serve\|register\|unregister\|list] [--port 5732] [--host 127.0.0.1]` | 启动本地 Web 面板 / 管理注册表 |
| `heartbeat <root> [--phase <executing\|idle\|sleeping>]` | 兜底手工写心跳（claim/done 等已自动写，正常流程不需要调） |
| `plan-batch <root> [--limit N]` | 并行模式输出候选 + scope 互斥提示供主 Claude 编排 |
| `claim-batch <root> <id...>` | 原子批量 claim 多条任务 |
| `worktree-create <root> <id>` | 为任务建 git worktree（task-N 分支 + symlink node_modules） |
| `worktree-list <root>` | 列出当前 worktree 及分支 merge 状态 |
| `worktree-discard <root> <id>` | 强制销毁 worktree + 分支 |
| `done-in-worktree <root> <id>` | code worker 在 worktree 内 WIP commit（禁改依赖） |
| `merge-task <root> <id> <summary>` | 主 loop 串行 merge task 分支回 base |
| `requeue <root> <id> <reason>` | needs-code 回流：进行中→待办 + [needs-code] 标记 |

## 必读约束

执行 loop 时严格按 `loop-prompt.md`：
- 必须每条任务结束都 PushNotification
- 必须用 ScheduleWakeup 自适应 pacing（15min/3600s）
- 必须在 Step 0 跑 recover
- 严守 CLAUDE.md 项目规范
- 安全护栏：禁 push / 禁 reset --hard / 禁 --no-verify / 禁触 scope 外目录
- 并行模式下 worker subagent 禁碰 Excel/heartbeat/推送（主 loop 统一管）；code worker 只在 worktree 内 commit，merge 由主 loop 串行做；合并失败/冲突 → 转 review 并保留 worktree；人工回路：`merge-task <id> <summary>` 重试，`worktree-discard <id>` 放弃

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
- 点 "⚡ 立即执行"：tmux 启动的 loop 通过 send-keys 把"扫一下"注入 stdin，~1s 响应；非 tmux 启动则降级写 wake-now 旗子，loop 在 ≤ `idleSleepSeconds`（默认 270s）的下次唤醒时消费。paused/offline/missing 状态下按钮 disabled

> **注**：通过 API 触发（如 `POST /api/projects/<slug>/scan-now`）需带请求头 `Content-Type: application/json`。curl 示例：`curl -X POST -H 'Content-Type: application/json' http://127.0.0.1:5732/api/projects/<slug>/scan-now`

### idleSleepSeconds：响应延迟与成本平衡

> **tmux 启动的 loop 不受此设置约束** —— ⚡ 立即执行通过 send-keys 即时唤醒,只剩"完全 idle 等任务"时才走这个 sleep。

loop 空转/等待时的 sleep 间隔由 `.tasks/project.config.js` 的 `idleSleepSeconds` 字段控制（范围 [60, 3600]，默认 270）：

- **默认 270s**：刚好在 Anthropic prompt cache 5 分钟 TTL 内；非 tmux 模式下"立即执行"响应延迟 ≤ 270s
- **调大省 token**（如 1200 / 1800 / 3600）：响应慢，但显著省 cache 重建开销
- **调小更快**（如 60 / 120）：响应快，但每次 sleep < TTL 时 cache 仍命中，超过即每轮 cache miss

成本量级估算（Opus 4.7、8h/天在线、4h idle）：270s 默认 ≈ $200/月增量 vs 3600s。tmux 启动 + 调大 idleSleepSeconds 是同时拿到「即时响应」+「省 token」的组合。

### 多项目聚合

`init-write` 自动把项目加入 `~/.task-queue/projects.json` 注册表。早期 init 时漏注册的项目可手动补：

```bash
node ~/.claude/skills/task-queue/tasks.cjs dashboard register /path/to/project
```

### 安全

默认仅监听 loopback。若需局域网访问：`--host 0.0.0.0`，但无认证，请勿暴露公网。

## §parallel 并行执行

一轮 /loop 可并发派多个 subagent，显著提升多条互不相干任务的吞吐。

### 开启

`.tasks/project.config.js` 的 `parallel` 字段（新 init 项目默认开启；存量项目缺字段 = 关闭，纯串行不变）：

```js
parallel: {
  enabled: true,        // 总开关
  maxConcurrency: 3,    // 一轮最多并发几个 subagent
  allowSameScope: true, // 同 scope 任务是否允许并行(由主 Claude 判 desc 文件不重叠)
}
```

### 两条 lane

- **code 任务**（改代码/仓库文件）：每条进独立 git worktree（`task-N` 分支，node_modules symlink 共享），worker 改完 commit 到分支，主 loop 串行 ff/rebase merge 回 base。冲突 → 转 review 保留 worktree。
- **non-code 任务**（调研/问答/分析）：不开 worktree，只读主仓库，产出写 `.tasks/reports/` 或直接回正文，返回即归档（不产生 commit）。

### 一轮最多几个

`maxConcurrency`（默认 3）是硬上限；code 任务还受 scope 互斥（`allowSameScope=false` 时每 scope 一轮最多 1 条）。non-code 不占 scope 互斥。

### 成本与限制

- 每个并发 subagent = 一份独立 token 消耗 + 一次独立 build，maxConcurrency 调大需自担机器/token 压力。
- 并行模式禁止改依赖文件（package.json/锁文件）—— done-in-worktree 会拒绝；真要改依赖临时关 parallel 走串行。
- 单 scope 项目若 `allowSameScope=false`，code 任务退化串行（推荐配置默认 true）。

### 人工回路

- merge 冲突的任务转 review，worktree 保留在 `.tasks/worktrees/task-N`。解决后 `tasks.cjs merge-task <root> <id> <summary>` 重试，或 `tasks.cjs worktree-discard <root> <id>` 放弃。
- `tasks.cjs worktree-list <root>` 看当前所有 worktree 状态。
