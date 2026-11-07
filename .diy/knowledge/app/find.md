---
desc: 包内定位：各目录与关键文件在哪（@diy-agent/app 源码地图）
updated: 2026-10-25
---

## chat-fold

**对话折叠 / 级别的语义唯一出处** `src/renderer_solid/lib/chat-fold.ts`（纯函数，可单测；组件只管画）：`turnRows`（一轮的过程历史行，级别只决定显示多少）· `tailOf`（结尾槽四形态：结论 / 结束点 / 现场 / 执行过程）· `endLeafTip`（结束点那句 tooltip，须喂 **turn** —— `endReason` 不在叶子上）· `clampLines` / `expandableOf`（"点开真会多出东西"的判据，**只此一套**）。级别本身落盘在 `src/renderer_solid/lib/ui-state.ts`（`Caches.diy_chat_level`，缺省 `DEFAULT_TURN_LEVEL`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:23）

## chat-view

**会话块树的渲染**：组件 `renderer_solid/components/LocalChatPage.tsx`（行按 id 复用 + `VirtRow` 绝对定位）· **视口虚拟化纯逻辑** `renderer_solid/lib/chat-virtual.ts`（前缀和布局 / 窗口 / 高度账）· 折叠级别语义 `renderer_solid/lib/chat-fold.ts` · **摘要/预览的窗口化扫描** `renderer_solid/lib/chat-text.ts`（`firstLine`/`lastLine`/`previewLines`/`clampLines` + 零分配 `countLines`；长块不再每帧全量 `split`，##93）· 样式钩子见 `app.find#skin`

（见 apps/diy-app/src/renderer_solid/lib/chat-text.ts:1）

## cli

`src/cli/index.ts` CLI 入口（命令定义与 RPC 调用）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:11）

## compact

压缩（**目标式预算**）：策略/账本/选择 `shared/context/compaction.ts`（`CompactPolicySchema` 真源 + `ClipSpec` 裁剪能力轴）· 选择算法**元件库 + 装配器** `main/services/compaction-plan.ts`（picker / stage / `runPlan` / `defaultBudgetPlan`）· 投递宿主 `main/services/local-blocks.ts`（`selectHistoryByBudget` / 两段分离：选择带出 clip → 渲染 `renderMessage`）· 单条工具输出截断 `main/services/tool-output.ts`（##127，挂在 `tool.toModelOutput`）· 预算注记 `shared/context/budget-note.ts`（YAML 文本，`kept` 保留区间；**格式说明已并入信封 `help.history`**，由 `HistoryNoteSchema` 派生，原 `history-index.ts` 节点已删） · 缓存 TTL 夹逼 `cache-ttl.ts` · 装配管道**进配置**（##344 M2）`shared/context/compact-keep.ts`（`history.keep[]` 契约 + `validateKeepStages`；形状见 `app.history#compact-keep`） · 校验 `main/services/compact-plan-service.ts`（`checkKeep`：静态 + must 层实占字节 vs 硬上限） · **手与闸**（##362 M3a）`main/services/compact-plan-io.ts`（`planGet/planCheck/planSet/planRestore/planReset`（**reset = 一键回出厂缺省**，删 `history.keep[]`；##363）；**工具 `compact_plan` 与 RPC 共用这一份**，禁两处各写；写闸 `history.allowAgentWrite` **只管 agent**；写前快照 `$DIY_HOME/plan-history/` 留 20 份（**旧链，只读兼容**）、审计 `log/compact/plan-edits.jsonl`）；形状与坑见 `app.history#plan-gate` · **版本链**（##378）`main/services/plan-store.ts`（内容寻址 CAS `$DIY_HOME/plan-store/plan-<sha12>.json` + 链 `$DIY_HOME/local/plan/<keyOf(scope)>/index.jsonl`；见 `app.history#plan-version` 与 `app.history#plan-gate`）· 自动压缩 `auto-compact.ts`（真源 `$DIY_HOME/auto-compact.yaml`，契约 `shared/context/auto-compact.ts`、I/O `src/main/core/auto-compact-config.ts`） · CLI `diy agent local compact plan get|set|check|reset|versions|version|restore`（set **校验后才写**；`via=user` 不受写闸约束）· agent 工具 `compact_plan`（op=get/check/set/restore/reset/versions/version；**两条只读 op 恒可用**，不受写闸约束）· 会话落盘路径唯一出口 `src/main/core/local-paths.ts`（##379：`sessionFile`/`resolveSessionFile` 双认 + 粘旧；迁移 `diy agent local migrate-layout`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:18）

## context

