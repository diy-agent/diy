# @diy/flow

diy **工作流内核**：工作流定义 DSL + 泳道容器（单指针 / 打回）+ 插件槽 + 参数层（L2）+ guard 求值 + 转移执行器 + 轨迹折线投影。
纯内核（仅依赖 `@diy/talk` 的事件原语）：不认识文件系统、**不触外部世界**（插件副作用全在宿主给的函数体里）、
**不取时间**（事件的 `at` 由调用方传入）。

一句话概括它解决的问题：一条工作流 = 泳道图上的一条折线 —— 状态自上而下在泳道间变迁，打回时
从 from 画线回 to，最终形成完整行为路径（如 `A→B→C→B→D`）。**泳道 ≡ 节点（1:1）**，打回**不新建节点**
（只是轨迹再次穿过同一条泳道）。依据 ##311 §一 与 ##166 §14.2/§14.4。

**领域状态一等、`Event` 降为审计（##333 依赖反转）**：

- **领域态 `FlowState{ position, path, params }` 自成真源**：由领域操作 `advance(def, state, { to, at, ref?, params? })` 产出，
  **不吃日志**；可整份落盘、可读回（`flowStateToJson` / `parseFlowState`）。判据：**「第 n 次驻留」是领域
  事实（进 `path`）；「这条 Event」是消息（审计）**。
- **`Event` 只是进度通知 / 审计材料**：`step` / `declare` 的 `seed.id` 给了才落一条；不给就是纯领域推进
  （`transition.event === undefined`，`notify` 也不唤醒）—— 清掉日志不影响运行。
- **内核不编人类文本**：转移给结构化语义 `Transition.move = { kind: 'entry'|'next'|'bounce', from, to }` + `reason`，
  渲染成什么字是宿主的事。`apply(def, state, event)` 保留为**薄适配**（Event → 一次领域推进），
  用于从日志重建（`project`）。
- **关联靠显式 ref**：`Visit.ref`（`taskUri` / `turnId` / `stepId`…）由宿主注入、内核只透传不解释；
  审计侧要指回领域，用折线末端的 `{ node, seq }` 作坐标。

**同一条泳道图里，流水线行为与聊天室行为共存**（##166 §10.3）—— 分水岭是 **guard 可不可观测**：

| guard 引用 | 可观测？ | 谁推 | 那条审计 Event（`seed.id` 给了才落） |
|---|---|---|---|
| `pred:名` | ✅ 引擎自己能判 | **系统**（自动转移） | `author = 'system'` |
| `action:名` | ✅（且是**写**外部世界） | **系统**（自动转移） | `author = 'system'` |
| `prompt:名` | ❌ 只是一段提示词 | **actor 自己宣布** | `author = 宣布者`（宣布本身就是一条发言） |

## 快速开始

```ts
import { advance, createRegistry, createRuntime, defineWorkflow, flowStateToJson, initialState, parseFlowState } from '@diy/flow';

// 两个节点 + 一条打回边：泳道 ≡ 节点，打回不新建节点
const wf = defineWorkflow({
    id: 'dev',
    entry: 'implement',   // 双向环 → 两节点都有入边，入口须显式指明
    nodes: [
        { id: 'implement', name: '开发', actor: 'agent', guard: ['prompt:dev_done'], hint: '开发完成 xx 任务，完成后提交给 Review 步骤' },
        { id: 'review', name: 'Review', actor: 'agent', guard: ['prompt:review_done'], hint: 'P0/P1 打回，全部有落点则放行' },
    ],
    edges: [
        { from: 'implement', to: 'review', kind: 'next' },
        { from: 'review', to: 'implement', kind: 'bounce' },
    ],
});

// ① 领域正路：只吃领域输入（内核不取时间、不生成 id、不碰日志）
const at = '2026-10-13T00:00:00.000Z';
let state = advance(wf, initialState<'implement' | 'review'>(), { to: 'implement', at }).state;
state.path.map((v) => `${v.node}#${v.seq}:${v.kind}`);   // → ['implement#1:next']

// ② 领域态可独立落盘 / 读回（清掉日志也不影响运行）
const json = flowStateToJson(state);
parseFlowState(json).position;                           // → 'implement'

