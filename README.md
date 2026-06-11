# task-queue

> Claude Code skill — 用 Excel 管理任务，让 Claude 在独立 `/loop` 会话里自动执行、commit、推送通知，并通过本地 Web 面板跨项目监控。

把"我手里一堆零碎任务"变成"Claude 在后台一条一条做完"，不打断你正在做的事。

---

## 它解决什么问题

- 你脑子里攒了 20 条琐碎需求（修 bug / 调样式 / 改文案），手敲又懒、丢着又忘。
- 在 `.tasks/tasks.xlsx` 里加几行，Claude 自己读、自己做、自己 commit，每 15–60 分钟扫一次。
- 多个项目并行跑 loop？打开 `http://127.0.0.1:5732` 一眼看清"谁在跑哪条、谁阻塞了、谁今天做完几条"。
- 互不相干的多条任务？开启并行模式（`parallel.enabled: true`），一轮 /loop 并发派多个 subagent，code 任务进独立 worktree，non-code 任务直接归档，吞吐成倍提升。

## 核心机制

| 组件 | 作用 |
|---|---|
| `.tasks/tasks.xlsx` | 任务表（todo / in_progress / review / blocked / done） |
| `.tasks/project.config.js` | 项目级配置：自动 commit 的 scope、版本号策略、commit 模板 |
| `loop-prompt.md` | Claude `/loop` 的行为契约（Step 0 recover → Step 1 next → Step 4 claim → ... → ScheduleWakeup） |
| `~/.task-queue/projects.json` | 全局项目注册表，供 dashboard 聚合 |
| Web dashboard | 本地 HTTP 服务，5s 轮询展示所有已注册项目 |

## 安装

```bash
git clone https://github.com/SethLee23/task-queue.git ~/.claude/skills/task-queue
cd ~/.claude/skills/task-queue
npm install --omit=dev
```

需要 Node ≥ 18。Skill 会在被 Claude 调用时自动检查依赖。

## 5 分钟上手

### 1. 在一个项目里接入

```
你：/task-queue init
Claude：[问 4 个问题确认 scope/commit 模板/同日复用版本号]
       → 落盘 .tasks/ 目录 + project.config.js
       → 自动 git commit 配置文件
```

### 2. 加几条任务

```
你：加一条任务 "登录按钮没居中"
Claude：→ add-row . "登录按钮没居中" web 中
```

或者直接打开 `.tasks/tasks.xlsx` 手填。

### 3. 启动 loop（在独立终端）

**推荐 tmux 启动** —— 面板 ⚡ 按钮才能即时唤醒。最快做法：先开 dashboard（§4），点项目顶上的「📋 复制启动命令」按钮，拿到 tmux 启动脚本（已替换 PROJECT_ROOT），粘到 terminal 跑即可。脚本形态：

```bash
SESSION='task-queue-loop-<slug>'
PROMPT_FILE="${TMPDIR:-/tmp}/tq-loop-<slug>.prompt"
cat > "$PROMPT_FILE" <<'TQ_PROMPT_END'
<loop-prompt.md 全文,PROJECT_ROOT 已替换>
TQ_PROMPT_END
tmux new-session -ds "$SESSION" -c '/path/to/project' "$SHELL"
tmux send-keys -t "$SESSION" "claude --dangerously-skip-permissions \"/loop \$(cat '$PROMPT_FILE')\"" Enter
tmux attach -t "$SESSION"
```

**Fallback** —— 不想用 tmux 时,旧形态一行仍可用,但面板 ⚡ 只能走 wake-now 旗子,响应 ≤ idleSleepSeconds（默认 270s）:

```
/loop 读 ~/.claude/skills/task-queue/loop-prompt.md 并按流程执行 /path/to/project 的任务
```

Claude 会自适应 pacing（15–60 分钟），每条任务结束推一次桌面通知。

### 4. 打开 dashboard 看进度

```bash
node ~/.claude/skills/task-queue/tasks.cjs dashboard
# dashboard ready at http://127.0.0.1:5732
```