`src/shared/context/` 上下文树与投递：`README.md` 是**完整约定表**（领域模型 / 投递构造 / 划分真源 / step 快照 / 渲染坑）；投递构造唯一入口 `@diy-agent/context` 的 `delivery.ts::buildDelivery`（##447 起树/投影/投递/信封在 `pkgs.ts/agent/context/`，压缩决策在 `pkgs.ts/agent/compaction/`）；划分真源 `$DIY_HOME/context.yaml`（契约 `config.ts`、I/O `src/main/core/context-config.ts`；**缺省最小 system 名单** `delivery.ts::defaultSystemPlaces` —— 只放存续期不变的单元，易变项（`task.state`/`task.updated`/`task.title`/`cwd`/`reqlog`…）一律 runtime，否则每轮砸前缀缓存，##426）· 输入超长门禁 `shared/context/input-limit.ts` + `renderer_solid/components/InputLimitDialog.tsx`（默认 10 万字符可配，超限弹窗报 ≈token / 预计 $，可转文件发送，##426）

（见 pkgs.ts/agent/context/src/delivery.ts:1）

## core

`src/main/core/` 状态与文件落位：`state.ts`（数据根/任务路径单一出口）· `room.ts` + `room-view-cache.ts`（**房间落盘与读视图**：事件流 / 投递快照一律 `limit>0` ⇒ 尾部倒读 `tail-lines.ts`（不整份读）、写侧全异步；`room.get` 走**文件签名缓存**合并多组件轮询，##427）· `task*.ts`（任务读写与字段）· `tree-format.ts` · `drafts.ts`（草稿 + 插话队列）· `steer-queue.ts` · `persona.ts` · `cwd.ts`

（见 apps/diy-app/src/main/core/room-view-cache.ts:1）

## data-file

内置数据文件定位 `src/main/core/data-file.ts`：候选 `$DIY_HOME/data/<name>` > bundle 旁（`build/<V>/{main,cli}/data`）> 源树；`dataFileHit()` 带 `source`，`diy doctor` 的 `models` 段报**实际命中的绝对路径** + provider/模型计数。应用内刷新只写最上一层（下面两层只读：bundle 是发行物、源树是仓库）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:180）

## env-import

模型页「环境变量导入」提示条 `src/renderer_solid/components/EnvImportBar.tsx`：**四态常显**（可导入 / 命中但均已配置 / 零命中 / 扫描失败），零命中态靠 `llmConfig.scanEnv` 回报的**扫描面**（`scanned`：191 家 / 181 个变量名）交代「查过什么」——只在有候选时出条，会让用户分不清「env 没这个变量」与「功能没跑」

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:28）

## env-watch

**「环境感知」的可见性（##384）**：机器环境坏了（磁盘满 / 网断）从**沉默**变**顶栏红条**（带数字）。判据纯函数 `src/shared/env-watch.ts`（磁盘水位 `full<512MiB`/`low<2GiB` · 网络码族 6 个连续 3 次 · `navigator.onLine` **不作判据**；通知形状 `{ id, ts, type, level, data }` 判别联合，表驱动单测 `tests/core/env-watch.test.ts`）· main 侧 `src/main/services/env-watch.ts`（主动轮询 `fs.statfs`（**不 shell 出去跑 `df`**）+ 被动：写失败 `ENOSPC` 走 `core/atomic-write.ts` 的钩子、网络层失败在 `local-agent.ts` 按**轮次**计连败）· RPC `env.list|ls|dismiss|watch|simulate|probe`（`watch` 回放 + `resolve` 事件 = **条件恢复自动消**；`dismiss` = 静音该**槽**；⚠️ 去重键 `slotOf`（`disk:<dev>` / type，**定义在 shared**）main 与 renderer 必须**共用同一份** —— 各写一套会在「多卷」时把两条合成一条；槽键必须是**卷标识 `stat.dev`**、`mount` 只是**采样路径**（按路径分槽会让轮询那条与写失败那条并存、后者永不自动消，review2 实测踩过））· UI `components/EnvStatusBar.tsx` + `store/envWatchStore.ts`（**多条堆叠**最多 3 条 + 折叠计数），挂 `App.tsx` 的 `<main>` 最上方 · 探针 `diy env simulate`（**仅非生产**：注入假水位 / 假错误码，走同一条判据与同一个 bar）+ `diy env probe <path>`（指向小容量镜像）· ⚠️ 坑①**别真填满根卷**（2026-10-18 已毁过 ##166 正文）②SDK 的网络失败以 **error part** 报出（**不抛异常**）、流随后仍正常收尾 ⇒ `local-agent.ts` 收尾处的 `succeed()` 必须挂 `!streamErrorPart` 闸门，否则刚记的连败被立刻清零、红条永远不亮（实测踩过）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:27）

