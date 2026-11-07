---
desc: 会话历史与压缩：折叠 / 分页 / 广播 / 装配管道 / 聊天渲染
updated: 2026-10-22
---

## budget-compact

压缩 = **一个字节预算**（`budgetBytes`，UI 显示 KB，除固定开支外历史消息可占上限；`0`=清零，**且 0 时保底也不生效** —— 清零就是「全不要」）：缺省管道（##343 M1）= **保底最近 6 步 `clip: full`**（`exempt`，**不占预算**：只保下标不保字节治不了「留下的结果被裁成头尾」）+ 纵向优先级阶梯（`user > assistant结论 > assistant非结论 > tool-call > tool-result`，全局跨轮、同层新的先、call 与 result 同进退）计预算保留。**不是**「保留 N 轮」（横向会整轮陪葬前面重要的用户消息 —— 用户明确否决）

**信封 `history` 注记必须拆 `countBytes` / `mustBytes`**：托底级不占预算 ⇒ `keptBytes > budgetBytes` 是**常态**。只报 budget+kept 两个数，读的人只能得出「超了 58%」这个错误结论（##5 实账 20480 vs 32298，代码一直对、说法错）。

（见 3688c89f:pkgs.ts/diy-app/src/shared/context/budget-note.ts:22）

## chat-reload

**轮末收尾重放必须走「幂等并入」，不许重建**（`localChatStore.mergeWindow`）：旧实现每轮都 `new BlockStore()` 全量 fold → `toForest` 的身份缓存（TreeCache）整片失效 → Solid 的 `<For>` 把**每一轮**都销毁重建（含全量 Markdown re-parse）—— 这正是大会话“每次轮末 GC 风暴”的根因。折叠流幂等，再喂一遍即可，未变的轮次引用不变（实测第 1 轮 DOM 节点跨轮仍是同一对象）。大会话另有一层见 `app.history#chat-virtual`：DOM 里只挂视口附近若干轮（离屏轮**不在 DOM**，不是靠 `content-visibility` 跳过绘制）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:93）

## chat-virtual

**滚出视口的轮不挂 DOM**（##301；`lib/chat-virtual.ts` + `LocalChatPage` 的 `VirtRow`）：`content-visibility: auto` 只跳过离屏子树的布局与绘制，**DOM 与组件状态照旧**（48 轮实测 1441 个节点全体在树里）⇒ 要真降下来必须把远端轮摘掉。几何 = 每行**绝对定位**、顶边取**账面高度前缀和**（行间距由账给，不用 `space-y-*`：spacer 与相邻行的间距要另推一遍账，边界必差一个 gap）。三条硬约束：① **位置补偿只此一处** —— 任何"行顶边会变"的因（测量修正 / 前插补段 / 重置）都由同一个监听布局的 effect 按「视口锚点」纠正；`applyHeights` 与 `loadOlderInto` 各算一遍就是重复补偿（实测一次上滚多推 605px）；② **锚点锚在"块"上、不锚在像素上**（`pickAnchorIn`/`applyAnchor`）；程序化滚动**只走 `writeScrollTop`** —— 它写元素 + 同步 `scrollTop` 信号（虚拟窗口由信号驱动，只写元素则窗口还按旧位置挂行、锚点块不在 DOM）并记下写入值 `progWriteTop`，让紧随的 scroll 事件**不重取锚点**；分辨"用户在滚"归 `anchorTick` 的 `lastSt` latch（≤1px 容差）；③ 高度估算的**唯一出口**是 `HeightLedger`（CSS 里不再留 `contain-intrinsic-size` —— 两处各估一次必然漂移），未渲染轮用已测均值、实测过的行**永久保留**（卸载不清账，滚回来位置才稳）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:94）

## clip-axis

**裁剪能力轴**（##343 M1）：每条取法（`PickStage`）可声明 `clip`（`full | path | headtail{head,tail,maxLineChars,maxKeepBytes}`，判别键 `type`、私有参数进 `data`），**先选中它的级生效**，没声明则回落 `defaultClip`（= 策略 `toolResult.render` 的降级）⇒ 选择结果带 `clips[]`，渲染阶段按**每条消息**取裁法（成本与渲染必须同源，否则「按 A 算预算、发出去是 B」）。配置化（`history.keep[]`）已由 ##344 M2 落地（见 `app.history#compact-keep`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:103）