面板能力：
- 看每个项目当前在跑哪条 + 上次心跳 + 模型
- 点 **skip** 跳过一条待办 / 待 review / 阻塞
- 点 **改优先级** 调高/中/低
- 点 **pause** 暂停 loop（不打断正在执行的任务，下一轮 next 不取新任务）
- 点 **resume** 恢复
- 点 **⚡ 立即执行** —— tmux 启动的 loop 通过 send-keys 把"扫一下"注入 stdin（~1s 响应,跳过 ScheduleWakeup 倒计时);非 tmux 启动则降级 wake-now 旗子（≤ idleSleepSeconds）
- 点 **📋 复制启动命令** 拿到 tmux 启动脚本（带 PROJECT_ROOT 替换）
- 点 **删除** 把项目移出注册表
- **＋ 接入项目**：侧栏底部按钮，双 tab 向导（接入已有目录 / 从零新建并 git init），表单复刻 init 4 问，提交即落盘 `.tasks/` 并自动 commit `.gitignore`

> **tmux session 名规约**: `task-queue-loop-<slug>`。loop 退出但 session 残留时,⚡ 会把"扫一下"键入裸 shell —— 看到 phase=offline 时执行 `tmux kill-session -t task-queue-loop-<slug>` 后重启。

## 子命令速查

| 命令 | 用途 |
|---|---|
| `detect <root>` | 静态分析项目，输出建议配置 JSON |
| `init-write <root> <answers-json>` | 落盘 .tasks/ 配置 |
| `add-row <root> <desc> <scope> [priority] [note]` | 追加待办任务 |
| `next <root>` | 输出下一条待办（按优先级） |
| `claim <root> <id\|auto>` | 状态置进行中 |
| `done <root> <id>` | 标完成，可选 auto commit |
| `review <root> <id> "<风险>"` | 标待 review |
| `block <root> <id> "<疑问>"` | 标阻塞 |
| `status <root>` | 输出队列概况 |
| `sweep <root>` | 已完成/跳过 归档到已完结 sheet |
| `recover <root>` | crash recovery |
| `test-push [message]` | 测试 macOS 桌面通知通道 |
| `dashboard [serve\|register\|unregister\|list] [--port 5732] [--host 127.0.0.1]` | Web 面板 / 注册表管理 |
| `heartbeat <root> [--phase <executing\|idle\|sleeping>]` | 兜底手工写心跳（正常流程不需要） |

完整 LLM 行为契约见 [`SKILL.md`](./SKILL.md) 和 [`loop-prompt.md`](./loop-prompt.md)。

## 项目结构

```
.
├── SKILL.md              # Claude skill 元数据 + 行为约束
├── loop-prompt.md        # /loop 模式的步骤契约
├── tasks.cjs             # CLI 入口
├── commands/             # 子命令实现
│   ├── dashboard-server.cjs   # HTTP server
│   ├── claim/done/review/...  # 任务状态机
│   └── ...
├── lib/                  # 共享工具
│   ├── workbook.cjs      # Excel 读写（套 mkdir 锁）
│   ├── lock.cjs          # 自旋互斥锁
│   ├── heartbeat.cjs     # 任务级心跳
│   ├── paused.cjs        # pause flag 文件
│   ├── registry.cjs      # 全局项目注册表
│   └── slug.cjs
├── web/                  # dashboard 前端（纯 DOM，无框架）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── tests/                # node:test，143 个用例
```

## 安全

- Dashboard 默认仅监听 `127.0.0.1`，**未带认证**。`--host 0.0.0.0` 暴露局域网请自担风险，不要暴露公网。
- Loop 严守安全护栏：禁 `git push` / `reset --hard` / `--no-verify` / 触碰 scope 外目录。
- 桌面通知优先 System Events dialog（macOS 15 通知中心权限问题的 workaround）。

## 平台

- 主要在 **macOS** 上验证（桌面通知通道是 macOS 专属）
- 任务表读写 / dashboard 跨平台
- Linux/Windows 上桌面通知通道暂未实现，欢迎 PR
- **tmux 是 ⚡ 即时唤醒的依赖**（macOS / Linux 通用;不装 tmux 仍能用,只是 ⚡ 走 wake-now 旗子 fallback）

## 版本

- **v0.2.0** — 本地 Web 控制面板（多 project 聚合 + skip/priority/pause/resume + 任务级心跳）
- v0.1.2 — `test-push` 桌面通知通道工具
- v0.1.1 — `add-row` 命令 + SKILL.md §init/start/add 完整化
- v0.1.0 — 初版（Excel 任务表 + /loop 自动执行）

## License

MIT