## err-report

**异常出口落盘（##411）**：形状 / 限流判据 `src/shared/error-report.ts`（`errText` **全仓唯一实现** + `buildErrorReport` + `ErrorRateLimiter`，纯函数）· 落盘 `src/main/services/error-report.ts::reportError(e, ctx)` → `$DIY_HOME/log/error/<YYYY-MM-DD>.jsonl`（`{ts, code, name, message, stack, ctx}`；同 `code + message` 每分钟 ≤ `DEFAULT_ERROR_LOG_LIMIT_PER_MIN` 条、**永不抛**）。接线：`local-agent` 流 `error` part / `turn-stream` 抛穿、`room-service` 投递失败 / 镜像回写 / 投递链异常、`rpc-port` 500 响应带 `code`。用户面文案不变（stack 只进日志）。单测 `tests/core/error-report.test.ts`。

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:32）

## err-triage

**全局异常三档判据（##394）**：纯函数 `src/shared/error-triage.ts`（`triageOf` / `invariant` / `KNOWN_EXTERNAL` / `triageOfTurnEnd`；零 IO，表驱动单测 `tests/core/error-triage.test.ts`）。已识别清单**复用** `src/shared/env-watch.ts` 的 `NETWORK_ERROR_CODES` + `probeNetworkError`（别再写一份错误链探测）。边界示范两处：`local-agent.ts` 的 `closeTurn`（轮末 → 审计行 `triage`/`code`，**只映射、不动 `TurnEndReason` 值域**）与流内 `tool-error` 分支。护栏 `scripts/check-error-code.mjs`（`LEGACY_THROW_BASELINE` 按文件钉数只减、`--by-file` 出数，挂根 `./sha.sh check`）；掩码 lexer 与 atomic-write 护栏共用 `scripts/lib/source-scan.mjs`。

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:31）

## error-remedy

**「这个错该去哪修」的声明式判据（##407）**：纯函数 `src/shared/error-remedy.ts`（`remedyOf({code,reason,ctx}) → {label,target,hint} | null`，表驱动单测 `tests/core/error-remedy.test.ts`）。输入是 `triageOf` 的 code + `model-unavailable` 的 kind/provider + 状态码，输出是**目标页锚点**（`{page:"models", anchor}`，anchor = 目标元素 `data-focus-target` 值：`provider-std-<key>` / `provider-custom-<key>` / `models-pick`）。**表里没有 ⇒ 返回 null、不给按钮**（不造假入口）。消费端只有两处：`components/NoticeDetail.tsx` 的「🛠 去修复」+ 引导卡（自足文本，不调模型）、`App.tsx` 导航到设置→模型并带 `focus`；定位高亮在 `ModelConfigPage.tsx`（`data-focus-phase` = flash 4s → rest，样式在 `index.css`）。回看：`store/modelNoticeStore.ts` 的 `history`（关掉 bar 仍可找回；全局通知信箱未实现见 `app.tool#wake-gap`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:30）

## instances

**实例大盘（##366）**：CLI `diy instances ls`（表格文本）/ `list`（结构化，UI 用）· `focus --pid <pid>`（唤起：目标实例自己 `show+focus+全屏`，降级 osascript）· `self`（自报身份 + 活跃会话 + 窗口，被别的实例探测）/ `reveal`（唤起本实例的入口）。实现：发现靠**扫进程** `src/main/core/instance-scan.ts`（纯函数：ps → 实例行；helper/crashpad/CLI **都不是**实例）·「谁开的」靠**启动时**写的注册表 `src/main/core/instance-registry.ts`（`<真实家目录>/.diy-instances/<pid>.json`，`DIY_INSTANCE_REGISTRY` 覆盖；退出即删 + **读侧按 pid 存活过滤**）· 聚合/唤起 `src/main/services/instances.ts` · 跨实例 HTTP 探测 `src/main/services/instance-probe.ts`（与 `src/cli/probe-instance.ts` **同一份协议**，禁两处各写）· 排版 `src/main/core/instance-table.ts`。UI 页 `src/renderer_solid/components/InstancesPage.tsx`（导航「实例」，##367：表格 + 「显示」唤起 + 3s 轮询；展示语义纯函数 `src/shared/instance-view.ts`，页面**不可见即停轮询**、刷新按 pid 保选中/展开；**只读**，无杀/停入口）。⚠️ 坑：`ps eww` 的 `DIY_HOME` 是**继承**来的 ≠ 真数据根（真根取实例自报；实测 pid=11419 反例）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:10）

