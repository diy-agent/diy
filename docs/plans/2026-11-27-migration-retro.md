# 数据迁移复盘：问题、根因与解决路径（2026-11-27）

> 证据源：`~/.diy2/tasks/2026-11-18/task-mwlxxv3u/journal.jsonl`（seq 234→829）、
> opencode 会话 `ses_de42fd803ffeIFfnx0405z2lfp`（Migration stuck without logs at localhost:5192）、
> git 提交 `afbc579a` / `a8e19ff5` / `ebdbb021` / `384c7193` / `6a1b6795`。

## 一、时间线

| 时间 | 事件 | 出处 |
|---|---|---|
| 11-24 | BotRole 重构开工，`bots → bot_roles` 迁移随接管的外来实现一起提交（3fa1c0ad）；迁移当时是 `db.ts` 里的内联段 | seq 234/261 |
| 11-26 07:49 | 真库副本演练：38 bot → 7 角色、36 会话零丢失、`bots_v0` 留档 | seq 414 |
| 11-26 14:20 | **数据重写漏引用点**：迁移只改 `session_state`/`deliveries` 的 bot id，漏了 `entity_items.author.id` 与 `asks.owner` → 界面显示「还没有消息」（数据在、看不见）。修 384c7193 | seq 515 |
| 11-27 10:45 | **性能坑**：fold-bots 按映射逐条全表扫（37 映射 × 2278 大 JSON ≈ 2.5 分钟，页面与卡死无从区分）→ 改 TEMP 映射表 + 每表扫一次，降到 10.2s | seq 734 |
| 11-27 12:04 | 迁移页两按钮同时出现：`.btn{display:inline-block}` 盖过 `[hidden]` 默认规则 | seq 772 |
| 11-27 12:54 | **迁移体系重构**（6a1b6795 + b9433e81）：16 段内联拆成 `pkgs.ts/core/migration` 下 16 个文件（形状 `{id,title,plan,done,converge?,up}`）+ `schema_migrations` 版本表 + 执行器（基线 `done()` 判据、执行与记账同事务、事务可重入、converge 类每启收敛）。200MB 真库首跑 3.4s / 二跑 9ms | seq 792 |
| 11-27 13:48 | **迁移页并进主 app**（afbc579a）：入口只读探针 `probeMigration` → 有待迁就装配「迁移态」app（只服务迁移屏 + 三个 `/api/migrate/*`，其余 503）→ 迁完同端口换真 app | seq 827 |
| 11-27 13:51 | 修「收不到 ready」（a8e19ff5）：`closed` 事件里关了流，而 `ready` 是之后异步广播的 → 客户端永远收不到，改成 closed 不关流 + ready 关流刷新 | git a8e19ff5 |
| 11-27 15:02 | **用户报障**：`localhost:5192 迁移失败卡住了也没日志` → 交给 opencode | opencode 会话 [0] |
| 11-27 15:13 | opencode 定位两根因并修复，提交 **ebdbb021**（main） | opencode 会话 [64] |
| 11-27 15:40 | 5192 已跑新产物（`build/prod/server/index.mjs`，lsof 核实），真库已迁完（备份 `~/.diy2/diy2.db.bak-before-migrate-1517`） | 本轮核查 |

## 二、用户报障当天的两个直接根因（opencode 定位）

**现象**：打开 app 停在迁移页，按钮灰、日志区全空，永远「迁移中…」——对普通用户 = **完全不可用，且零错误信息**。

1. **发布形态起不了迁移子进程（spawn ENOENT）**
   `migrate-mode.ts` 写死 `spawn(tsx, ['migrate-worker.ts'])`，而 vite 只把 `server/index.ts` 打成 `index.mjs` —— 产物里既没有 `migrate-worker.ts` 也没有源码态那个 tsx 相对路径。
   **为什么 dev 测不出来**：源码态（tsx 跑 .ts）完全正常，这是**发布形态专有** bug；此前所有验证（含副本演练）都在源码态。

2. **错误事件丢在 SSE 连上之前（订阅竞态）**
   页面先 `POST /api/migrate/start`，服务端子进程起不来的那一刻**瞬时广播** `error`；前端 SSE 还没连上（或没等 `onopen`），这条唯一的日志就没了 → 页面永远停在「迁移中…」。
   **为什么零日志**：错误通道只有 SSE 这一条，瞬时广播丢失后无处可查（没有落盘日志）。

