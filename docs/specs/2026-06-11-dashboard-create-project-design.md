# Dashboard 创建项目并初始化 — 设计文档

日期：2026-06-11
状态：已批准

## 背景与目标

目前项目进入 dashboard（Helm）的唯一途径是在 Claude 会话里跑 `/task-queue init`
（detect → AskUserQuestion 4 问 → init-write 落盘 → commit .gitignore），面板上没有
任何「新增项目」入口。本设计让用户直接在 dashboard 上完成两种场景：

1. **接入已有目录** — 输入磁盘上已存在的项目路径，跑完整 init 流程并出现在侧栏；
2. **从零新建项目** — 输入父目录 + 项目名，自动 mkdir + git init + 最小脚手架后接入。

init 的 4 个问题以 Web 表单向导形式复刻，与 Claude 会话里的问答完全等价。

## §1 前端：入口与向导流程

侧栏项目列表底部新增「＋ 接入项目」按钮，点击打开 modal 向导，共两步。

### 第一步：选路径（双 tab）

- **Tab「接入已有」**：绝对路径输入框（支持 `~` 展开）。点「下一步」→ 调
  `POST /api/init/detect` 校验路径并探测。若目录不是 git 仓库，显示勾选项
  「同时 git init」（任务执行依赖 git commit 流程）。
- **Tab「从零新建」**：父目录输入框（localStorage 记住上次使用值，首次使用 placeholder
  为 `~/projects`，不自动创建父目录）+ 项目名输入框，下方实时预览完整路径。
  点「下一步」→ 服务端校验父目录存在、目标路径不存在。

### 第二步：4 问表单（两 tab 汇合，预填 detect 建议）

1. **自动 commit 名单** — 每个 scope 一个 checkbox（monorepo 列多个，单包一个）；
2. **commit 模板** — 每 scope 一个文本框，预填探测模板，旁边实时渲染示例预览。
   沿用现有护栏：`T#0000` 不参数化成 `T#{id}`；subject 行不放 `{desc}` / `{summary}`；
3. **候选模块** — 每 scope 一个可增删的 tag 列表，预填 candidateModules；
4. **同日版本号复用** — 是/否单选，预填探测建议（likely_true → 默认是）。

提交 → loading（按钮禁用防双击）→ 成功后关闭 modal、刷新侧栏并选中新项目；
失败展示服务端错误信息。从零新建的空目录探测不到包时，表单用 §3 的空项目默认值。

## §2 服务端：API 与落盘动作

### 抽核心（复用现有 done-core 模式）

- `commands/detect.cjs` 主逻辑抽到 `lib/detect-core.cjs`（返回对象，不写 stdout）；
- `commands/init-write.cjs` 主逻辑抽到 `lib/init-core.cjs`（同上）；
- 原命令文件变薄壳：解析参数 → 调 core → stdout 输出 JSON，CLI 行为不变；
- dashboard-server 直接 require 两个 core，不走子进程。

### 新 API

**`POST /api/init/detect`** body `{root, mode: 'attach'|'create'}`

- 规范化路径（`~` 展开 → 绝对路径）后校验：
  - attach：目录必须存在；
  - create：父目录必须存在，目标路径必须不存在。
- 返回 `{root, isGitRepo, alreadyInitialized, detect}`。
  `alreadyInitialized` = 已存在 `.tasks/project.config.js`；前端此时提示「该项目已接入」，
  提供「仅注册到面板」一键操作（只 registryAdd，不动现有配置，覆盖 registry 被清过的场景）。
- create 模式下目标目录尚不存在，`detect` 返回空结果（`packages: []`）、
  `isGitRepo`/`alreadyInitialized` 恒为 false，该步只做路径校验；向导直接用 §3 空项目默认值预填。

**`POST /api/init`** body `{mode, root, gitInit?, answers}`

- **create 模式额外脚手架**：`mkdir -p` → `git init` → 写最小
  `package.json`（`{name, version: "0.1.0", private: true}`，保证 done 流程版本号 bump 可用）；
- attach 模式且 `gitInit: true`：先 `git init`；
- 调 `init-core` 落盘 `.tasks/`（project.config.js + tasks.xlsx + logs/ + run/）、
  追加 `.gitignore`、注册 registry；
- git commit：**显式列文件**（`.gitignore`；create 模式追加 `package.json`），
  绝不 `git add -A` / `git add .`，commit message 与 CLI 流程同款
  `task-queue: 接入任务队列（ignore .tasks/）`；