## interrupted-cause

**「本轮未完成」要能说出原因（##416）**：纯函数 `src/shared/interrupted-cause.ts`（`classifyInterruptedCause(since, until, ev)` 按窗口取**最新**一条可命名证据：`app-exit:<kind>` / `crash:minidump` → `agent/app-restart`|`agent/app-crash`；`codeOfInterruptedWhy` 是**唯一**派生闸门，认不出返 null）· 读盘 `src/main/services/interrupted-cause.ts::readCauseEvidence`（`log/app-exit.jsonl` + `log/crashes/**/*.dmp` 的 mtime，**永不抛**）· 写入 `appendAppExit`（格式唯一一份，`crash-reporting` 与本包 `scripts/electron-dev.mts` 共用；**watch 重启由杀的一方亲手记 `electron-dev-restart`**，别指望被杀进程写完）· 消费 `local-agent.ts::healResidualOps`（补 closer 时填 `endReason.data.why/evidence`，同判定走 `reportError{where:"agent/turn-interrupted"}`）。铁律：**能命名才命名，查不到保持 unknown**（SIGKILL / 断电说不出口）。

（见 2901cb27:pkgs.ts/diy-app/src/shared/interrupted-cause.ts:1）

## job-fence

**「这条 run/进程归谁」的唯一判据**：`src/shared/job-fence.ts::fenceTaskOwner`（纯函数）。`job.kill` / `job.killproc` / `job.detach` 三条动手路径**都过它**：调用方必须声明 `taskUri`（CLI 是位置参数、**没有缺省**），且必须与该 run 的 `origin.taskUri` / 组名册的 `taskUri` 一致 —— 跨任务不代杀、归属不明的也不动（`agent/job-task-required|owner-unknown|foreign`）。理由：kill 是按**进程组**发的，认错一次带走整组无关进程。加新动手接口 = 先接这道闸，别再各写一份比较 · 坑见 `app.rule#job-spawn-listen`

（见 7c8b0e950398:pkgs.ts/diy-app/AGENTS.md:31）

## job-run

**后台 run 管理与可见性（##408 v1）**：活体表 `src/main/services/run-registry.ts`（内存 Map，**只管 `background:true` 起的后台 run** —— 前台命令不登记、不落盘，用户 2026-10-24 定口径；run 的寿命按**进程组**算，组空才收口并唤醒 agent 一次，我们主动杀的不发唤醒）· 呈现口径 `src/shared/run-status.ts`（状态/时长/tail/唤醒文案，纯函数）+ `src/shared/run-view.ts`（表格字段 + `navTargetOf`：来源锚点三件齐全才可点）· 进程总管 `src/shared/proc-scan.ts`（按**进程组**认领孤儿，reparent 到 launchd 也认得出）+ `src/main/services/{process-scan,owned-groups}.ts` · 落盘 `$DIY_HOME/log/job/runs/<YYYY-MM-DD>/<id>/{meta.json,out.log}`（**运行产物**，留 7 天，不是执行账）· RPC 域 `job.*`（`ps` / `procs` / `killproc` / `kill` / `tail` / `meta`）· 面板 `renderer_solid/components/JobRunsPanel.tsx`（底栏 `task-run.bottom`；四 tab：概要/输出/API 数据/存储数据）

（见 7c8b0e950398:pkgs.ts/diy-app/AGENTS.md:30）

## journal

任务日志（##404）：契约 `src/shared/journal.ts`（五种 kind 各答一个问题）· 存储 `src/main/services/journal-store.ts`（`<taskDir>/journal.jsonl`，**一行一条 JSON 只追加**，读时容忍坏行）· CLI `diy journal add|find|stats|import`。三层划分判据见 `~/git/diy/AGENTS.md::rule.task-three-layers` —— 别往 body 里堆处理记录

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:9）

## l3-turns

**L3 结论账（turns.jsonl）**：`main/services/local-turns.ts`（一轮一条 `{v,turnId,at,state,user,texts[],ref.ops{offset,len,seq}}`，写侧在 turn `stop` 落盘后量字节偏移，旁路不 await 不抛）· 只服务**降级重建**：ops 缺失/断代时由它折成只读文本历史 + `degraded{cause,note,turns,dangling}`，横幅与行内文案单源 `shared/degraded-history.ts`；**正常路径（ops 可读）不读 turns**（##424）

（见 apps/diy-app/src/main/services/local-turns.ts:1）

