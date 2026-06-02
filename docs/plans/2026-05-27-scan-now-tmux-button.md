# task-queue「⚡ 立即执行 / 扫一下」tmux 注入 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 superpowers:executing-plans。Steps 用 `- [ ]` checkbox 跟踪。

**Goal:** 现在的「⚡ 立即执行」按钮走 wake-now 文件旗子,响应时间 ≤ `idleSleepSeconds`(默认 270s),不够"即时"。本次给 loop 增加一条**真正即时**的唤醒路径 — 让面板按钮通过 `tmux send-keys` 把 `扫一下` 注入到运行 loop 的 tmux 会话 stdin,Claude 把它当作普通 user input 立刻处理(典型 1-2s 内 claim 任务、卡片从「待办」可视化移到「进行中」)。

**Why tmux:** macOS 自 10.14 起禁止 `TIOCSTI` 直接向任意 TTY 注入,但 tmux 自己管 pty,`send-keys` 是合法 API。这是目前找到的、不改 Claude Code 二进制的唯一稳定路径。

**Fallback:** tmux 会话不存在(用户没用 tmux 启动,或会话已退出)时降级到现有 wake-now 文件旗子,行为同今天。

---

## 完成判据(Definition of Done)

- [ ] 用户用新文档里的 tmux 启动命令把 loop 跑起来后,在 dashboard 点「⚡ 立即执行」:
  - 后端 1s 内返回 `{ok: true, mode: 'tmux'}`
  - loop 终端可见出现一行 `扫一下`,Claude 立刻接管(无视 ScheduleWakeup 倒计时)
  - **2s 内**面板自动 refresh 一次,目标任务卡片可见从「待办」挪到「进行中」(claim 落 xlsx + heartbeat → 5s 轮询前的强制 refresh 把它捞回来)
- [ ] 用户没用 tmux 启动(传统直接 `claude '/loop ...'`)时,同一个按钮降级走 wake-now 文件旗子,返回 `{ok: true, mode: 'wake-flag'}`,前端提示文案变成"已发出立即执行请求,等 loop 响应"(同今天)
- [ ] `dashboard-server` 全部新增/修改测试通过(`npm test`)
- [ ] `loop-prompt.md` §start 段同步成 tmux 启动指引;明确"`扫一下`"是合法的用户主动唤醒输入
- [ ] `SKILL.md` 喊词表 + dashboard 段同步;`README.md` 至少提一句 tmux 启动 + send-keys 注入
- [ ] 不破坏:已有 `wake-now` API 路径保留,旧 worktree 启动方式(直接 `claude`)依然可用;dashboard 加任务、skip、改优先级等按钮行为不变

---

## 设计决定

### Session 命名

`task-queue-loop-<slug>` —— slug 已经做过 `rootToSlug` 规范化(`lib/slug.cjs`),长度受控、字符集安全,直接作为 tmux session 名。

启动命令样例(后端 `handleLoopCommand` 输出):

```bash
SESSION='task-queue-loop-<slug>'
tmux new-session -ds "$SESSION" -c '<absolute project root>' "$SHELL"
tmux send-keys -t "$SESSION" 'claude --dangerously-skip-permissions '\''/loop <loop-prompt 内容>'\''' Enter
tmux attach -t "$SESSION"
```

为什么两步(new-session + send-keys 而不是 `tmux new-session -ds ... 'claude /loop ...'`):
- 直接把整段 prompt 塞进 new-session 的 command 参数,要做三层引号嵌套(shell → tmux → claude),loop-prompt 里随便一个单引号都会炸。
- send-keys 走 tmux 自己的输入通道,只剩一层 shell-escape,鲁棒得多。

### 新端点 vs 复用 wake-now

**新增 `POST /api/projects/:slug/scan-now`**,不复用 wake-now。理由:
- 语义不同:wake-now = "在下次 sleep 醒来时尽快开干",scan-now = "立刻把字符送进 stdin"。混在一个端点里返回字段会乱。
- 前端要按 mode 切换提示文案(`扫一下已注入` vs `已发出请求,等 loop 响应`),分两个端点最干净。
- wake-now 老端点对 paused / offline 项目的处理逻辑保留不动。

### 响应延迟与可视化

