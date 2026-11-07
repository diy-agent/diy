---
desc: 工作流：状态权威 / 两段式插件 / 讨论线程 / 驱动环
updated: 2026-10-22
---

## agent-history

本地 agent 的 `bash` 工具若执行**批量**杀进程命令（按名字匹配 electron 的一类），会杀掉宿主自己的 renderer → 永久白屏且进程被杀事件捕获不到。曾经的运行时拦截 `agent-guard.ts` 已于 2026-10-02 停用（判据分不清宿主与 agent 自己起的实例）；现由 `_guard.md` 提示词约束（`prompts/defaults.ts`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:144）

## flow-authority

工作流实例**读只读 `flow/state.json`**（`path.jsonl` 只用于重建：重建态必须与快照**同形**，不一致即**亮错**、不许静默择一；它有三种记录 `config`/`advance`/`finish`，`FlowState` 三部分各一种来源）；改参数值**只允许尚未进入**（已进入 = 换配置 ⇒ 另起一次运行）；`done` 有两个来源：`diy flow finish`（**宣布**，只许在**结构终端节点**＝无 `next` 出边＝`next.terminal` 上敲门）与**内核 `step` 的终态分支**（##341 起走得通：`flow step`/`flow run` 对 `actor: system` 节点真求值，全过且无 `next` 出边即置 `done`）—— 两者都要留重建材料（`path.jsonl` 的 `finish` 记录）；`--param` 是**数组型**选项，重复给会**后者覆盖前者**（parser 逐项 `input[key]=value`），多项必须写成 JSON 数组那一种；`prompts/flow.ts` 的模版**故意不进 `PROMPT_DEFAULTS`**（那份清单是用户可编辑面，并进去就会改既有 `template list` 输出与 golden 快照）；`vite.pkg-deps.ts` 的 `WORKSPACE_TS_DEPS` 是「要打包的 workspace 包」白名单（**main/serve/preload 的唯一真源**），加 workspace 依赖必须同步加那里（漏加 = 产物里留裸 `import "@diy-agent/x"`，node 加载 `.ts` 直接炸；判据 `rg '^import .*"@diy-agent/' build/<v>/{main,serve}/*.mjs` 应零命中）；**产物袋**（`flow/artifacts/<节点 id>.json`，JSON 数组、下标 = 驻留 `seq` − 1）**不是领域态**：不进 `state.json`、不产生 `path.jsonl` 增量、删了不影响 `advance`/对账 —— 立场是「缺项 = 无产物（`view: null`，正常态）」与「袋坏 = 亮错（不静默降级）」两分，且**坏袋不许拖垮领域读**（`flow show` 照出整页 + `FlowView.viewError` 亮错，只有产物专读的 `diy flow view` 抛）；`view.renderer` 必须与 `art.renderer` 一致（声明是 UI 预选渲染器的契约），`art.plugin` 留空只在「raw 本身已是该 renderer 的 data」时合法（纯文本 raw ≠ `doc` 的 `{ text }` ⇒ 挂 `text` 插件）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:139）

## flow-driver

**驱动环（`services/flow-runner.ts`）判据只读状态**：每步重新 `flow show`（不靠内存进度）⇒ 幂等、可中断、续跑不重复消费；`rule#core-log` 的落点 = 帧与 `events.jsonl` **只作观察**，删了不影响运行（位置/折线/终态全在 `flow/state.json`）。五条别改错：① 分类**顺序**是 `human` → `system` → `agent`（「该谁拍板」优先于「守卫可不可观测」—— 反过来的话 `actor:human` + 可观测守卫会被**自推**，审批点就没了）；② **替用户起轮次前先问 `LocalAgentManager.busy(uri)`**（`chat()` 对忙会话**不拒绝、只排队** ⇒ 不问就会把节点提示词排进**用户自己的会话**、还收不到正文），忙 ⇒ 停因 **`session-busy`**、不碰队列不碰状态；中断时**只停自己起的那一轮**（归属判据 = 收到**自己的** `start kind:"turn"`，排队回执的 `meta.source === "queue"` 描述的是**别人**的轮次）—— ##305 拍板「消费端断开不掐轮次」，所以这句得自己补，不然 `flow run` 会卡在 `await` 上、轮次还烧 token；③ 打回判据是**末行明文约定**（`结论：通过` / `结论：打回（原因…）`，只在当前节点**真有 bounce 出边**时生效，读不到按通过）—— 可复核优先于猜语义；④ 结论**落袋失败不挡这一轮**（试译抛，如纯 JSON 对象落进 diff 节点；产物是派生数据，坏了不挡正路），原因随 `turn` 帧的 `artifactError` **亮出**（不静默）；⑤ 本版三个限制：`next`/`bounce` 出边各取**第一条**（内核允许多条 + `when`，本版不挑）、**命令期不可停**（`stepFlow`/`collectFacts` 不接 `signal`，`exec` 自带 10 分钟上限）、`flow run` **退出码恒 0**（停因在帧里 —— 别拿退出码当判据）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:142）

## flow-thread

