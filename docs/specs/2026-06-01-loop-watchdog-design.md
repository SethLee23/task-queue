# Loop 看门狗设计（launchd · 一次性脚本）

日期：2026-06-01
状态：已与用户确认设计，待写实现计划

## 背景与根因

task-queue 的 `/loop` 会话长期运行后，上下文会逐步累积（每轮唤醒都把 recover/heartbeat/status/next
的历史堆进上下文）。当上下文涨到 100%，模型输出退化，loop 在某一轮跑到 Step 1（next）后**没能走到
Step 5 的 `ScheduleWakeup`**——`/loop` 动态模式靠每轮末尾的 `ScheduleWakeup` 续命，这一环断了就**再无下次唤醒被安排**，loop 静默死亡。

现象：进程（claude REPL）还活着、tmux session 还在，但心跳冻结在最后一轮（`.tasks/run/heartbeat.json`
的 `ts` 不再更新）。dashboard 的 `deriveOnline`（`commands/dashboard-server.cjs`）在心跳陈旧 > 90 分钟时
判定 `offline`，于是面板亮"离线"。**dashboard 判定逻辑正确，不是 bug**；真正的缺口是 loop 没有
"上下文撑满后自我重启"的能力。

这是复发性问题（"又掉线"）：任何长跑 loop 迟早撑满上下文而死。

## 目标

无人值守地检测"心跳停更但本应在跑"的 loop，并自动重启（kill 旧 session + 无头重建），使其恢复心跳。
看门狗自身必须**比 loop 更稳**——绝不能也掉线。

## 确定的需求参数

| 维度 | 决定 |
|---|---|
| 载体 | macOS **launchd LaunchAgent**（开机自启、重启电脑不丢、纯 Node 0 token） |
| 计时方式 | **一次性脚本 + `StartInterval 60`**：launchd 每 60s 重新拉起脚本，脚本扫一遍即退出 |
| 重启阈值 | 心跳 `ts` 陈旧 **> 30 分钟** |
| 安全闸 | `phase === 'executing'` 不重启；`paused` 不重启；只重启**跑过的**（存在 `heartbeat.json`）项目 |
| 监控范围 | 仅**非-hidden** 注册项目（注册表 `hidden !== true`） |
| 退避 | 连续 **3** 次重启仍未恢复心跳 → **放弃 + 桌面告警**，之后不再碰，等人 |
| 通知 | **仅放弃时**桌面告警（复用 `test-push` 通道）；正常重启只写日志 |
| grace 窗口 | 重启后 **5 分钟**内不再重启同一 slug（给新 loop 时间写首心跳） |
| 轮询间隔 | 60s（launchd `StartInterval`） |

## 架构

```
launchd (StartInterval 60s, RunAtLoad true)
   └─ 每 60s ▶ node tasks.cjs watchdog        ← 扫一遍、处理完即退出（短命进程，自身不可能泄漏/hang）
                     │
        ┌────────────┼─────────────────────────┐
   读 ~/.task-queue/projects.json     读各项目 <root>/.tasks/run/heartbeat.json + 暂停状态
        │                                        │
   逐个非-hidden 项目跑决策              需重启时 ▶ lib/launch-command.cjs
        │                                  (tmux kill-session + 无头 new-session -ds + send-keys，不 attach)
   退避/放弃状态落 ~/.task-queue/watchdog-state.json
```

**采用方案 B（一次性脚本 + launchd 计时）而非常驻进程内部循环**：看门狗每次都是全新短命进程，
自身不可能内存泄漏 / hang / 掉线——从结构上保证"比 loop 更稳"。崩了 launchd 下个 60s 又拉起，自愈；
重启电脑后 `RunAtLoad` 自动恢复。

## 新增 / 改动文件

| 文件 | 类型 | 作用 |
|---|---|---|
| `commands/watchdog.cjs` | 新增 | 核心：单次扫描决策；子动作 `install` / `uninstall` / `status` |
| `lib/launch-command.cjs` | 新增 | 抽取：`sessionName(slug)`、`buildLoopPrompt(root)`（读 loop-prompt.md 替换 `${PROJECT_ROOT}`）、`launchHeadless(root, slug)`、`renderStartScript(root, slug)`（人用、含 attach） |
| `commands/dashboard-server.cjs` | 改 | 把内联启动脚本生成（约 L511-560 `handleCopyLoopCommand`）改为调用 `lib/launch-command.cjs`，消除重复 |
| `tasks.cjs` | 改 | 注册 `watchdog` 子命令 |
| `~/Library/LaunchAgents/com.taskqueue.watchdog.plist` | 生成 | launchd 配置，由 `watchdog install` 写入并 `launchctl load -w` |
| `~/.task-queue/watchdog-state.json` | 运行时 | 每 slug 退避计数 / 放弃标志 |
| `~/.task-queue/watchdog.log` | 运行时 | stdout/stderr 日志 |
| `tests/commands.watchdog.test.cjs` | 新增 | 单次扫描决策的单元测试 |

## 单次扫描决策逻辑

常量：`STALE_MS = 30*60*1000`、`GRACE_MS = 5*60*1000`、`MAX_RESTARTS = 3`。