按钮点击后,后端做完 tmux send-keys 通常 < 100ms 返回。但**用户看到卡片从「待办」挪到「进行中」需要等 loop 完成一轮**:
1. tmux stdin 收到 `扫一下\n` → Claude 唤醒
2. Claude 跑 Step 0.5 status → Step 1 next → Step 2 claim (写 xlsx + heartbeat)
3. dashboard 下一次 5s 轮询拿到新状态 → UI 更新

实测预期 1-2s 完成 claim。前端在按钮 onclick 成功后做一次 `setTimeout(refreshProjects, 1500)` 强制 refresh,让用户不用等下一个 5s tick。

### tmux 检测:has-session

`tmux has-session -t <session>` 退出码 0 = 存在,非 0 = 不存在(或 tmux server 没起)。这就是分支条件,不需要 list-sessions 解析。

注意:`tmux has-session` 即使在 tmux server 没启动时也会 silently 不创建 server 而返回非 0(取决于版本)。为稳妥起见,先 `tmux has-session -t ... 2>/dev/null`,任何非 0 即视为"不存在",走 fallback。

### 失败语义

- tmux 二进制不存在(`which tmux` 不到):捕获 ENOENT → fallback wake-now,前端日志 console.warn 一句,UI 仍显示 wake-flag 模式提示
- tmux session 存在但 send-keys 失败(罕见):返回 500 + 错误信息,前端 alert
- tmux session 存在但 Claude 已退出(loop 死掉了只剩裸 shell):**这条不可恢复地把 `扫一下` 当 shell 命令执行**。本期不做主动检测(成本太高),用户会自己注意到 dashboard 上的 phase=offline,然后重启 loop。文档里把这条作为已知限制写出来。

---

## 文件结构总览

### 新建

```
tests/
  dashboard-server.scan-now.test.cjs       # 新端点的 tmux / fallback 两路径测试
```

### 改动

```
commands/dashboard-server.cjs              # +handleScanNow;+/api/projects/:slug/scan-now 路由;handleLoopCommand 输出 tmux 两段命令
web/app.js                                  # ⚡ 立即执行按钮指向新端点;onclick 成功后 setTimeout(refreshProjects, 1500);复制启动命令文案 + title 同步
loop-prompt.md                              # §start 改 tmux 启动;加"扫一下"作为合法主动唤醒输入说明
SKILL.md                                    # 喊词表 + dashboard 段同步
README.md                                   # 提一句 tmux 启动 + send-keys 注入
```

不动:`lib/wake.cjs`、`lib/slug.cjs`、`lib/registry.cjs` —— 完全复用现成原语。

---

## Task 1: 后端 — `scan-now` 端点 + 启动命令切到 tmux

**Files:**
- Modify: `commands/dashboard-server.cjs`
- Create: `tests/dashboard-server.scan-now.test.cjs`

**约束:**

- 新端点 `POST /api/projects/:slug/scan-now`,body 可空
- 流程:slug 校验 → 注册表查 entry → 拼 sessionName = `task-queue-loop-<slug>` → `execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' })`:
  - 成功:`execFileSync('tmux', ['send-keys', '-t', sessionName, '扫一下', 'Enter'])` → `sendJson(res, 200, { ok: true, mode: 'tmux' })`
  - 抛错:`setWakeNow(entry.root, '面板立即执行')` → `sendJson(res, 200, { ok: true, mode: 'wake-flag' })`
- tmux 二进制不存在时 execFileSync 抛 ENOENT,被同一个 catch 兜走 fallback
- `handleLoopCommand` 重写 command 输出:三行 shell(SESSION 变量 + new-session + send-keys + attach),保持当前 `cd` + `--dangerously-skip-permissions` 语义。Response 字段从 `{command, projectRoot}` 加一个 `{sessionName}` 方便前端将来用

**测试覆盖:**
- `tmux has-session 成功 → 走 send-keys 路径,返回 mode:'tmux'`:mock `execFileSync` 第一次成功、第二次成功,断言返回体
- `tmux has-session 失败 → 走 wake-now 旗子,返回 mode:'wake-flag'`:mock `execFileSync` 第一次抛错,断言 `wakeNowPath` 文件存在 + 返回体 mode
- `slug 不存在 → 404`
- `slug 格式非法 → 400`

**Step-by-Step:**