## compact-keep

**装配管道 = 数据**（##344 M2）：`auto-compact.yaml` 的 `history.keep[]` 是级列表，级 = `{ type, must?, limit?, clip?, data }`（遵 `rule#discriminated-union`：`type` = **取法** `ladder|role|recent|steps`、与它同级 = 公共字段、私有参数进 `data`）；数组序 = 优先序（先声明的先挑、先选中者的 `clip` 生效）。**读侧宽松**（无/坏 `keep` ⇒ 只丢 `history`、回落 `DEFAULT_KEEP`，不回归）· **写侧校验后才落地**（非法 ⇒ 拒绝且不动文件）。缺省管道以 `DEFAULT_KEEP` **单一真源**表达（`defaultBudgetPlan()` 由它生成）⇒ 代码与「配置面回显」不会分叉。⚠️ 级里清字段要**删键**，不能写 `undefined`（`yaml.dump` 会落成 `clip: null` = schema 非法值）。

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:100）

## compact-lazy

**压缩预览（`compactPreview`）= 成本 ∝ 会话字节的「只算不写」调用**（一份 78MB 会话整读 + 解析 + 折叠 ≈ 数秒，且 main 单线程期间所有 RPC 排队）⇒ **必须由可见性闸门保护**：控制器 `useCompactPanel(uri, visible)`（`CompactSessionPanel.tsx`）的**第二参即闸门**，调用方传 `() => props.open`；`ContextPartsDrawer` 由常挂的 `WindowRing` 持有（`open` 只控显隐、节点总在树上），漏传闸门 = 打开任何会话页都白算一次。source 另须用**当前页 `props.uri`**（勿读挂载瞬间的 `store.currentUri`，否则从大会话切走会对着旧会话再算一遍）。护栏单测 `tests/core/compact-preview-reuse.test.ts`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:102）

## compact-note

预算压缩的历史标注 = **普通 YAML 文本塞进 messages**（同 system/runtime 变量树同一机制）：只列**保留区间** `kept: [[a,b],…]`，区间之间的行号即被省略（**不逐 gap 标注**）；字段说明走**信封的 `help.history`**（由 zod `HistoryNoteSchema` 派生；值节点里禁解释性字段）。⚠️ 标注是投递时现算的文本 ⇒ **本就在预算内**（无需为它另设封顶）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:101）

## compact-shape

策略真源是**带归属的结构** `{ mode:"budget", modeData:{ budgetBytes, toolResult }, summary }`（`modeData` 内 = 该 mode 私有；与 `mode` 同级 = 共有）。现役**只有 `budget` 一种算法**（`reset`/`keep` 已删，未发布无需兼容）。工具结果的呈现（`toolResult`，headtail 参数在 `renderData`）是**系统内部旋钮**（不给用户拧）。互转收口：`normalizePolicy`（任意→合法）/ `flatPolicyOf`（→扁平输入面）/ `budgetBytesOf`（→字节预算唯一入口）。**别再新增第三形状**

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:99）

## compact-triggers

自动压缩的三个触发（`systemContextChanged` / `cacheExpired` / `contextWindowOver`）**全是从现成数据可判定的确定事实**（零额外请求），**不含"划不划算"的预测** —— 后者是 ##230#25 明确放弃的评估；改动别把判据换成估算

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:106）

## config-vs-history

**配置 / 历史分离**（用户 2026-10-07）：投递口径 = **当前配置**（`$DIY_HOME/auto-compact.yaml` 的 `policy` **+ `history.keep[]`**，见 `app.find#compact`），**每次请求实时算** ⇒ 改预算/改管道**本轮即生效**；压缩账（会话目录的 `compact.jsonl`）只是**不可变快照**（历史页/回溯用），**不决定投递**（v4 起每行带 `plan.planVersion` 指针 ⇒ 回查到 CAS 即「当时那套 plan」；v3 旧行的 `plan.keep` 全文照旧可读，见 `app.history#plan-version`）。⚠️ 别再让投递去读 `resolveBoundary`（旧边界机制已废：没压过就不生效，违反直觉）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:90）

