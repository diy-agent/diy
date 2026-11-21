# diy1 能力盘点 × diy2 补齐判断（2026-11-21）

> 触发：diy2 已开始试着干活（真房间、真模型、真工具）。本轮把 **diy1（`apps/diy-app`）攒下来的能力**逐族过一遍，
> 判断哪些该进 diy2、哪些不该。结论是**判断清单**，不含实现步骤。
>
> 证据全部来自代码阅读（路径 + 行数为准），凡"diy2 已有"都指到具体文件；未跑通的地方会注明。

## 0. 结论三句话

1. **最该补的不是新功能，是"把已包化的内核用起来"**：diy2 有 4 处「精简移植」（tools / compaction / session / providers），
   每处注释都写着"等 build 图修好再换回去"。复核结果 —— `@diy-agent/tools`、`@diy-agent/jobs` 现在能直接 `import`（实测），
   **理由已过期**。同一能力两套口径，是后面每一次"为什么这里行为和 diy1 不一样"的来源。
2. **缺的是"能无人看着干活"的三件硬保障**：后台作业（`job`）、步数/输出刹车（`maxSteps`）、用量与钱账。
   diy2 现在一条命令最长 120s 就被杀组、一轮跑到模型自己停为止、花多少只有"上一轮"这一个数。
3. **Electron 专属的一律不补**（窗口唤起 / 原生选择器 / tab·layout 持久化 / 崩溃 minidump / 实例 focus），
   但**远程访问（remote / hub）必须补** —— diy2 是浏览器客户端，"本机 127.0.0.1"反而比 diy1 更受限。

---

## 1. 两代的形态差异（决定"该怎么补"）

| | diy1 = `apps/diy-app` | diy2 = `apps/diy2` |
|---|---|---|
| 外壳 | Electron 主进程 + renderer（Solid），RPC 27 个域 / 200+ 命令 | 单个 Node HTTP server + 浏览器（React），REST + 一条多路复用 SSE |
| 真源 | `ops.jsonl` / `llm.jsonl` / `deliveries.jsonl`（按任务目录） | sqlite（`entity_items` / `rooms` / `sessions` / `asks` / `deliveries`） |
| 会话模型 | task = room = 会话宿主（`room-service.ts`） | 实体 = 房间 = actor（`RoomActor`），每成员一个 `BotSession` |
| 内核 | 大量能力已抽包在 `pkgs.ts/*` | 只用了 context / kb / skills / agents-chain / protocol 等，**工具与会话自己又写了一份** |
| 监听 | 本机 + CDP + 实例注册表（可被别的实例唤起） | `127.0.0.1`（`server/listen.ts:51`），有注册表，无远程 |

---

## 2. 能力矩阵（diy1 有什么 → diy2 现状 → 判断）

判断取值：**补**（进 diy2）/ **换形态补**（能力要，实现形式变）/ **不补**（形态不同或不适用）。

### 2.1 工具层与命令执行

| 能力 | diy1 证据 | diy2 现状 | 判断 |
|---|---|---|---|
| read / write / edit 完整语义（行窗口续读、原子写、唯一命中替换、unified diff、越界拒绝） | `pkgs.ts/agent/tools/src/*`（3164 行，已包化） | `entity-runtime/src/tools/files.ts`（135 行精简移植：`READ_MAX_BYTES=200_000`、无续读、无 atomic-write、无 diff） | **补**（换回 `@diy-agent/tools`） |
| shell 自毁护栏、输出上限、结果头、超时杀组 | `tools/src/shell/{guard,cap-output,result,run}.ts` | `tools/shell.ts`（73 行：无 guard、无审计、输出 100k 截断） | **补** |
| 后台作业 `job`（list / status / output / kill / wait）+ 结束唤醒 | `pkgs.ts/agent/jobs`（已包化）+ `local-agent.ts:2141` 接线 | 无（`rg -c job entity-runtime/src` = 0）；`bash` 超时 120s 后整组 SIGKILL | **补**（P0） |
| 前台命令转后台（detach，不重启不丢输出） | `api-domains/job/api.ts::detach`、`foreground-bash.ts` | 无 | 换形态补（浏览器侧给"转后台"，服务端用 jobs 的 adopt） |
| 工具调用审计落盘（`agent-bash.jsonl`） | `local-agent.ts:2127` onAudit | 无 | 补（有 jobs/tools 后顺手） |
| 工具面 hash 漂移监控（启动时报"工具集变了"） | `tools-surface-watch.ts` + `currentToolsSurfaceHash` | 无 | 补（P2，与提示词前缀缓存一起看） |

