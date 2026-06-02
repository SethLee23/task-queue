# 已完成任务「回复重开」设计

日期：2026-06-02
状态：已与用户确认设计（方案 A），待写实现计划

## 背景与动机

任务跑完归档后，用户常需要补充说明 / 纠偏 / 追加需求。当前 dashboard 的「回复」(`reply` + resume) 只对
**进行中表**的 `阻塞`/`待 review` 任务生效；已归档(`已完成`/`跳过`)的任务无法回复，只能重新手敲一条新任务——
**原任务的全部上下文(note 历史、done 块、原始描述)就丢了**，很麻烦。

需求：已完成/已跳过的任务也能「添加回复」，回复后任务带着完整 note 历史**重新进入 TODO**，让 loop 重新处理。

## 现状(代码事实)

- 完成/跳过任务在 `SHEET_ARCHIVED`(`lib/workbook.cjs`)，状态 ∈ {`DONE`, `SKIPPED`}。
- `replyCore`(`commands/reply.cjs`)只在 `SHEET_IN_PROGRESS` 找行，resume 只允许 `BLOCKED`/`REVIEW` → `TODO`。
- `markDoneCore`(`commands/mark-done.cjs`)演示了「进行中 → 归档」的搬运写法(`wsArch.addRow(cleanRow)` + `wsIn.spliceRows`)；本设计是它的**反向**。
- `lib/states.cjs` 的 `VALID_TRANSITIONS`：`DONE → ∅`、`SKIPPED → ∅`(终态)。`canTransition` 不允许从终态出发。
- dashboard 完成任务出现在两处：底部「今日完成」条 + 「查看历史」弹窗(`GET /history` 读 `SHEET_ARCHIVED`)。
- id 全局唯一：`add-row` 取 in-progress + archived 合集 `max+1`，所以**搬运行保留原 id 不会冲突**。
- 可复用：`reply.cjs` 的 `demoteLatestTags(note)`(把旧 `[.. 回复 LATEST ..]` 降级为 OBSOLETE)、`getReplierName()`(回复人显示名)。

## 方案：A — 独立 `reopen` 命令 + 新端点

每个动作一个 `commands/*.cjs` + core 函数 + CLI + dashboard 端点，是本 repo 既有模式。`reopen` 独立成命令，
职责单一、可单测，不污染 `replyCore`(后者保持只管 in-progress)。

（否决 B：扩展 replyCore 兼管归档表会让它跨两表 + 反归档，做太多事。否决 C：给状态机加 `DONE→TODO`
会放宽终态语义，有别处意外转换的风险。）

## 组件与改动

| 文件 | 类型 | 职责 |
|---|---|---|
| `commands/reply.cjs` | 改 | 导出 `demoteLatestTags` 与 `getReplierName` 供 reopen 复用(当前是模块私有函数) |
| `commands/reopen.cjs` | 新增 | `reopenCore(projectRoot, {id, reply})` + CLI 入口；复用上面两个 helper |
| `commands/dashboard-server.cjs` | 改 | 新增 `handleReopen` + 路由 `POST /api/projects/:slug/reopen` |
| `tasks.cjs` | 改 | `KNOWN_COMMANDS` 加 `'reopen'` |
| `web/app.js` | 改 | 「今日完成」条目 + 「查看历史」弹窗的 DONE/SKIPPED 项加「回复重开」按钮 + 输入弹窗 |
| `tests/commands.reopen.test.cjs` | 新增 | reopenCore 单测 |
| `tests/dashboard-server.reopen.test.cjs` | 新增 | reopen 端点单测 |

## `reopenCore(projectRoot, {id, reply})` 行为

1. 校验：`id` 必填；`reply` trim 后非空(否则抛错，复用 replyCore 的「内容不能为空」语义)。
2. 在 `SHEET_ARCHIVED` 找 `id` 对应行；找不到 → 抛错 `未找到 id=.. 的已归档任务`。
3. 状态必须 ∈ {`DONE`, `SKIPPED`}，否则抛错。**不走 `canTransition`**——这是一次有意的「重开」，
   `DONE`/`SKIPPED` 在状态机里是终态，这里显式校验状态而非依赖转换表，保持别处终态语义不变。