## main-proc

`src/main/index.ts` 主进程入口（窗口 / 诊断 / 单实例）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:6）

## model

模型 provider 配置机制（##184）：契约 `src/shared/model-config.ts`（`model.yaml` 配置层 + `providers.custom.yaml` spec 层 + 限定名切分 `splitQualified`）· 运行时可解析目录 `src/shared/models.ts`（`setModelCatalog`/`findModel`/`apiOf`…，**无内置 provider：无配置 = 空目录**）· 装配 `src/main/core/model-runtime.ts`（快照 ⊕ custom ⊕ `$DIY_HOME/model.yaml` → 目录，含 `$VAR` 展开；档触发条件判别 `toTierWhens` —— **快照是 `JSON.parse` 直取、不过 zod**，此处是最后一道哨；档写 `{window:"id"}` 时按时段表展开成多条 `TierWhen`）· 文件 I/O `src/main/core/model-config.ts` · 配置 UI `src/renderer_solid/components/ModelConfigPage.tsx` · **价目登记（CLI）** `src/main/core/llm-cost.ts`（`diy llmConfig costs/setCost/setTiers` 的落点判定 + 落盘 + 回执；纯变换在 `src/shared/cost-edit.ts`，与 UI 同源；UI 每个编辑入口都包 `editCost` 收尾 —— 价目空了就删键，不留 `cost: {}`） · **运行时价目形状**（RPC 下发 / UI / CLI 同一份）`src/shared/usage.ts` 的 `ModelCostSchema`（camelCase，含 `baseLabel` 与分档 `tiers`）· **内置数据三件**（文件名常量在 `src/shared/model-config.ts`，定位 `src/main/core/data-file.ts`；`sha.sh build` 按 `src/main/data/*.json` 通配拷贝）：① 快照 `models.dev.json`（models.dev npm 白名单，上游产物整份重下，`scripts/gen-models-dev.mts`）② **diy 扩展层** `models.dev.diy.json`（**手写、只增不改**：具名时段表 `windows` —— models.dev 零个时间字段，时段计费只能自己登记；加载 `src/main/core/cost-windows.ts`，形状/展开/摘要 `src/shared/cost-windows.ts`）③ `calendars.json`（工作日日历，`scripts/gen-calendars.mts` 从 chinese-days 生成；`CN-business-day` 含调休补班、`CN-mon-fri-ex-holiday` 不含 —— 同一地域多套作息是常态，按语义分 id）· 单测夹具 `tests/fixtures/models.ts` · env 导入 `src/main/core/model-import.ts`（snapshot 声明的 env ∩ 本机变量 → 候选；**只列不写、不落明文、不覆盖已有**，UI 提示条与 `diy llmConfig scanEnv|importEnv` 同源）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:25）

## model-notice

**「模型不可用」的可见性（##369 ①）**：判据纯函数 `src/shared/model-unavailable.ts`（四类：`model_coming_soon` / 404 unknown model / 401·403 / 429；**上游 5xx 与超时不算**；表驱动单测 `tests/core/model-unavailable.test.ts`）· main 侧通知中心 `src/main/services/model-notice.ts` + **两个触发点**（流内 `error` part 是主路径、`streamText` 的 catch 兜底；装配期"未知模型"另走 `unavailableNoticeFromLocal`，都在 `local-agent.ts`）· RPC `notice.list|dismiss|watch`（`watch` 订阅即**回放**现存 —— 页面重载后 bar 能自己回来；`dismiss` 必须落 main，否则重连又弹）· UI 顶栏细条 `src/renderer_solid/components/ModelUnavailableBar.tsx` + `store/modelNoticeStore.ts`（含**回看** `history`），挂 `App.tsx` 的 `<main>` 最上方；通知带 `provider` 段供修复引导定位，见 `app.find#error-remedy`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:26）

## notice

**用户可见提示的信息契约（##391）**：任何提示都要带三段 `{ source, reason, detail }`（谁发的含代码位置 / 为什么此刻发**带数字与时刻** / 机制说明：在监测什么·何时有·怎么消·意味着什么）。唯一正路 `notificationStore.addToast(type, message, meta, opts)`（空值**抛错**，校验 `src/renderer_solid/lib/notice.ts::assertNoticeMeta`）· 二级 UI `components/NoticeDetail.tsx`（`[详情]` + 三段 + 复制；toast / env bar / model bar / ops 常驻条共用一套）· 同源同文案默认**聚合**（`count` → `×N`，`opts.aggregate:false` 关掉）· 文案真源按域分文件：`lib/notice-ops.ts`（会话实时更新 = 样板）· `notice-chat.ts`（历史分段/插话队列/清空/停止/检索定位）· `notice-copy.ts`（剪贴板）· `notice-compact.ts`（上下文压缩）· `notice-entity.ts`（任务·项目·草稿）。**遗留债务**：未改造的 95 处仍在 `addToastLegacy`（详情面板如实标「未登记」），按文件钉在 `tests/core/notice-contract.test.ts` —— 只许减少，新代码一律用 `addToast`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:33）