## history-cursor

分页的**窗口边界只是 main 的知识**：渲染端拿到的是**不透明游标**（只回传、不解释字节）。失效（清空 / 覆盖写 / 换文件）一律退**全量**并由 main 出声 `HistoryWindow.stale` ⇒ 消费端必须**整树重置**，**不许**拿「前缀守卫恰好成立」兜（被覆盖写的全量与末段轮次 id 恰好相容时，守卫会放行、把两段不同来源的历史缝在一起）—— 两个消费端（轮末 `doReload` / 上滚 `loadOlder`）都得认这个字段；且 stale ⇒ 除整树重置外，仍须**丢弃末段游标**（main 退全量时 `hasMore=false`、游标落在 at:0，而 at:0 是合法轮首 ⇒ 回传会被照收、每轮退全量。收口在 `mergeWindow` 重置分支：`stale ? null : cursor`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:97）

## history-filter

**历史 = 固定的消息集合**；一次压缩 = 用**某算法**对它定义的一个**过滤条件**。事件里的 `policy` 承载**算法**（`mode`，现役只有 `budget`）与该算法的**过滤器表达**；**换算法 = 加新分支 + 新 filter 形状**，别用一套结构硬套。旧「分代（generations）」**已删除**（连续轮边界表达不了预算的分散保留）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:91）

## md-reconcile

**MarkdownView（`renderer_solid/components/MarkdownView.tsx`）必须走 solid-markdown 的 `reconcile` 策略，且 `pre` 里取代码正文/语言必须用访问器现读**。两个都是硬约束，破一个就有肉眼可见的 bug：① 用 `memo`（库的缺省）时每帧给出全新 hast 树，`<For>` 按引用比对 ⇒ **每帧把整棵子树拆了重建** —— 块内 `overflow` 容器的 scrollLeft 归零、拖出的选区被清空（用户看到的「拖到长行右侧又被拉回起点」「流式中选不中、copy 不了」）；② `reconcile` 按位置合并、节点对象**就地更新且身份不变** ⇒ 组件函数体只跑一次，`const n = props.node.children.find(...)` 这种读法会停在第一帧（表现为流式代码块只显示开头一段）。同理 `components/CodeBlock.tsx` 的两态（未定稿纯文本 / 定稿 Shiki）**共用一个恒常滚动外壳**：各带一个滚动容器的话，定稿那次切换等于把容器换掉，滚动位置照样丢。回归 `tests/cli.intent.ui-chat-render.test.ts`（桩上游逐 delta 推，判据是「同一个元素对象 + 滚动位置还在 + 选区还在」）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:95）

## ops-broadcast

**op 的落盘与广播必须成对，且写入者只有 main**：全部 `ops.jsonl` 写入都经 `local-agent.ts` 的 `opsSink`（CLI 也是 RPC 客户端 → 同一个 main），故「变化」在写点即知 —— 不尾随文件（chokidar 有 debounce 时延）、不轮询。`publish` 只在 `appendFileSync` **成功之后**调用（失败仍广播 ⇒ 订阅侧水位超前于盘，此后按行号的补发/去重全错）。订阅后 UI 不再靠轮末全量重放追平；洞由「重订补发」修，`reload` 降级为「收到 reset」的兜底。**停止收尾期间**另有一节轻量 tick（`lib/stop-ticker.ts`）推进 `now`，否则 main 卡在工具里（不发 op）时 `stoppingStuck` 永不翻真，「强制中断」出口成死代码；ticker 同步**收口**在 `localChatStore.ts` 的唯一写点 `setStopRequested`（改停态即对齐）+ `watch`/`open` 起始（切回仍在收尾的任务需重新开表），漏任一处该出口即失效

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:98）

## ops-fold