// ③ 执行器：`at` 必填（领域事实）；`id` 不给 = 不落审计事件
const rt = createRuntime(wf, { registry: createRegistry(), maxBounces: 3 });
const entered = rt.step(initialState<'implement' | 'review'>(), { at, id: 'e1' });
if (entered.status !== 'moved') throw new Error(entered.status);
entered.transition.move;                                 // → { kind: 'entry', from: null, to: 'implement' }
entered.transition.state;                                // → 领域态（事件只是旁路的审计材料）

const probe = rt.step(entered.transition.state, { at, id: 'e2' });
probe.status;                                            // → 'awaiting-actor'（implement 是 `prompt:` 节点，引擎判不了）

// 转移由 actor 宣布 —— 宣布本身就是一条发言（审计事件）
const toReview = rt.declare(entered.transition.state, { id: 'e3', at, author: '开发 agent', to: 'review', content: '开发完成，提交 Review' });
const bounced = rt.declare(toReview.state, { id: 'e4', at, author: 'Review agent', to: 'implement', content: 'P0 未落点 → 打回' });
bounced.move;                                            // → { kind: 'bounce', from: 'review', to: 'implement' }
bounced.state.path.map((v) => `${v.node}#${v.seq}:${v.kind}`);
// → ['implement#1:next', 'review#1:next', 'implement#2:bounce']
```

系统节点（`pred:` / `action:` 全可观测）则由引擎自己推 —— 无人发言：

```ts
const ciWf = defineWorkflow({
    id: 'ci',
    nodes: [
        { id: 'ci', name: 'CI', actor: 'system', guard: ['pred:check_green', 'pred:intent_green'], hint: '两套检查都绿才推' },
        { id: 'merge', name: '合并', actor: 'system', guard: [], hint: '' },
    ],
    edges: [{ from: 'ci', to: 'merge', kind: 'next' }],
});

const registry = createRegistry()
    .register('guard', 'check_green', () => ({ pass: true, reason: 'CI 绿' }))
    .register('guard', 'intent_green', () => ({ pass: true }));
const rt2 = createRuntime(ciWf, { registry });