### 2.2 会话 / 回合

| 能力 | diy1 证据 | diy2 现状 | 判断 |
|---|---|---|---|
| 步数上限（`maxSteps` 缺省 200，env > 配置 > 场景分层） | `local-agent.ts:408,470` | **无**：`entity-runtime/src/agent.ts:130` `stopWhen: () => false`，注释写"唯一刹车是用户点停止" | **补**（P0：无人看着时必须自己停） |
| 输出预算与"撞上限"可辨识 | `maxOutputTokens` 分层 + `shared/output-budget.ts` | 部分：`providers.ts:57` 算 max_tokens，`end-reason.ts` 能判 `max-tokens` 并落 notice | 已够，只补"层号"标注 |
| 轮次未完成成因说明（是谁结束的） | `interrupted-cause.ts` | 有等价物 `end-reason.ts`（215 行，interrupted / max-tokens / filtered / tool-mismatch） | 不补（diy2 已超） |
| 停止粒度（整间 / 单成员 / 保留队列 / 撤回提问） | `agent` 域 cancel + steer 队列 | `RoomActor.cancel({botId, keepQueue})` + `cancelAsk` | 不补 |
| 插话队列可视化管理（list / cancel / reorder / toggle） | `LocalAgentManager` steer 队列 | 只有投递 `mode: next-step / next-turn`，队列不可见 | 换形态补（P2：把 deliveries 画出来） |
| 会话内查找（按轮折叠后再搜，覆盖已压缩历史） | `local-find.ts` + `ChatFindPanel` | 无 | 补（P1，与历史窗口同批） |
| 历史分页 / 首载窗口 / 上滚补段 | `localChatStore` 4MB 窗口 + `local-ops-seek` | **无**：`db.ts:1242 itemsOf()` 一次返回全部 | 补（P1，长会话必崩） |

### 2.3 上下文与压缩

| 能力 | diy1 证据 | diy2 现状 | 判断 |
|---|---|---|---|
| 上下文装配（AGENTS 链 / kb 索引 / skills / 任务变量 / 信封增量） | `context-providers.ts` + `@diy-agent/context` | **已超**：`system-context.ts` 走 `createContextSession`，变量树 + 每步增量 | 不补 |
| 压缩策略（触发线 / 保留量 / 保留边界 / LLM 摘要） | `@diy-agent/compaction`（2313 行，已包化） | `compaction.ts`（141 行 simpleCompactor，`summarized` 恒 false；头注自己写着"将来换成 `@diy-agent/compaction`"） | **补**（P1/P2） |
| 每步真发快照 + diff + 变量变更历史 | `context` 域 steps / changelog / diff / rebaseline + `ContextLabPage` | 只有 `ContextPanel`（条目数 / ≈tok / 压缩次数 / 上轮实测） | 补（P2） |
| 冷缓存提示（首步命中率 P90 → 顶栏一行） | `cache-hint.ts` + `cacheHint` 域 | 无 | 补（P2，省钱题） |
| 提示词可编辑 / 预览（模板 + 渲染 + dry-run 请求体） | `template` 域 + `prompt-registry.ts` + `PromptLabV4Page` | `prompts/defaults` 静态 + `DIY2_*` 环境变量 | 换形态补（P2） |

### 2.4 模型与账目

| 能力 | diy1 证据 | diy2 现状 | 判断 |
|---|---|---|---|
| provider / 账户 / 模型目录 / 价目（真源单点，加 provider 不改代码） | `@diy-agent/llm-provider` + `pkgs.ts/model/catalog`（含 `cost.ts`）+ `llmConfig` 域 | **两份硬编码**：`entity-runtime/src/providers.ts:23`（PROVIDER_API / PROVIDER_ENV）+ `entity-chat/src/models.ts:37`（PROVIDERS 目录）；model.yaml 用正则手扒 | **补**（P1，两处必然漂移） |
| 配置 UI（读 / 写 / 价目 / 时段档 / 环境变量导入 / 目录同步 / 连通性探测） | `llmConfig` 域 10 命令 + `ModelConfigPage` | `ModelPicker` + 手改 `model.yaml`；`pkgs.ts/ui/model-config-page` 已包化未接 | 换形态补（P1） |
| 用量账本（按步落盘、可回看、成本告警） | `turn-usage.ts` / `self-usage.ts` / `usage-report.ts` + `UsagePanel` | 只存最近一轮 `usage`（`session_state.usage`），无账本、无单价、无告警 | **补**（P1） |
| 成本阈值 / 输出被截断的留痕信箱（事后可查） | `inbox.ts`（`$DIY_HOME/local/inbox.jsonl`）+ `notice inbox` 域 | 无 | 换形态补（P2） |