对每个 `hidden !== true` 的注册项目：

```
hb = readHeartbeat(root)              // <root>/.tasks/run/heartbeat.json
paused = readPaused(root)             // 复用 status 的暂停判定
st = state[slug] || { consecutive: 0, lastRestartAt: null, gaveUp: false }

// ① 健康复位：心跳新鲜 → 清空退避状态，跳过
if (hb && hb.ts && now - hb.ts <= STALE_MS) {
    state[slug] = { consecutive: 0, lastRestartAt: null, gaveUp: false }
    continue
}

// ② 安全闸（任一命中即跳过，不碰）
if (paused) continue
if (!hb || !hb.ts) continue            // 从没跑过，不冷启
if (hb.phase === 'executing') continue // 任务在飞，不打断

// ③ 候选重启：陈旧 > 30min & idle/sleeping & 跑过 & 没暂停
if (st.gaveUp) continue                              // 已告警放弃，等人工
if (st.lastRestartAt && now - st.lastRestartAt < GRACE_MS) continue  // grace 内，等新 loop 写心跳
if (st.consecutive >= MAX_RESTARTS) {                // 退避到顶
    st.gaveUp = true
    testPush(`看门狗：${slug} 连续 ${MAX_RESTARTS} 次重启仍未恢复心跳，已放弃，请手动检查`)
    save(); continue
}
// 执行重启
killSession(slug)                      // tmux kill-session，忽略 "no session" 报错
launchHeadless(root, slug)             // 无头：new-session -ds + send-keys claude /loop；不 attach
st.consecutive += 1
st.lastRestartAt = now
save()
```

**复位语义**：只有观察到"新鲜心跳"（①）才清退避计数。重启后若 loop 真活了 → 下一轮走 ① 复位；
若没活 → grace 过后再重启、计数 +1；满 3 次 → 放弃 + 告警。既自愈又不会无限折腾起不来的坏项目。
（边界：若某项目反复"活 30 分钟后又死"，因 ① 要求心跳新鲜才复位，relapse 期间始终陈旧 → 计数持续累加
→ 最终归入放弃告警，避免无限 relapse 重启。）

## launchd 的两个坑（设计内处理）

1. **PATH**：launchd 进程环境没有用户 shell 的 PATH，`node` / `tmux` / `claude` 会找不到。
   → `watchdog install` 时用 `which node` / `which tmux` / `which claude` 探测**绝对路径**，
   把含这些目录的 PATH 烤进 plist 的 `EnvironmentVariables`；`ProgramArguments` 用 node 绝对路径。
2. **无头启动**：launchd 无 TTY，绝不能 `tmux attach`。
   → 无头路径只做 `tmux new-session -ds` + `tmux send-keys`，把 loop 跑进 detached session
   （用户随时可 `tmux attach -t task-queue-loop-<slug>` 上去看）。

## 子命令

| 命令 | 用途 |
|---|---|
| `node tasks.cjs watchdog` | 跑一次扫描即退出（launchd 调这个） |
| `node tasks.cjs watchdog install` | 探测路径、渲染 plist、写入 `~/Library/LaunchAgents/`、`launchctl unload`(若存在) 后 `load -w` |
| `node tasks.cjs watchdog uninstall` | `launchctl unload` + 删 plist |
| `node tasks.cjs watchdog status` | 打印 state 文件 + plist 是否已加载（`launchctl list` 查 label） |

## 错误处理

- 单项目处理抛错 → catch、写日志、继续下一个（一个坏项目不拖垮整轮）。
- tmux 不可用 → 写日志告警，本轮放弃重启（不降级 wake-flag——死掉的 loop 消费不了旗子）。
- `watchdog-state.json` 读坏 → 当空状态重建，不崩。
- 所有 stdout/stderr → `~/.task-queue/watchdog.log`。

## 测试

复用现有 `tests/` 与 `__setExecFileSyncImpl` 注入约定，对单次扫描决策做纯单元测试
（注入时钟 `now`、注册表、心跳读取、mock tmux execFileSync，断言"是否重启"+ tmux 调用序列）：

1. 心跳新鲜 → 不重启，且退避状态被复位
2. 陈旧 > 30min + idle + 未暂停 + 有 hb → 重启，`consecutive=1`，发出 kill+new-session+send-keys
3. 陈旧 + `phase==='executing'` → 不碰
4. 陈旧 + paused → 不碰
5. 陈旧 + 无 heartbeat.json → 不碰（不冷启）
6. 刚重启、grace 窗口内 → 不重启
7. grace 后仍陈旧 → 再重启，`consecutive=2`
8. `consecutive` 已达 3 → 不重启，置 `gaveUp`，触发 test-push 桌面告警
9. `gaveUp===true` → 后续轮不再动
10. hidden 项目 → 完全忽略
11. 无头启动命令**不含** `tmux attach`

## 非目标（YAGNI）

- 不做 hidden 项目监控（用户明确仅非-hidden）。
- 不做冷启动从未运行过的项目。
- 不做放弃后的定期自动重试（放弃即等人工）。
- 不解决 loop 上下文增长本身（治本的另一条路是 loop 内 `/clear`，本设计不涉及；看门狗是外部兜底）。