4. 组装 note：`demoteLatestTags(原 note)` 把旧 LATEST 降级；新块
   `[<getReplierName()> 回复 LATEST <localTimestamp()>] <reply>` 拼到顶部，下面用 `\n---\n` 接旧 note
   (含原 done 块)。**完整历史随任务回去**。
5. 搬运：从 `SHEET_ARCHIVED` 删除该行，加入 `SHEET_IN_PROGRESS`；`status = TODO`；`ftime` 清空(不再是完成态)；
   `id`/`ctime`/`scope`/`priority`/`desc`/`tags` 等其它字段保持不变。
6. 返回 `{ id, status: TODO, fromStatus, reopened: true }`。

(不更新 heartbeat 的 lastFinished*——那是「完成」语义，重开不属于。)

## Dashboard

- **端点**：`POST /api/projects/:slug/reopen`，body `{ id, reply }`。slug 校验 → 404 项目不存在 →
  400 reply 空 → 调 `reopenCore` → 200 `{ ok:true, ...result }`；reopenCore 抛错(如状态非法/id 不存在)→ 合适错误码。
- **UI**：
  - 「今日完成」条目：每个 DONE/SKIPPED 项加「回复重开」按钮。
  - 「查看历史」弹窗：每个 DONE/SKIPPED 行加「回复重开」按钮。
  - 点击 → 复用现有 reply 输入弹窗的交互(填回复 → 提交 → 落库)。提交后刷新列表；任务从归档区消失、出现在「待办」列。
    可沿用现有「回复并复制启动命令 / ⚡ 唤醒」的收尾(running loop 下轮取到它)。

## Loop 衔接

重开后任务在 `TODO`，note 顶是新 LATEST 回复块、下面是含 done 块的完整历史。running loop 下一轮(或面板 ⚡
立即执行)`next` 取到它，subagent 按 `loop-prompt.md` S1「检查 note 顶部 LATEST 回复块」恢复上下文——
正是「上下文不丢」的目标。无需改 loop-prompt(其 reply 处理逻辑已覆盖 LATEST 块)。

## 错误处理

- id 不在归档表 → 抛错(端点转 404 或 400 带消息)。
- 状态非 DONE/SKIPPED → 抛错(理论上归档表只有这两态；防御性校验)。
- reply 空 → 抛错(端点 400)。
- 搬运在单个 `withWorkbook` 事务内完成(addRow + spliceRows 同一次打开)，避免半搬运。

## 测试

`reopenCore`（`tests/commands.reopen.test.cjs`）：
1. DONE 任务重开 → 行从归档移到进行中、status=TODO、ftime 清空、id 不变。
2. SKIPPED 任务重开 → 同样成功。
3. note：旧 LATEST 被降级为 OBSOLETE，新块为唯一 LATEST，原 done 块仍在(`---` 之下)。
4. reply 为空 → 抛错。
5. id 不存在于归档表 → 抛错。
6. 归档表里状态异常(构造一条非 DONE/SKIPPED 的归档行)→ 抛错。
7. 重开后该 id 不再出现在归档表、出现在进行中表且唯一。

dashboard reopen 端点（`tests/dashboard-server.reopen.test.cjs`）：
8. `POST /reopen` 正常 → 200，任务进 TODO。
9. reply 空 → 400。
10. id 不存在 → 合适错误码(4xx)。
11. slug 非法 → 400。

## 非目标(YAGNI)

- 不做批量重开。
- 不改 loop-prompt(现有 LATEST 块处理已够)。
- 不动 `replyCore` 的 in-progress 行为(仅新增 helper 导出)。
- 不给状态机加 `DONE→TODO` 转换(避免放宽终态语义)。
