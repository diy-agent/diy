# 上下文树页（ctxlab）约定表

> 本文件从 `pkgs.ts/diy-app/AGENTS.md` 移出：`AGENTS.md` 会经 `chainOf` 注入 system 提示词，
> 受 64KB 系统预算约束（`SYSTEM_BUDGET_CAP_BYTES`），长文放这里，AGENTS.md 只留指针。

| 关注点 | 位置 / 约定 |
|--------|-------------|
| 领域模型（冻结契约） | `src/shared/context/types.ts`：事实（snapshot/replace/patch/remove）→ 树（值树 + 渲染声明 + places/placement + wireVersion）→ 投影（system 全量 / runtime 增量）。**两个 hash 别混用**：`valueHash`（原始值）/ `renderedHash`（渲染出来的文本，模板没引用到的值变了它不变） |
| ⭐ 投递构造（真发与预览**唯一入口**） | `delivery.ts` 的 `buildDelivery(globals, systemPlaces)`：system＝说明头 + 稳定项（进 `streamText` 的 system 参数）；runtime＝易变项（作为**尾部 user 消息**，插在本轮输入之前，**不进块树/llm 历史** → 每轮现拼、不会累积）。`runTurn` 与上下文树页调的是**同一个函数**，所以"预览看到的字节"就是"发出去的字节"（`tests/core/context-delivery.test.ts` 守这条契约）。划分策略（`PLACE_CANDIDATES` / `defaultSystemPlaces`）也住这里 |
| ⭐ 划分规则（真源） | **哪些变量进 system** 是 `$DIY_HOME/context.yaml`（不是页面本地偏好）。真发（`runTurn` → `loadSystemPlaces`）与页面读**同一份** —— 存 localStorage 的写法会让"页面改完预览变了、真发却不理"（界面说谎，实测踩到）。契约与净化在 `shared/context/config.ts`（`sanitizeSystemPlaces`：丢非法路径 / 丢互为祖先后代 / 去重 / 空则回落推荐名单，**返回 dropped 让调用方出声**）；文件 I/O 在 `main/core/context-config.ts`（缺失/坏 → 推荐名单 + warn；原子写 + 说明头）。RPC：`context config` / `context setConfig`；页面 ⇄ 写回真源，**下一轮真发**生效 |
| 真发快照（step） | `local-agent` 每轮真发 append 一条 `$DIY_HOME/local/<key>.steps.jsonl`（`DeliveryStepRecord`：值 hash 表 + 两份全文 + 名单 + wire 版本）；CLI `diy context steps <uri> [--limit N] [--diff]` 读出摘要 + 相邻 diff（**diff 在 main 侧算完**，默认只下发统计 —— 两份 system 各几十 KB，全文下发不可行）。**不塞 raw.jsonl**：那是旁路观测（不参与 UI/状态恢复），这份是投递事实。UI 的 step/diff 该用这份，不要用 `history.ts` 的页面轮询版 |
| 读写与校验 | `tree.ts`（嵌套 JSON 值树 + 不可变写入 + places 两两不可嵌套）、`reducer.ts`（applyFact 一律不静默合并：baseHash 不匹配即拒绝并要求 rebaseline）、`projection.ts`（内容未变不发 / 全消失发显式 clear / 版本或 placement 变化发 snapshot） |
| 纯 YAML 渲染 | `render.ts`：**自实现产出器**（不引 js-yaml 输出侧）——输出逐字节可预测（golden 拿它当基准）、shared/ 零 node 依赖；空对象/空数组输出 `{}` / `[]`（与"没有这个值"区分）；`renderPathsTraced` 的**行号映射与文本同出一次产出**（选中联动定位必须同源，否则指错行比不高亮更糟） |
| 块标量（多行文本落法） | ⚠️ 三条实测踩坑（都会让整份 YAML 解析失败或悄悄改内容，用例见 `tests/core/context-tree.test.ts` 的「块标量的保真」）：① **缩进指示符**：内容首行有前导空格时必须写 `\|2` —— 自动判定会把首行缩进当块缩进，于是后续浅行掉出块（`wc -l` 的 `   352 …` 让 338 条历史的请求预览崩在 509 行），或整段公共缩进被吞掉（源码类工具输出）；② **chomping**：原值尾换行 0 个时必须 `\|-`（strip），否则回读凭空多一个 `\n`；③ **控制字符**（终端 ANSI 色码）块标量表达不了 → 退回双引号转义标量（`JSON.stringify` 转义是 YAML 双引号转义的子集）。尾换行 ≥2 个同走转义标量。**判据是内容自身的前导空格，不是渲染后的行缩进** |
| 说明头 | `guide.ts`：上下文 YAML 前面的纯文本说明（结构 + 解读规则）。**暂不模版化**（先看内容；要模版化时只换本文件，树/划分/投影不动）。它参与 renderedHash（改它 = 改 wire 语义） |
| 页面数据 | `preview.ts`：真实 globals（`assembleGlobals` 的产物，不是示范数据）+ system 名单 → 树/规则/两份投递/请求体；`PLACE_CANDIDATES` 只声明 system 名单，其余自动 runtime（不是两套表）。**候选拆到子字段**（`task.title` 稳定 vs `task.body` 易变）——按第一层粗暴划分会让易变内容污染 system 缓存 |
| 请求预览 | `request.ts`：**整份请求体渲染为一份大 YAML**（树形文本编辑器形态）。请求体里与 system/runtime 两份文本**逐字相等**的字符串，就地解析为 YAML 子节点展开（解析的是 body 里那段原文本身，不是另算的一份）——说明头按注释输出（内容不丢、整份仍是合法 YAML）；解析失败退回块标量原文，不强行展开。wire 一行不动，UI 提供「原文」切 JSON（真发格式） |
| 页面与 view | `ContextLabPage.tsx` + registry 的 `ctxlab.*`：**两列**（左=结构树/变更列表，中=请求预览）。**单份视图已删**（变量树 / system 份 / runtime 份 / 变更详情）—— 同一份文本的展开形态就在请求预览的树里，看两遍没有增量信息。块折叠态走 `Caches.diy_ctxlab_fold`，CLI：`ui view expand ctx.<structure\|steps\|request> open\|closed` |
| 选中联动 | 点结构树一行 → 请求预览滚到并高亮**那几行**（行号由渲染同源收集、内嵌块无需换算）；请求预览里内嵌块的行号就在同一份映射里 |
| 变更列表（待接快照） | 左栏「变更（step）」当前还是**重算对比**打出来的观察列表（`shared/context/history.ts`，内容没变不新增），只展示不选中。真发快照已就位（见上），下一步把它换成读 `context steps`：选中第 N 步 → 与第 N-1 步比；取消选中 → 当前 vs 最后一步 |
| ⚠️ 两处"请求预览"只有一处是真发 | **上下文树页**（ctxlab）的请求预览 = 真发形态（同 `buildDelivery`）；**提示词页**（lab）的请求预览是**模版线**（`assembleSystem` 渲染 `_system.md` + AGENTS.md 链），它的 `requestNote` 已明确标注此事。别把 lab 的预览当成"会发出去的东西" |
| 意图测试 | `tests/cli.intent.ui-context.test.ts`（RPC 契约 + 两列上屏 + 请求预览 YAML/原文切换 + 投递快照读取/diff + 已删视图不复现）；`cli.intent.template.test.ts` 只覆盖模版线 |；纯函数单测见 `tests/core/context-*.test.ts`（含 `context-request.test.ts` 的请求预览用例与块标量保真用例） |