**讨论线程（##342）锚点 = 一条真打回边的一次穿越**：`{from: 打回前位置, to: 落点节点, seq: **落点那次驻留**的 Visit.seq}`（一次 bounce 恰创生一次驻留 ⇒ 三元组唯一；**同节点二次打回靠 `seq` 不串台**，##320 P1-1 的同一教训）；文本 id `from->to#seq`（`--thread` 参数 / UI 的 `data-flow-thread` / `flow-model.ts::threadIdOfVisit` 三方逐字一致，有单测钉）。三条立场：① **旁注**（`rule#core-log`）：`threads.jsonl` 不进 `state.json` / 不产生 `path.jsonl` 增量 / **删了不影响**推进与对账（线程结构仍从折线推得出来，只是发言没了），坏行**跳过并计数**（`flow show` 的 `FlowView.threadError` 错误位 + `flow thread list` 的 `skipped`，对照 ##337 P2-B，**绝不拖垮领域读**）；② **不造数据**：`postThread` 写前验「折线上确有这次 bounce 驻留」（`flow-thread.ts::requireRealBounce`），假锚点即拒；读侧对折线上查无的旧发言标 `real: false` 亮出来（坏数据不藏）；③ **三出口**：(a) 撤销打回 = **现有合法边**（dev 定义 `implement --next--> review` 就是那条，**不动内核**）(b) `--type resolved` (c) `--type escalate`（`actor: human` 的发言；领域侧落点 = 走到 `actor:human` 节点如 `approve`）—— 状态由**最后一条状态发言**决定。另两条别踩：④ **「不写空发言」闸门只有一处真源** `flow-store.ts::requirePostText`（`postThread` 与 `appendBounceOpinion` 共用）—— 驱动环的结论行**合法地可以只写「结论：打回」**（`reason: ""`）⇒ 闸门装在 `appendBounceOpinion` 里，驱动环已有 catch 故自动降级为**不写 + warn**（审计照旧记 `打回`：审计与讨论口径不同是对的，往留痕里凑一句评审没说过的话 = 造数据）；⑤ **出口 (a) 撤销打回在讨论视图上无留痕**（走既有合法边 ⇒ 不写讨论流 ⇒ 线程 `status` 停在 `open`）：**接受现状** —— 折线本身即留痕（多一次 `next` 驻留），不给「撤销」开第二处写入语义（避免写入路径分叉），留待 ##325 隐私/权限定案时一并看。UI 讨论区本轮**只读**（可见性/留痕是本任务交付，发放入口只在 CLI；「谁能发言」属 ##325，未定前不钉进 UI）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:141）

## flow-two-phase

**跑外部世界的插件是两段式**：内核插件接口是同步的（`GuardPlugin = (ctx) => GuardResult`），而 `./sha.sh check` / `gh pr …` 必然异步 —— 故事实**先取后用**：`stepFlow` 先 `await collectFacts(ctx, deps)`（异步 I/O，可换替身 ⇒ 不真出网可证），把结果包成事实表交 `createHostRegistry({ facts })`，插件求值时**只读表**。两条硬约束：① 不许在插件里 `spawnSync`（会把 Electron **主进程**事件循环堵死几十秒，GUI 假死 + RPC 排队）；② 没有预热就求值 ⇒ **抛**（无预热即抛 —— 静默当成「不通过」会把工作流悄悄推成另一条路），静默当成「不通过」会把工作流悄悄推成另一条路。任何真跑 `createRuntime` 的地方都必须用 `createHostRegistry()`（只注册 render 的那份会在组合期对 `pred:ci_green` 报 `unknown-plugin`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:140）

## interrupt

中断的 tool 调用必须**在新一轮开始时收敛成显式终态并写进 ops**，投影（`blocksToMessages`）只做纯翻译。禁止退回"投影时现造占位文案"：文案会被模型当待办，重载后同一条自毁命令会被重发

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:129）

## live-turn

**直播轮的判据不能只看"最后一轮"**：外部（CLI / 另一窗口）刚起一轮、而我们还没收到它的 ops 时，最后一轮早已 stop —— 拿它顶替会把一个正常收尾的历史轮画成直播（红框 / "进行中"）。判据 = main 真值 `localChatStore.live` **且** 该轮 turn 块未 stop（`LocalChatPage.tsx` 的 `liveTurnId`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:119）

## ownership

任务目录内 `AGENTS.md` 面向用户可编辑，`.diy/**` 系统独占（仅 main 经 RPC 写）；路径单一出口 `src/main/core/state.ts` 的 `taskSystemDir(uri)`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:143）

## steer-two-phase

插话的「认领」（`prepareStep` 只读队列、注入请求 messages）与「落位」（流里出现 `start-step` 时才 sink + 出队）**不能合并**：两条流不同一时间轴，提前 sink 会把插话插到上一步未完内容之前。轮末开场则**只读不取**（先记账再出队），中途崩掉最坏重复投一遍、不会丢。理由见 `local-agent.ts` 的 `claimStepSteers` 头注

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:146）