- 返回 `{slug, root, committed}`。

## §3 边界与错误处理

- **路径防呆**：root 不允许是 `/` 或 home 目录本身；create 模式目标已存在 →
  报错并提示改用「接入已有」tab。
- **空项目 / 无 package.json 的向导默认值**：
  - scope `main`，dir `.`，versionFile `package.json`，buildCommand 留空，changelog 无；
  - commit 模板默认 `T#0000 main## {version}` + 空行 + `【模块】描述；`
    （与 detect 现有 detected 产出形态一致）；
  - 候选模块默认 `['全局']`。
- **attach 到无 package.json 的已有项目**：不擅自写文件；向导内联提示
  「未探测到 package.json，done 时版本号 bump 会转 review，可后续手动补 versionFiles 配置」。
- **git 失败不回滚**：`.tasks/` 落盘和 registry 注册成功后，若 git commit 失败
  （如未配 user.name），返回成功 + warning，前端显示
  「已接入，但 .gitignore commit 失败：<原因>」——队列功能不受影响，用户可自行补 commit。
- **幂等与并发**：init-core 本身幂等（xlsx 不覆盖、gitignore 不重复追加、
  registry add 已存在即返回）；前端提交按钮禁用防双击。

## §4 测试

- 抽核心后全量回归现有测试，确保 CLI `detect` / `init-write` 行为不变；
- 新增单测（tmp 目录）：
  - create 脚手架全链路（mkdir + git init + package.json + commit 落地验证）；
  - 空目录 detect → 向导默认值；
  - `alreadyInitialized` 分支（仅注册不覆盖配置）；
  - 路径校验拒绝 case（`/`、home 本身、create 目标已存在）；
  - git commit 失败时不回滚、返回 warning；
- dashboard 两个新 API 的集成测试，参照 `tests/` 现有 dashboard 测试写法。

## 决策记录

| 决策点 | 选择 |
|---|---|
| 创建含义 | 接入已有目录 + 从零新建，两者都支持 |
| init 问答形式 | Web 表单向导完整复刻 4 问，detect 建议预填 |
| .gitignore commit | 服务端自动 commit（显式列文件），与 CLI init 等价 |
| 新建路径输入 | 双 tab + 默认父目录（localStorage 记忆） |
| 复用方式 | 抽 lib/detect-core.cjs、lib/init-core.cjs，进程内调用 |

## 实施补记（2026-06-11，随分支落地的批准偏差）

实现与审查过程中批准的增强（均已带测试落地）：

1. **inspectRoot 的 isGitRepo 改用 `git rev-parse --is-inside-work-tree`**（而非 `.git` 存在性）——
   monorepo 子目录 attach 时不再误导用户嵌套 git init；子目录的 `.gitignore` commit 落父仓库。
2. **dashboard 请求防护层**（spec 外新增）：Host 白名单（仅默认 loopback 绑定时生效；
   显式 `--host 0.0.0.0` 局域网模式跳过）+ `POST /api/*` 强制 `Content-Type: application/json`
   （堵跨站 simple-request 盲打，含空 CT 变体）。curl 调用 POST API 需带 JSON 头（SKILL.md 已注）。
3. **resolveInitPath 做 realpath 物理规范化**——堵大小写不敏感 FS / firmlink / symlink 别名绕过
   home 守卫。
4. **前端竞态守卫**：detect 响应代回收（seq + tab + modal 同一性）；「仅注册」提示条在路径
   编辑时失效；网络异常兜底。
5. **scope 改名同步默认模板**（用户未自定义时），模板护栏增加「缺 `{version}`」警告。
6. **registerOnly 校验 `.tasks/project.config.js` 存在**，守住「仅注册」兜底的前置条件。
7. **向导 UI 微调**：「同时 git init」勾选出现在第二步（spec 写第一步，功能等价）；
   同日版本号复用为 checkbox（detect `unknown` 时默认勾选）；模板预填用含
   `{module}`/`{desc}` 占位符的真实模板而非 §3 的字面示意文本。
8. **attach 到无 package.json 项目的内联提示**（§3 要求）在第二步以 notice 形式实现。

已知非阻塞遗留（后续可做）：chip 输入 blur 竞态（既有控件行为）、handleInit 内部错误统一回
400、create 在已有仓库子树下嵌套 git init 无前端提示、detect 同步 execFileSync、
「上一步→下一步」重建表单丢编辑、`detect.commitPattern` 暂未被向导消费。