## ops-feed

**会话 op 的写侧广播总线**（##307 读侧）：`main/services/ops-feed.ts`（`publish` / `subscribe` / `reset`；seq = 行号、epoch 随 `clear` 换发）· 唯一落盘点 `local-agent.ts` 的 `opsSink`（chat / 排队回执 / 加载自愈共用）· RPC `agent.local.opsWatermark` + `opsWatch` · 渲染端订阅 `localChatStore.ts` 的 `ensureOpsSubscription`（建流/退避重连）/ `applyOpsFrame`（按 seq 去重、**洞即重订补发**；**取代 2s 轮询**）· **本订阅是块树的唯一 apply 通道**（##327）：同一批 op 也作为 `agent.local.chat` 的流回到发起方，**那条流只取「本轮结束/报错」信号、一个 op 都不落地** —— 两边都 apply = 每条 delta 追加两遍 = 整段叠字（delta 纯追加、无唯一键，而 start/patch/stop 恰好幂等，故只表现为文字、结构看不出来）· 单通道的**代价**：订阅坏了 = 一个字也看不见（界面上与「模型在想」同形）→ 两个名字别删：`opsState`（订阅健康度，判「通了」以**收到帧**为准）、`settleOpsAfterTurn`（轮末自检：水位没前进即重订补发并出声）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:22）

## ops-fold

**会话历史（UI 重放）的折叠 + 增量缓存**：折叠算子 `main/services/local-blocks.ts` 的 `compactOps`（块树 → 每块 `start` + 终值 `patch` + `stop`）· 读侧 `main/services/local-agent.ts` 的 `history()`（**起点 = 压缩账本 `keptFromOpsOffset`**，与投递侧同一个 seek，见 `uiReplayStart`；fold 缓存按 `(task, start)` 分键 —— 多窗口并存时同 task 多键 + 「已消费字节 + 前 4KB 覆盖写哨兵」判续 fold，**折叠流同缓存**（`consumed` 未进而复用同一份数组）、issue 只在新出现时出声）与**分页窗口** `historyWindow`/`historyOlder`（RPC `agent.local.*` 同名）· 渲染端**分段 + 幂等并入** `renderer_solid/store/localChatStore.ts` 的 `mergeWindow`（段 = 一段窗口，前插时已有段的块引用一个不动）

（见 apps/diy-app/src/main/services/local-agent.ts:1）

## ops-seek

**大会话分页的窗口起点 + 游标**（`main/services/local-ops-seek.ts`）：`seekWindowStart`/`seekTurnStartAtOrBefore` 按字节预算**向上 floor 到轮 `start` 行行首**（切在轮内会让块塌成根、跨切点 patch 丢）· 游标**不透明**：`encodeCursor`/`decodeCursor`/`isTurnStartAt`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:20）

## renderer

`src/renderer_solid/`（Solid，主线）：`components/` 业务组件 · `store/` signal 单例 · `lib/` rpc client 与 `diy.ui.*` handler · `App.tsx` / `main.tsx`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:13）

## scripts

仓库 `scripts/`：`ui-smoke/`（CDP 冒烟）· `check-error-code.mjs` + `lib/source-scan.mjs`（新增 throw 必带 code 的棘轮护栏，判据见 `app.find#err-triage`）· `cdp-colorscheme-demo.mts` · `repro-epipe-dialog.mts` · `doctor-env.sh` · `check-specs.mts`（`~/SPECS.md` 规范索引护栏：key 唯一 / 指针可解析 / 链上新增未收录的 ratchet 增量，基线 `scripts/specs-unindexed.txt`，挂在根 `sha.sh check`）· `check-sync.mjs`（依赖同步快检，根 `sha.sh` 的 `ensure-sync` 入口闸门 + 本包 `build` 只读护栏共用）· `ensure-electron.mjs`（electron 二进制收成「全机一份 store + worktree 软链」，由根 `sync-deps` 与 `_ensure_electron` 调用）· `ensure-electron-if-needed.sh`（CLI 入口快检：`diy.sh` / `bin/diy` 用，缺/悬空才起 node）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:37）