const a = rt2.step(initialState<'ci' | 'merge'>(), { at, id: 'e1' });   // 进入入口 ci
if (a.status === 'moved') {
    const b = rt2.step(a.transition.state, { at, id: 'e2' });
    if (b.status === 'moved') {
        b.transition.event?.author;    // 'system'
        b.transition.event?.content;   // ''（内核不编人类文本 —— 要正文就自己给 seed.content）
        b.transition.move;             // { kind: 'next', from: 'ci', to: 'merge' }
    }
    // 若某条 pred 不过：没有 bounce 边 → b.status === 'stuck'（「卡住」在**边上**，##101 结论四）
}
```

## 领域状态与序列化（##333）

```ts
FlowState { position: Id | null; path: Visit[]; params?: Record<string, unknown>; done?: boolean }
Visit     { node: Id; seq: number; kind: 'next' | 'bounce'; at: string; ref?: Record<string, string> }
```

- **`path` 是 append-only 折线**：`advance` 只追加一条 Visit ⇒ 天然满足「增量」；整份 `FlowState` 又是快照 ⇒
  「增量 + 可重建快照」两种形态都成立。**落盘位置 / 文件布局不归本包**（归 ##319）。
- **`params` 是领域事实**（##311 §二 L3 / ##333 交付 G）：L2 实例参数值（`{ 节点 id: { 局部名: 值 } }`，
  全量、缺省已合并、纯 JSON、冻结）**随状态一起流转**。两条路都承载它（##333 review2 P1）：
  `createRuntime` 把本次运行用的那份写进产出的状态；**`advance` 也能收**（`AdvanceRequest.params`，纯透传）
  —— 若只有 runtime 能补参数值，用领域正路落盘的状态就是**残缺真源**（读回喂回 runtime 会被 `invalid-param` 拒）。
  ⇒ 状态文件自足：读回时把它交回 `createRuntime`（`params: state.params`）就与原来那次运行**同配置**
  （`ctx.params` 与插件读到的完全一致）。三条不变量：
  **① 状态带着另一份参数值** ⇒ 亮错（不静默按谁跑，`invalid-param @ state.params`）；**② 状态已进入却没记
  参数值**（`position !== null` 且 `params === undefined`，而本次运行有参数值）⇒ 也亮错 —— 那不是「缺省」
  而是**这份状态丢了自己的配置**（唯一放行的是尚未进入：`initialState()` 本就不带 `params`，那是全新一次
  运行的正路）；**③ 状态已有的参数值不许被换掉**：`advance` 请求带的值与状态里那份不一致（键序无关比较）
  ⇒ 亮错（`invalid-param @ request.params`）—— 折线上早先的驻留是拿旧配置跑的，换掉即「混配状态」，
  而落盘会把旧值抹掉、事后无从发现。**换参数值 = 另起一次运行**（`initialState()` 从头进入），
  `createRuntime` 与 `advance` 同一条口径。
  凡从 runtime 出来的 `state` **一律带**本次运行的参数值（`done` 分支也不例外）。
  值的**语义**校验归 ##316（`resolveParams(paramsOf(def), 值)` 是唯一入口，本包不重写）；快照这层只保证
  它是可落盘的纯 JSON（`NaN` / 函数 / 环形结构 → `invalid-state`）。
  冻结深度有一处**已知差异**：声明了参数 = 逐项受管（袋 / list 都冻结）；没声明 = 只冻顶层、内层照旧透传
  （引擎不替宿主定「透传袋里只准放纯 JSON」）。
- **`done` 是领域事实**：guard 全过且当前位置**没有 `next` 出边** ⇒ 工作流跑完。判据是**结构事实** ——
  **边上的 `when` 不参与**：有 `next` 出边而 `when` 全不成立 = 停在**边上**（`stuck`）；只有 `bounce` 出边的
  节点 guard 全过 = `done`。记在态里，重复 `step` 才能不重跑 `action:`（##315 review2 §D 的记账）。
  它**重建不出来**（日志里没有）—— 这正是「日志可清可丢、领域态必须自己落盘」的具体样子。
- `flowStateToJson(state, { compact? })`：先校验规范化再写（键序固定、字段封闭）⇒ 落盘文本稳定、diff 友好；
  `compact: true` 输出单行（jsonl 用）。
- `parseFlowState(value, path?, { allowUnknown? })` / `flowStateFromJson(json, opts?)`：**读回可信** ——
  除形状外还兜住**语义自洽**：`position === null` 当且仅当折线为空、`position` 必须等于折线末端、
  每节点 `seq` 按序恰为 `1,2,3…`、`done === true` ⇒ 已进入过（「跑完」不能凭空发生）。
  非法一律抛 `FlowError`（`invalid-state` / `invalid-json`）。
  **`at` 不要求单调**（立场，非疏漏）：折线次序由 `path` 数组承载，`at` 只是那次驻留的信息 —— 要次序看下标，
  别信 `at`（时钟回拨 / 宿主补录都照收）。
  **`params` 只兜纯 JSON 性、不兜值语义**（立场，非疏漏）：读回路径不经过 `resolveParams`（它只吃状态、不吃
  `def`）⇒ 盘上的 `params` 可能是脏的；但脏值**进不了运行态**（唯一闸门仍是 `createRuntime`）。
- `isFlowState(value)`：非抛出版试探（给 UI / 宿主读盘前用）。
- `allowUnknown` 是**只读检查闸**（同 `@diy/talk`）：只让解析不报错、**不保留**未知字段 ⇒ 别拿它读进来的对象
  再 `flowStateToJson` 写回（读-改-写会抹掉新字段）。
- `apply(def, state, event)` / `project(events, def)` 是**审计侧**的入口：把日志重放成折线（重建路径）。
  事件的 `id` / `author` / `content` **一律不进领域态**；`done`、`params` 与 `Visit.ref` 都**重建不出来**
  （日志里没有 / `apply` 只解 `anchor.data.nodeId` 与 `at`）—— 这正是「领域态必须自己落盘」的具体样子。

## 导出

| 导出 | 是什么 |
|---|---|
| `defineWorkflow(def)` | 定义工作流：`nodes[]`（泳道） + `edges[]`（转移）；`edges[].from/to` 只能取节点 id（编译期护栏） |
| `advance(def, state, { to, at, ref?, params? })` | **领域操作**：位置变更 → `{ state, kind }`（纯函数、不吃事件、不落日志；`params` 给了就用、没给继承，**带的值与状态里那份不一致即拒**；`ref` 随状态继承） |
| `createContainer(def)` | 单指针容器：`.advance(req)`（正路）/ `.apply(event)`（审计适配），均返回新容器（不可变）；`.position` / `.path` / `.params` / `.done` 是领域态的只读视图 |
| `apply(def, state, event)` | **薄适配**（审计 / 消息入口）：Event → 一次 `advance`；`project` 的重放路径靠它 |
| `flowStateToJson` / `parseFlowState` / `flowStateFromJson` / `isFlowState` | 领域态落盘 / 读回（结构 + 语义自洽校验，读回可信） |
| `createRuntime(def, opts)` | 转移执行器：`step`（系统自动推）/ `declare`（actor 宣布）/ `status`（现在轮到谁） |
| `createRegistry()` | 插件注册表：`register(slot, name, fn)` / `resolve(slot, name)`（未注册即报错） |
| `evaluateGuards` / `classifyGuards` / `unevaluatedGuards` / `parseGuardRef` / `selectEdge` | guard 求值（与 + 短路）与出口消歧（`when` 单出口也判），可单独复用 |
| `project(events, def)` | 折线投影（纯函数）：`{ currentNode, path: Visit[], visits }` |
| `paramsOf(def)` / `resolveParams(schema, values)` | 参数层：收集 `{ schema, defaults }` / 实例值校验 + 默认合并 |
| `parseParamsSchema(snapshot)` | 参数快照的反向校验（形状封闭 + `defaults` 与 `schema` 对齐） |
| `interpolate(template, params)` / `renderHint(node, params)` | `hint` 插值（`${局部名}` / `${节点 id.局部名}`，`$$` 转义）；`renderHint` 出错定位到 `nodes.<id>.hint` |

`Event` 复用 `@diy/talk` 原语：`{ id, author, anchor, content, causes, at }`，其中 `anchor = { type: 'node', data: { nodeId } }`。
**它是消息、不是状态载体**（##333）：`step` / `declare` 的 `seed.id` 给了才落，`Transition.event` 因此是可选字段。

## 插件槽位（五个，固定；工作流只能**引用**）

「引擎能枚举的 → 配置；引擎查不到的 → 插件」（##166 §13.1）。**槽位固定、不能自创接口**（§13.2）：

| 槽位 | 接口 | 为什么非写不可 |
|---|---|---|
| `guard` | `(ctx) => { pass, reason? }` | **读**：外部世界的「过没过」（CI 状态、回测指标） |
| `source` | `(ctx) => data` | **读**：外部数据（行情 / CI 日志 / 素材库） |
| `action` | `(ctx) => { ok, ref? }` | **写**：对外部世界动手（合并 / 发布 / 下单） |
| `render` | `(data, anchor) => View` | **译**：非文本形状 → 引擎通用渲染器（**不写页面**） |
| `notify` | `(event) => { delivered, note? }` | **唤**：唤醒谁（`createRuntime` 的 `notify` 选项逐次唤醒） |

`notify` 是五槽里**唯一不收 `ctx`** 的（贴 ##166 §13.2 原文的**有意偏离**）：代价是通知方拿不到
`params` / 节点 —— 将来要按参数路由唤醒，得改签名。

真函数由宿主（各工作流开发包）在启动时注册 —— 内核只按名调用，一个具体实现的字节都不写。
`prompt:` 引用的名字**不需要**注册（它本来就只是提示词）。

## 参数层（L2：用户只能改值，不能改形）

判据同「引擎能枚举的 → 配置」（##166 §13.1）：**引擎画得出一个控件的类型才收**。声明写在节点定义里
（L1 代码），值走数据（L2，纯 JSON —— 可落库、可被 UI 表单改）：

```ts
const wf = defineWorkflow({
    entry: 'implement',
    nodes: [
        { id: 'implement', name: '开发', actor: 'agent', guard: ['prompt:dev_done'], hint: '开发完提交 Review' },
        {
            id: 'ci', name: 'CI', actor: 'system', guard: ['pred:check_green'], hint: '跑 ${command}',
            params: [
                { name: 'command', type: 'string', label: 'CI 命令', default: 'npm test' },
                { name: 'targets', type: 'list', label: '目标平台', default: ['bilibili'] },
                { name: 'timeout', type: 'number', label: '超时', default: 30, min: 1, max: 600, unit: '秒' },
                { name: 'flaky', type: 'boolean', label: '容忍抖动', default: false },
                { name: 'mode', type: 'enum', label: '模式', default: 'fast', enum: ['fast', 'full'] },
            ],
        },
    ],
    …
});