### 2.5 任务 / 知识 / 工作流

| 能力 | diy1 证据 | diy2 现状 | 判断 |
|---|---|---|---|
| 任务 CRUD / 树 / 状态 / body 契约 / 移动 / 草稿 | `task` 域 + `TaskTree` / `TaskDetailContent` | 表结构齐（`tasks` / `projects` / `drafts` / `entity_links`），UI 只有 `TaskPanel`（状态只读）+ 新建对话框 | 补（P1，UI 与命令两侧都薄） |
| 任务日志（append-only + 模型侧 journal 工具） | `journal-store.ts` + `journal` 域 5 命令 | **已超**：`tools/journal.ts` + `/journal` 路由 + `JOURNAL_KINDS` | 不补 |
| 知识库（多级 markdown + 索引 + 体检 + 移动） | `kb` 域 + `@diy-agent/kb` | 读侧已用（`system-context.ts` 投索引）；**无写入口**（`diy kb` 在 diy1 CLI） | 换形态补（P2：`diy2 kb write/check`） |
| 事实库 yaml（`facts submit/brief/get`） | `facts-store.ts` 1281 行 + `facts` 域 8 命令 | 无 | **不补**（2026-11-19 已退役，读入口是 `diy2 facts`） |
| 文档索引（`docs/` 一行一篇：标题 / 字节 / 状态） | `docs-index.ts` + `docs` 域 | 无 | 补（P3） |
| 工作流引擎（定义 DSL / 推进 / 打回 / 讨论线程 / 驱动环） | `pkgs.ts/flow` + `flow-runner.ts` + `FlowPage` | 无（房间还没接 flow） | 暂缓（P3；`pkgs.ts/flow` 现成） |
| ACP 外部 agent 接入（别家 agent 当一个成员） | `local-agent.ts` 独立 ACP 通道 + `@agentclientprotocol/sdk` | 无 | 待定（价值高、成本高，单独评估） |

### 2.6 多实例 / 远程 / 观测

| 能力 | diy1 证据 | diy2 现状 | 判断 |
|---|---|---|---|
| 实例注册表 + 探活 + 端口身份 | `instances` 域 + `instance-probe.ts` | **已有**（`server/registry.ts` + `/api/info` + `sha.sh list`） | 不补（diy2 口径更严） |
| 唤起别的实例窗口（focus / reveal） | `instances` 域 | 无 | **不补**（浏览器形态无"实例窗口"；改为"给我地址"） |
| 远程访问：实例发现 / ping / 身份 | `remote` 域 + `pkgs.ts/remote/link` | 无（只监听 127.0.0.1：`listen.ts:51`） | **补**（P1：浏览器客户端没有远程访问等于半残） |
| Hub 配对（跨机多端，私钥进钥匙串，6 位码 / 一键连接） | `hub` 域 10 命令 + `pkgs.ts/remote/hub` + `HubPage` | 无 | 补（P2，依赖上一行） |
| 出站流量观测（请求 / 响应 / 用量 / 成本，按步归属，按天落盘） | `traffic` 域 12 命令 + llmProxy + `pkgs.ts/ui/devtools-traffic` | 无（直连 provider，抓不到） | 换形态补（P2：AI SDK middleware 代替本地代理） |
| 日志面板 / 健康自检 / 进程采样 | `log` / `health` / `process-sampler` / `diagnostics` | 只有 console + `/api/info` | 部分补（P3） |
| 崩溃 minidump / 退出原因落盘 | `crash-reporting.ts` / `interrupted-cause.ts` | 无 | 不补（无 Electron） |

### 2.7 UI 能力（整页/整块）