**会话历史读出来是折叠过的**（`compactOps`；对消费端透明：同一棵块树，只是逐 token 的 delta 碎片变成每块「`start` + 一次终值 `patch` + `stop`」，实测一次 74MB / 87.7 万 op 的会话 → 15.2MB / 1.76 万 op）。三条不可动摇的约束：① **无父块必须显式写 `parent: null`** —— 省字段（undefined）在 JSON 里会整条消失，重放时退回栈顶，于是“本就该是根的块”被前一棵未闭合子树认领；② `patch` 值未变不写也不碰 `touched`、`stop` 只在“未定稿 → 定稿”那一次碰 ⇒ 对同一份折叠流**重复 apply 无副作用**；③ 折叠流按**轮次递增**（DFS 顺序 = 轮次顺序）；**缓存判据在 main**（`foldedOps`）：按 `(task, start)` 分键，用「已消费字节 + 前 4KB 指纹」判续 fold（`consumed > size` 或指纹变即整份重建）。渲染端是**按段**前缀守卫（`mergeWindow`）：末段轮次序列是新窗口前缀时**增量**并入，否则整段重置（**不是**「整份重建」）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:92）

## plan-gate

**plan 写闸只管 agent**（##362 M3a）：`history.allowAgentWrite` 缺省 `false`，只拦 `compact_plan` 工具那条路 —— CLI `compact plan set` / UI 编辑器是用户**自己的**显式操作，若也拦就没人能开闸了。三条实测坑：① 改 `saveKeepConfig` 时**必须保留 `history` 的其余字段**（整包换成 `{ keep }` 等于顺手把闸关掉 ⇒ agent 写一次就永久失去权限）；② **reset 同走闸**（`planReset` 与 set/restore 一样先查 `history.allowAgentWrite`，闸关返回拒绝文本；##363）；③ 闸关时工具**返回拒绝文本而不抛错**（抛错会被当成工具失败、污染轮次信号，模型看不出"是没权限"），而**非法 plan 要抛**（那是调用方写错，该看到错在哪）—— 两者判据不同向，别互相抄

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:88）

## plan-version

**plan 版本 = 内容寻址**（##378）：id = `plan-` + `sha256(canonicalJson({v,source,keep[]}))` 前 12 位 —— canonical = **对象键递归字典序、无空白、丢 `undefined` 键**（直接用 `JSON.stringify` 会因构造键序不同把同内容 hash 成两版）；全文存**不存 diff**（plan 几百字节，diff 换来的是链式依赖）、**不设份数上限**（要加上限必须出声 + 迁移，否则事件账 `planVersion` 悬空）。四个不回退的点：① 版本文档**只含 plan 数据**（`ts/op/via/taskUri/parent/brief` 进 index，否则同内容不同时间 hash 成两份、去重失效）；② `source` 进内容 —— `default` 版 restore 是**删键**（跟随将来缺省），`config` 版才是写级列表；③ 入链**幂等**：与链尾同内容 = 不追加（否则重复行 + 自指 `parent`）；④ 旧时间戳快照与 v3 事件**只读兼容、不迁移不改写**（restore 收到旧快照 id ⇒ 读到即转成版本入链）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:89）

## tool-output-clip

**单条工具输出的截断落投递层**（##127）：挂在 `tool.toModelOutput`（`main/services/tool-output.ts`），**不在 `execute`** —— `execute` 返回值是落进 ops 的原文（UI/日志/压缩都从它取），裁了原文当场丢。超 2000 行 / 50KB（= read 窗口的 `READ_MAX_LINES` / `READ_MAX_BYTES`，三路径同一预算）即头尾 + marker + 原文落**会话目录** `$DIY_HOME/local/<uri 路径>/<key>/toolout/<toolCallId>.txt`（##379 随会话分层；旧共享 `local/toolout/` 读侧兜底）（marker 写**绝对路径**：模型只按 cwd 解析相对路径）；bash 工具的 `maxBuffer`（`runBash` 自持 spawn，32MB）只当内存护栏且触顶**显式**报（不再静默 ENOBUFS）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:104）