const schema = paramsOf(wf);                                  // { schema: ParamEntry[], defaults }
const params = resolveParams(schema, { ci: { command: 'pnpm test' } });
// → { ci: { command: 'pnpm test', targets: ['bilibili'], timeout: 30, flaky: false, mode: 'fast' } }
createRuntime(wf, { registry, params });                      // ctx.params = 上面那个（全量、冻结）
```

| 项 | 规则 |
|---|---|
| 类型全集 | `string` / `number` / `boolean` / `enum` / `list` —— **不支持嵌套对象**（没有表单渲染方案就别开）；`list` 只装标量 |
| 全限定名 | `节点 id.局部名`（`ci.command`）；实例值是同构嵌套 `ctx.params['ci']['command']` |
| `default` | **必填**（一个值都不填也要能跑）⇒ 合并后 `ctx.params` 恒为全量 |
| 约束 | `enum?`（仅 enum，必填非空）/ `min?` `max?` `unit?`（仅 number）；**写错类型即报**（不静默忽略） |
| 值 | 必须**纯 JSON**（标量 / 标量列表、有限数）：类型错 / 越界 / NaN → `invalid-param`；未知节点 / 未知参数名 → `unknown-param` |
| `hint` 插值 | `${局部名}`（本节点）/ `${节点 id.局部名}`（全限定）；**定义期**即校验占位符（拼错 → `invalid-def`，仅在工作流声明了参数时），运行期找不到参数 → `unknown-param`（**不插空串**）；`$$` = 字面量 `$`；空 `list` 插成空串（合法值） |
| 单向导出 | `{ schema, defaults }` 快照供 UI / 文档渲染（`JSON.stringify(paramsOf(def))`）；`defaults` 只是派生视图（真源 = 每项 `default`）；`parseParamsSchema` 读回时守与定义期**同一组**不变量（`name` / `node` 不含 `.`、同 `path` 唯一） |
| 只改值 | 参数**不得增删节点 / 边**；「本次跳过某步」= 参数让 `guard` / 边上的 `when` 短路 |

> 工作流**没声明任何参数**时 `params` 不被校验、原样透传（参数层未启用）：形状封闭的前提是「形状已声明」。

## 转移规则（`createRuntime`）

| 情形 | 结果 |
|---|---|
| 位置为空 | `step` 进入入口节点（`move.kind = 'entry'`） |
| guard 全 `pred:`/`action:` 且**全过** | 走唯一 `next` 出边（`move.kind = 'next'`）；**没有** `next` 出边 → `done`（终态，`state.done = true`） |
| 已 `done` 的状态再 `step` | 直接返回 `done`：**不求值、不重跑 `action:`**（终态记在领域态里） |
| guard 全 `pred:`/`action:` 且**有不过** | 有 `bounce` 出边 → **打回**（也是 `author = 'system'`）；没有 → `stuck`（**停在原位**） |
| guard 含 `prompt:` | `step` → `awaiting-actor`（引擎不替 actor 决定）；只能 `declare` |
| `declare` 走 `next` 边 | 边的条件（`when`）先判（不可用 → `edge-unavailable`）；节点 guard 可观测那部分须全过（否则 `guard-failed`）；`prompt:` 部分由宣布者担责 |
| `declare` 走 `bounce` 边 | 打回不主张推进 → 不设闸门，**连 guard / `when` 求值都不做**（`guard.evaluated === false`） |
| 边上的 `when` | 是**边的条件**（§14.4）——**单出口也照判**，且**系统选边与 actor 宣布两侧共用**；不满足 = 这条边此刻不可用（不是「只有一条就硬走」） |
| 同种出边多条 | 用边上的 `when` 消歧；命中数 > 1 → `ambiguous-edge`；命中 0 → 停/无可用出边 |
| `actor: 'system'` 却带 `prompt:` guard | **组合期**就 `invalid-def`（系统判不了、actor 又不得宣布 = 死锁），不留到运行期静默卡住 |
| `declare` 的 `author` | 必填字符串，且**不得等于内核保留字 `system`**（→ `invalid-declare`） |
| `notify` 抛错 / 回执形状错 | 转移**照样落定**（事实已成立），失败记进 `transition.notifyErrors` |
| 这次转移**没落事件**（`seed.id` 缺省） | 纯领域推进：`transition.event === undefined`、`receipts` 为空（`notify` 依赖事件，无事件 = 无通知） |
| 插件函数自己抛异常 | 统一包成 `FlowError`（`code = plugin-threw`，`cause` 保留原异常） |
| 打回次数超过 `maxBounces` | `bounce-limit`（死循环护栏） |

`guard` **数组 = 与**（用户 2026-10-13 修订）：全部满足才可转移；空数组 = 恒真；
求值**短路** —— 遇到第一个失败即停（`action:` 有副作用，不能在已知前项失败后仍执行它）。

`createRuntime` 的**选项 / 入参形状封闭**：未知字段一律 `invalid-option`（`maxBounces` 少写个 `s`
不再等于「静默关掉死循环护栏」）；`declare` 的入参形状错与 `author` 非法同码（`invalid-declare`）。
`pred:` / `action:` / `notify` 的名字**组合期就查注册表**，错字不必等到「走到那一步」才暴露。

> **装配顺序：先注册齐，再 `createRuntime`。** 组合期扫描要求名字此刻已注册（修前是惰性 resolve，
> 可以「先构造、后注册」）。界线是**内核只校验自己 `resolve` 的槽**：`guard` / `action` / `notify` 查，
> `render` / `source` 的名字**不查** —— 它们的消费者是 ##320 与装配侧，按需注册合理。

### 次序铁律（`action:` 是**写外部世界**的槽）

次序错了就是对外部世界多动手 / 白动手，故三条：

1. **先分类（零副作用），再求值。** `step` 撞上含 `prompt:` 的节点 → 直接 `awaiting-actor`，**一个插件都不调**
   —— 否则 `action:` 会在 `step` 里跑一次、actor 宣布时再跑一次（同一件事做两遍）。
2. **先拒单，再求值。** 非法 `declare`（系统节点 / 冒名 `system` / 边不存在）必须在求值**之前**抛错
   —— 不能先下了单、再告诉调用方「这次调用不允许」。
3. **打回不求值。** 节点 guard 问的是「能不能往前走」；打回不主张推进 → 不问、不跑插件。

> **`step` / `declare` 是状态机驱动，不是幂等 API**：给同一个 `state` 再调一次就再推一次（`seed` 由调用方给新 id）。
> 所以：① `action:` 插件**必须幂等**（同一 `ref` 不重复动手）；② **要轮询「能不能推进」用 `status()`
> （零副作用）**，别反复 `step`；③ 拿到 `done` / `stuck` / `awaiting-actor` 之后不该空转轮询。

## 硬约束

- **泳道 ≡ 节点，1:1**；**打回不新建节点**（只让目标节点再驻留一次）。
- **零 IDE 依赖**：不 import `node:fs` / `electron` / `@diy/app`；**不取时间**（`at` 由调用方传入）⇒ 可重放、可测试。
- **不触外部世界**：插件的副作用全在宿主给的函数体里；`status` 只做静态分类，不调用插件（轮询请用它）。
- **不校验宣布者身份**：`declare` 只拒内核保留字 `system`；「谁能代表哪个 actor」（agent id / human 的映射）是
  **宿主知识**（归 ##319），内核管不了 —— 宿主须自己保证传给 `declare` 的 `author` 可信。
- **`actor` 与 guard 不得矛盾**：`actor: 'system'` 带不可观测 guard（谁推不动）→ 组合期 `invalid-def`。
- 非法定义 / 非法转移 / 未注册插件一律抛 `FlowError`（带 `code` + 点路径 `path`），**绝不静默降级** ——
  打错一个插件名若被当成「永远不通过」，工作流会悄悄偏到另一条路径上。
- **领域状态一等**（##333）：`FlowState` 自成真源、可独立落盘读回；`Event` 是内存里的进度通知 / 落盘后的审计材料，
  **可清可丢**（丢了不影响运行）。`Visit` 里**没有日志 id** —— 关联靠 `ref`（宿主注入）+ 审计侧用 `{ node, seq }` 指回领域。
- 本包只做**内核**：不做事件存储 / 状态文件布局（归 ##319）、参数层落在 `src/params.ts`（**值**从哪来归 ##319，表单长什么样归 ##320）、不渲染（`render` 只给形状，归 ##320）。

## 开发

```bash
cd pkgs.ts/diy-flow
./sha.sh test          # 意图测试（146 例：定义/容器/投影 26 + 槽位/求值/执行器 43 + 参数层 41 + 领域态一等 36）
./sha.sh check         # 本包类型 + lint
# 全仓检查（含产物 / 可执行位护栏）：在仓库根跑 ./sha.sh check
```