## serve

`src/serve/index.ts` 纯 Web 模式（无 Electron）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:35）

## sessions

**全局会话可见性（##308）**：唯一数据源 `src/renderer_solid/store/sessionStore.ts`（**全应用只此一个** `agent.local.sessions` 订阅 + 本地已读水位 `seenSteps`；R3：看状态不计入 `viewers`）→ 三处消费者共用 `shared/session-overview` 的判据：总览页 `components/SessionOverviewPage.tsx`（导航「会话」）· nav 角标 / 已打开 tab 的 chip `components/SessionChip.tsx` · 任务表行内 chip（`TaskTree.tsx` 标题单元格）。⚠️「跟随当前会话水位」的 effect **只许读**：`markViewed` 内部对水位读做了 `untrack`（自读自写会自我入队 → 无限递归，回归 `tests/core/session-store.test.ts`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:14）

## shared

`src/shared/` **跨层契约**（zod schema / 纯函数，main 与 renderer 共用，禁止各处重写）：`task-uri.ts`（URI 解析）· `task-detail.ts` · `task-list.ts`（排序搜索）· `persona.ts` · `prompt-schema.ts` · `session-view.ts`（**单会话**运行态判据）· `session-overview.ts`（**全局**会话可见性判据：working/idle · 三种排队 · 步数进度 · 停滞/异常退出 · chip 文案 —— 三处消费者共用）· `turn-end.ts`（**轮次结束原因 → 人话/图标**的唯一文案源，main 与 renderer 同调）· `usage.ts`（**token 四桶 / 单价 / 金额的唯一口径处**，含 tier 选价与聚合）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:16）

## skin

**界面样式（皮肤 `rail` 竖栏 / `card` 卡片）**：规则**全在** `src/renderer_solid/index.css` 的 `[data-skin]` 段（挂 `documentElement.dataset.skin`）· 组件只给语义钩子（`data-row-head` / `data-row-handle` / `data-block-tag` / `data-tail-box` / `data-chat-list` / `data-proc-children`）· 竖列折叠条 `src/renderer_solid/components/RowGutter.tsx`（**一根条**：整块高 + 条内首行居中的尖头；两皮肤只差横向落点）· 设置页实时小样 `components/ChatSkinPreview.tsx`（钩子必须与真 DOM 同形，由 `tests/core/chat-skin-preview.test.ts` 从 css 反推守住）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:15）

## svc

`src/main/services/` RPC 与业务：`api-def.ts`（**契约**）· `api-impl.ts`（**实现**）· `local-agent.ts`（本地 agent 循环）· `local-blocks.ts`（op 流）· `ops-feed.ts`（会话 op 增量总线）· `async-queue.ts`（事件源 → `AsyncIterable` 桥接）· `usage-report.ts`（用量账本读取 + CLI 报表渲染，与 UI 同源）· `session-registry.ts`（**会话注册表**：本次启动后活跃过的会话 + turn/queue/viewers/lastEndReason 的唯一真源，读口 `agent.local.sessions`）· `prompt-registry.ts`（提示词装配）· `agent-guard.ts`（自毁命令拦截）· `diagnostics.ts`（日志/异常兜底）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:8）

## tests

`tests/`：`cli.intent.*` 意图测试（真实 UI / 隔离 Electron，**跑 `out/` 产物**）· `core/` `services/` 单测（vitest **直读 `src/`**）· 夹具 `electron-test.ts` · `ui-drive.ts` · `shell-test.ts` · `setup.ts`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:36）

## traffic

**出站流量观测**（##309）：`src/main/core/traffic.ts`（订阅 undici `node:diagnostics_channel` 采集请求/响应 + 归属反查 + 正文首尾法有界保留）· `src/main/core/traffic-log.ts`（`log/network/YYYY-MM-DD.jsonl` 按天落盘 + 按位置随机读 + 全文查询；行首 `_fmt` 小版本兼容、大版本跳过）· 契约 `src/main/services/api-def.ts` 的 `traffic.*`（CLI `diy traffic …`）· UI `src/renderer_solid/components/TrafficView.tsx`（导航页与聊天侧抽屉共用同一份）+ `TrafficPage.tsx` / `TrafficDrawer.tsx` / `JsonViewer.tsx` / `JsonTree.tsx` · 日志清理面板 `TrafficLogCleanup.tsx`（##324：列文件 / 占用 / 「只留最近 N 天」/ 勾选删除）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:34）

## turn-end