- [ ] **Step 1: 写 4 个失败测试**(挂 mock 让 execFileSync 走假分支,验证 mode 字段)
- [ ] **Step 2: 实现 `handleScanNow`**(execFileSync + try/catch)
- [ ] **Step 3: 在 path 路由表里挂 `/api/projects/:slug/scan-now` → handleScanNow**
- [ ] **Step 4: 重写 `handleLoopCommand` 的 command 字符串**,response 加 sessionName
- [ ] **Step 5: 测试全过**

---

## Task 2: 前端 — 按钮指向新端点 + 可视化 refresh

**Files:**
- Modify: `web/app.js`

**约束:**

- `wakeNowProject` 函数改名为 `scanNowProject`(或保留原名内部调新端点,看哪个改动小),POST 改 `/api/projects/${state.selectedSlug}/scan-now`,body `{}`
- 成功响应根据 `mode` 字段做差异提示:
  - `mode === 'tmux'`:不弹 alert,只在按钮上短暂显示「✓ 已注入」文案 1.5s 然后恢复
  - `mode === 'wake-flag'`:行为同今天(按钮变 `⏳ 唤醒中…`,等下次状态轮询自然恢复)
- 成功后 `setTimeout(() => refreshProjects(), 1500)` 强制 refresh 一次,让卡片状态变化 ≤ 1.5s 体感更新
- 复制启动命令按钮的 title / tooltip 文案改成「生成 tmux 启动命令(开启 send-keys 注入通道)」
- `loop-command` 拿回来的 `command` 字符串内容已经是新形态,前端只负责粘贴板复制,不解析

**Step-by-Step:**

- [ ] **Step 1: 改 `scanNowProject` 调用 + mode 分支**
- [ ] **Step 2: 改按钮文案 / title / disabled 条件**(disabled 维持:paused / offline / missing)
- [ ] **Step 3: setTimeout refresh + 「✓ 已注入」短暂态**
- [ ] **Step 4: 复制启动命令按钮 title / tooltip 同步**
- [ ] **Step 5: 浏览器手测 — 在 tmux 启动的 loop 上点按钮,卡片 1-2s 内挪到「进行中」**

---

## Task 3: 文档同步

**Files:**
- Modify: `loop-prompt.md`
- Modify: `SKILL.md`
- Modify: `README.md`

**约束:**

- `loop-prompt.md` §start 段改成三行 tmux 启动指引(配 SESSION 变量 / new-session / send-keys / attach),原直接 `claude '/loop ...'` 形态降级为「fallback 启动方式(无 tmux 时用,⚡ 按钮会走 wake-flag 模式)」
- `loop-prompt.md` 同步加一节「主动唤醒输入」,说明:用户在 loop 终端键入 `扫一下` 是合法的唤醒触发,loop 看到这个输入立刻跑 Step 0.5+ status / next 一轮;面板「⚡ 立即执行」就是这个机制的远程触发
- `SKILL.md` 喊词表加 `"扫一下"`(在 loop 终端) 与 dashboard `⚡ 立即执行`(远程) 等价的说明;dashboard 段更新 idleSleepSeconds 与 scan-now 关系("用 tmux 启动后,⚡ 按钮不再受 idleSleepSeconds 限制,~1s 内响应")
- `README.md` 末尾加一段「tmux 启动 + 远程唤醒」简介

**Step-by-Step:**

- [ ] **Step 1: 改 loop-prompt.md §start**
- [ ] **Step 2: 加 loop-prompt.md「主动唤醒输入」节**
- [ ] **Step 3: 改 SKILL.md 喊词表 + dashboard 段**
- [ ] **Step 4: 改 README.md**

---

## 已知限制(写进 README / SKILL.md)

1. **tmux session 内 Claude 退出但 session 残留时,`扫一下` 会被裸 shell 当命令执行** → 用户看到 dashboard phase=offline 时应手动 `tmux kill-session -t task-queue-loop-<slug>` 后重启
2. **Linux 用户的 tmux 路径同样适用**,但 `$SHELL` 行为可能不同 — 本期只在 macOS 验证
3. **不在 tmux 里启动的 loop**(老办法直接 `claude '/loop ...'`)继续走 wake-now 文件旗子,响应延迟 ≤ `idleSleepSeconds`

---

## 兼容性 / 回滚

- 不引入新依赖
- 不改任何 lib 接口
- 旧端点 `/api/projects/:slug/wake-now` 保留,旧 loop 启动方式继续可用
- 回滚 = `git revert` 本次 commit 即可,无 schema / 文件结构变更