| 能力 | diy1 | diy2 现状 | 判断 |
|---|---|---|---|
| 任务树侧栏、页面 tab、layout / viewarea / view 持久化 | `TaskTree` / `ViewGrid` / `ui` 域 | 侧栏（projects / history / orphans）+ `workbench-dock` 另一套 | 不补（各自形态） |
| 聊天渲染（找字、代码块 / JSON 树、工具卡折叠、压缩切点条、轮次结束脚注） | `ChatFindPanel` / `CodeBlock` / `JsonTree` / `CompactCutBar` | 有 `Markdown` / 工具卡（assistant-ui）/ `EndFooterLine`；缺找字、压缩切点可视 | 部分补（P1 找字；P2 压缩切点） |
| 提问卡（多问题 / 选择 / 表单 / 草稿保活 / 撤回） | 无等价（diy1 用 steer 插话） | **已超**：`AskCard` 591 行 + `ask.ts` + drafts | 不补 |
| 模型 chip / 默认模型 / 房间模型覆盖 | `ModelPicker` 等价 | 已有 | 不补 |
| persona 编辑抽屉、主题、CodeMirror、a11y 树诊断 | `PersonaDrawer` / `ThemeSettings` / `MdEditor` / `ui.inspect` | 无 | 不补（P3 视需要） |

---

## 3. 建议批次

**P0 —— 内核收口（不新增概念，只把"另一份实现"退役）**

1. `entity-runtime/tools` 换回 `@diy-agent/tools`（续读、原子写、diff、guard、审计）。
   *先做这一步的原因*：后面所有工具相关能力（job、工具面 hash、输出上限口径）都长在它上面。
2. 接 `@diy-agent/jobs`：`job` 工具（list / status / output / kill / wait）+ run 账落 `<home>/log/job/runs/` + 收口唤醒（notifier → 房间 notice）。
3. 回合刹车：`maxSteps`（env > 房间 > 缺省 200）+ `stopWhen` 真正生效 + 打满时落 `notice`（复用 `end-reason.ts` 的判断，不新造词）。

**P1 —— 让它能长期真用**

4. 模型接入换 `@diy-agent/llm-provider` + `model/catalog`，删掉两处硬编码；接 `pkgs.ts/ui/model-config-page`。
5. 用量账本（按步落 `usage`）+ 成本（用 catalog 价目）+ 会话/房间花费视图。
6. 历史分页（首载窗口 + 上滚补段）与会话内查找（按轮折叠后搜，覆盖已压缩内容）。
7. 远程访问（remote 身份 / ping / 发现；先本机多实例，再跨机）。
8. 任务域 UI（状态、body、移动、关系）与命令侧补齐。

**P2 —— 观测与省钱**

9. 压缩接 `@diy-agent/compaction`（策略 + 触发线 + LLM 摘要）。
10. traffic（middleware 形态）+ `devtools-traffic` 页。
11. 冷缓存提示、步快照 diff / changelog。
12. 通知分层（env 通知 / 留痕信箱）、steer 队列可视、工具面 hash 漂移。

**P3 / 不做**：docs 索引、flow 引擎接入、ACP、persona 抽屉、日志面板；不做 Electron 壳那一整套、facts yaml 库、实例窗口唤起、崩溃 minidump。

---

## 4. 三个反直觉发现（会影响判断）

1. **"dist 断链所以移植"这个理由已经不成立**。
   `entity-runtime/src/tools/files.ts` 头注写着"那个包的 dist/ 在本仓 build 图里有断链，所以移植"。
   实测（2026-11-21，仓库根）：`node -e "import('@diy-agent/tools')"` 与 `import('@diy-agent/jobs')` 均成功加载，
   `pkgs.ts/agent/tools/dist/` 产物齐全。继续保留移植版等于**主动维护第二套行为口径**。
2. **diy2 的模型目录硬编码了两份，且各自独立演进**：`entity-runtime/src/providers.ts`（加 provider 要改服务端代码）
   + `entity-chat/src/models.ts`（上下文窗口 / 价目另写一份）。diy1 那边早在 `model.yaml` + `model/catalog` 收成了单点。
3. **房间没有"没人看着也会停"的硬刹车**：`agent.ts:130` `stopWhen: () => false`，`maxSteps` 没有对应物。
   本机手动对话时无所谓（人就在旁边点停止），但一旦接上远程 / 后台 / 多端，一次工具死循环就是一整夜的钱。

---

## 5. 与旧文档的关系

- `docs/plans/2026-11-12-diy2-alignment.md` 是**建 diy2 之前**的差距分析（那时 entity-runtime 还不存在，缺口是 Inbox / Routing / 信封）。
  本文是**diy2 跑起来之后**回头看 diy1：缺口已经换了一批 —— 从"结构缺"变成"硬保障缺 + 内核双份"。
- `docs/plans/2026-11-13-ui-first-plan.md` 里"先 UI 后能力"的路线已完成；本文 P0/P1 是那条路线之后的"能力对齐"。