**轮次结束原因** `turn.endReason`（判别联合 6 值：`completed`/`max-steps`/`max-tokens`/`aborted`/`error`/`interrupted`；判别键 `type` + 分支私有 `data`）：判据**散在 `main/services/local-agent.ts` 的流循环**（`setEndReason` **8 处** / 5 类：budget 超限 · llm `error` · **stream `error`** · `abort`（两处：fullStream 的 `abort` part + 流异常，**来源取 `signal.reason`** —— 现只有用户主动停止） · finish 后的 `max-tokens`/`max-steps`/`completed`），`closeTurn` 只是**兜底**（`endReason ?? (streamDone ? completed : aborted{detached})`；`detached` 自 ##305 起**不再**由消费端断开触发，只剩"流意外中断"一个来源）；崩溃/被杀留下的开口轮由 `local-blocks.ts` 的 `danglingStopPatches` 补 `interrupted`（冷读合成，不覆盖已有值）。UI 只消费（`chat-fold.ts` 的 `turnEndNote` 出结束说明、`sceneTailOf` 出"错误/未完成现场"）· **文案唯一源 = `src/shared/turn-end.ts`**（`abortText` / `turnEndText` / `endMarkOf`，main 的中止 error 块与 renderer 的轮尾**同调**；`aborted.data.source`：`"user"` = 用户停止（`cancel()` 显式带上）· `"detached"` = 流意外中断 · 旧日志 `"abort"` = 来源不明）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:24）

## workflow

**工作流接入（##319）**：宿主自持定义 `src/main/workflows/{dev.ts,index.ts}`（按 id 注册，`workflowById` 是唯一取用口；**执行者绑定**（「哪一个 agent 跑这个节点」）是宿主侧旁表 `workflows/executors.ts` + `dev.ts::DEV_EXECUTORS`，按节点 id 关联 —— 内核 `NodeDef` 形状封闭，不加字段）· 领域操作 `src/main/core/flow.ts`（正路 `advance`；**系统推** `stepFlow` 走内核 `runtime.step` 求值 `pred:`/`action:` 并落盘，见 `app.flow#flow-two-phase`；参数值语义的唯一闸门 = 内核 `createRuntime`）· 落盘 `src/main/core/flow-store.ts`（任务目录 `flow/`：`state.json` 唯一权威 · `path.jsonl` 重建材料 · `events.jsonl` 审计可删 · `instance.json` 绑定）· 节点提示装配 `src/main/prompts/flow.ts` + `prompt-registry.ts::renderFlowNodeHint` + 只读命令 `services/flow-prompt.ts`（CLI `diy flow …`，RPC 域在 `api-def.ts` 的 `flow` 组；收尾 `finish` 见 `app.flow#flow-authority`）· **产物链（##337）**：声明 `art`（`workflows/dev.ts`，内核九渲染器 + 插件名）→ raw 放袋（`flow-store.ts` 的 `artifactFile`/`readArtifacts`/`writeArtifact`，任务目录 `flow/artifacts/<节点 id>.json`）→ render 插件翻译（`workflows/plugins.ts`：`patch`→diff · `records`→table · `text`→doc 的 `{ text }`；唯一调用点 `core/flow.ts::translateArtifact`）→ `FlowView.art/view` + 只读命令 `diy flow view`；写侧最小入口 `diy flow artifact put`）· **自动轮转（##341）**：驱动环 `services/flow-runner.ts`（按 `FlowView.next.mode` 三分流：`entry` 进入 / `system` 求值自动推 / `actor` 且有执行者表 = agent ⇒ 起一轮 agent 收结论后 `advance`|`bounce`、`human` ⇒停下等人；停止条件与幂等见 `app.flow#flow-driver`）+ 外部世界插件 `workflows/plugins.ts`（`guard:ci_green` 真跑 `ci.command` 看退出码 · `action:pr_mergeable` 默认**只查不合**，`merge.apply=true` 才真合）→ CLI `diy flow step`（推一步）/ `diy flow run`（serverStream，逐行 JSON 帧；**客户端断开 ⇒ signal 中断环与在跑的轮次**）· **讨论线程（##342）**：旁注流 `core/flow-store.ts` 的 `flow/threads.jsonl`（`FlowPost`/`appendPost`/`readPosts`，容错读）+ 业务层 `src/main/core/flow-thread.ts`（线程**从折线的真打回边推**、`postThread` 的锚点闸门）· 意见一等落盘 `flow.ts::appendBounceOpinion`（`diy flow bounce --opinion` 与驱动环自动打回共用）· CLI `diy flow thread list|post` · UI 讨论区 view `flow.dispute`（`components/flow/DisputePanel.tsx`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:12）