**库本身没问题**：opencode 在库副本上跑通完整迁移（16 条记账、实跑 4 步、5 秒、0 孤儿）。

## 三、修复（ebdbb021）

- `migrate-worker.ts`：逻辑收进 `runMigrationWorker(dbPath)`，直接执行（tsx）与复用入口共用一份。
- `index.ts`：命中 `--migrate-worker` 在读参数前分流去跑迁移并退出。
- `migrate-mode.ts`：按形态起子进程 —— 源码态 `tsx`，产物态 `node index.mjs --migrate-worker <db>`（Electron 下带 `ELECTRON_RUN_AS_NODE`）。
- `MigrationScreen.tsx`：等 `onopen` 再 POST start；断流落 `failed` 并给一行说明；迁完换真 app 的空窗改轮询 `/api/migrate/state`，不再刷回死页面。
- 验证：副本完整迁移；**构建产物 + Chrome 跑真实点击流程**（点开始 → 进度 → 自动进工作台，console 零错误）；tsc / oxfmt / migration 测试绿。

## 四、问题清单（按类别）

| # | 问题 | 根因类别 | 解决 |
|---|---|---|---|
| 1 | 产物里 spawn ENOENT | **源码态/产物态行为分叉**，e2e 只覆盖源码态 | 双入口分流（ebdbb021） |
| 2 | SSE 瞬时事件丢失 | **订阅竞态**：先触发后订阅/不等 onopen | 等 onopen + GET state 兜底 + 断流落 failed（ebdbb021） |
| 3 | 卡住零日志 | **错误通道单一**（只靠 SSE，不落盘） | 部分修复（UI 给说明）；日志落盘仍缺 |
| 4 | 收不到 ready 不刷新 | 事件时序假设错（closed 在 ready 前） | closed 不关流、ready 才刷新（a8e19ff5） |
| 5 | 迁完后界面「没有消息」 | **引用重写不全**（漏 author.id / asks.owner） | remap 补齐 + 回归测试（384c7193，seq 515） |
| 6 | 迁移 2.5 分钟像卡死 | **按映射逐条全表扫** | TEMP 映射表单遍扫描 10.2s（seq 734） |
| 7 | 两按钮同时出现 | CSS `display` 规则盖过 `[hidden]` | 作者样式加 `[hidden]{display:none !important}`（seq 772） |
| 8 | 同步迁移卡事件循环 | node:sqlite 同步 API | 早先就已正确：迁移固定跑子进程（设计保留） |

## 五、做得对、值得沉淀的部分

- **只读探针** `probeMigration()`：不 `openStore`、不改库，先问「要不要迁」再决定形态。
- **版本表 + 基线**：`schema_migrations`；老库用 `done()` 体检判基线，不重放（几十个存量库的入口）。
- **执行与记账同事务**、事务可重入（`transaction()` 深度计数，避免嵌套 BEGIN）。
- **converge 类别**：数据归一不记一次就永不再查，每次启动收敛。
- **迁移前必备份**（`bak-before-migrate-1517`）+ **迁移后查孤儿**（0 孤儿）。
- **子进程 + JSON 行进度 + SSE**：同步迁移不堵事件循环、页面逐步可见。
- **真库副本演练**：BotRole 迁移在生产库副本上先跑（seq 414），并抓出问题 5。

## 六、若普通用户遇到（修复前）

打开 app → 迁移页永远转圈、无日志、无按钮可用 → **无法进入主界面**；且因为 bug 只在发布形态出现，**内部 dev 环境复现不了**，用户无自救手段（唯一出路是有人告诉他直接用 CLI 跑 `--migrate-worker` 或换副本库）。这是「发布产物没进 e2e」的典型代价。

## 七、遗留缺口（本轮未做，见调研文档的建议清单）

1. 发布产物 e2e 未进 `./sha.sh check` / CI（这次的直接根因，目前靠 opencode 手跑一次）。
2. 迁移错误不落盘（SSE 丢 = 没日志）。
3. 迁移后自动校验（行数/孤儿/外键）未进执行器，目前是手工查。
4. 无 checksum（防迁移文件事后改写）、无 down 回滚（靠备份回滚，桌面 app 可接受但未写明为约定）。
