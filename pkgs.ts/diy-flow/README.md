# @diy/flow

diy **工作流内核**：工作流定义 DSL + 泳道容器（单指针 / 打回）+ 插件槽 + guard 求值 + 转移执行器 + 轨迹折线投影。
纯内核（仅依赖 `@diy/talk` 的事件原语）：不认识文件系统、**不触外部世界**（插件副作用全在宿主给的函数体里）、
**不取时间**（事件的 `at` 由调用方传入）。

一句话概括它解决的问题：一条工作流 = 泳道图上的一条折线 —— 状态自上而下在泳道间变迁，打回时
从 from 画线回 to，最终形成完整行为路径（如 `A→B→C→B→D`）。**泳道 ≡ 节点（1:1）**，打回**不新建节点**
（只是轨迹再次穿过同一条泳道）。依据 ##311 §一 与 ##166 §14.2/§14.4。

**同一条泳道图里，流水线行为与聊天室行为共存**（##166 §10.3）—— 分水岭是 **guard 可不可观测**：

| guard 引用 | 可观测？ | 谁推 | 落下的那条 Event |
|---|---|---|---|
| `pred:名` | ✅ 引擎自己能判 | **系统**（自动转移） | `author = 'system'` |
| `action:名` | ✅（且是**写**外部世界） | **系统**（自动转移） | `author = 'system'` |
| `prompt:名` | ❌ 只是一段提示词 | **actor 自己宣布** | `author = 宣布者`（转移本身就是一条发言） |

## 快速开始

```ts
import { createRegistry, createRuntime, defineWorkflow, initialState, project } from '@diy/flow';

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

const rt = createRuntime(wf, { registry: createRegistry(), maxBounces: 3 });
const at = '2026-10-13T00:00:00.000Z';
const seed = (id: string) => ({ id, at });

const events = [];
let state = initialState<'implement' | 'review'>();

const enter = rt.step(state, seed('e1'));            // 进入入口 → author = 'system'
if (enter.status !== 'moved') throw new Error(enter.status);
state = enter.transition.state;
events.push(enter.transition.event);

const probe = rt.step(state, seed('e2'));            // ★ implement 是 `prompt:` 节点
probe.status;                                        // → 'awaiting-actor'（引擎判不了，不替它决定）

// 转移由 actor 宣布 —— 宣布本身就是一条 Event
const toReview = rt.declare(state, { ...seed('e2'), author: '开发 agent', to: 'review', content: '开发完成，提交 Review' });
const bounced = rt.declare(toReview.state, { ...seed('e3'), author: 'Review agent', to: 'implement', content: 'P0 未落点 → 打回' });
events.push(toReview.event, bounced.event);

project(events, wf).path.map((v) => `${v.node}#${v.seq}:${v.kind}`);
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

const a = rt2.step(initialState<'ci' | 'merge'>(), seed('e1'));   // 进入入口 ci
if (a.status === 'moved') {
    const b = rt2.step(a.transition.state, seed('e2'));
    if (b.status === 'moved') {
        b.transition.event.author;   // 'system'
        b.transition.event.content;  // '系统求值通过（pred:check_green ✓, pred:intent_green ✓）→ merge'
    }
    // 若某条 pred 不过：没有 bounce 边 → b.status === 'stuck'（「卡住」在**边上**，##101 结论四）
}
```

## 导出

| 导出 | 是什么 |
|---|---|
| `defineWorkflow(def)` | 定义工作流：`nodes[]`（泳道） + `edges[]`（转移）；`edges[].from/to` 只能取节点 id（编译期护栏） |
| `createContainer(def).apply(event)` | 单指针容器：`apply` 返回新容器（不可变），位置唯一推进；打回 = 走 `bounce` 边 |
| `createRuntime(def, opts)` | 转移执行器：`step`（系统自动推）/ `declare`（actor 宣布）/ `status`（现在轮到谁） |
| `createRegistry()` | 插件注册表：`register(slot, name, fn)` / `resolve(slot, name)`（未注册即报错） |
| `evaluateGuards` / `classifyGuards` / `unevaluatedGuards` / `parseGuardRef` / `selectEdge` | guard 求值（与 + 短路）与出口消歧（`when` 单出口也判），可单独复用 |
| `project(events, def)` | 折线投影（纯函数）：`{ currentNode, path: Visit[], visits }` |

`Event` 复用 `@diy/talk` 原语：`{ id, author, anchor, content, causes, at }`，其中 `anchor = { type: 'node', data: { nodeId } }`。

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

## 转移规则（`createRuntime`）

| 情形 | 结果 |
|---|---|
| 位置为空 | `step` 进入入口节点（`author = 'system'`） |
| guard 全 `pred:`/`action:` 且**全过** | 走唯一 `next` 出边，落 `author = 'system'` 的 Event；**没有** `next` 出边 → `done`（终态） |
| guard 全 `pred:`/`action:` 且**有不过** | 有 `bounce` 出边 → **打回**（也是 `author = 'system'`）；没有 → `stuck`（**停在原位**） |
| guard 含 `prompt:` | `step` → `awaiting-actor`（引擎不替 actor 决定）；只能 `declare` |
| `declare` 走 `next` 边 | 可观测那部分须全过（否则 `guard-failed`）；`prompt:` 部分由宣布者担责 |
| `declare` 走 `bounce` 边 | 打回不主张推进 → 不设闸门，**连 guard 求值都不做**（`guard.evaluated === false`） |
| 边上的 `when` | 是**边的条件**（§14.4）——**单出口也照判**；不满足 = 这条边此刻不可用（不是「只有一条就硬走」） |
| 同种出边多条 | 用边上的 `when` 消歧；命中数 > 1 → `ambiguous-edge`；命中 0 → 停/无可用出边 |
| `declare` 的 `author` | 必填字符串，且**不得等于内核保留字 `system`**（→ `invalid-declare`） |
| `notify` 抛错 / 回执形状错 | 转移**照样落定**（事实已成立），失败记进 `transition.notifyErrors` |
| 插件函数自己抛异常 | 统一包成 `FlowError`（`code = plugin-threw`，`cause` 保留原异常） |
| 打回次数超过 `maxBounces` | `bounce-limit`（死循环护栏） |

`guard` **数组 = 与**（用户 2026-10-13 修订）：全部满足才可转移；空数组 = 恒真；
求值**短路** —— 遇到第一个失败即停（`action:` 有副作用，不能在已知前项失败后仍执行它）。

`createRuntime` 的**选项 / 入参形状封闭**：未知字段一律 `invalid-option`（`maxBounces` 少写个 `s`
不再等于「静默关掉死循环护栏」）；`pred:` / `action:` / `notify` 的名字**组合期就查注册表**，
错字不必等到「走到那一步」才暴露。

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
- 非法定义 / 非法转移 / 未注册插件一律抛 `FlowError`（带 `code` + 点路径 `path`），**绝不静默降级** ——
  打错一个插件名若被当成「永远不通过」，工作流会悄悄偏到另一条路径上。
- 本包只做**内核**：不做事件存储（归 ##319）、不校验 `params`（只透传 —— 交给插件的是**冻结的浅副本**，归 ##316）、不渲染（`render` 只给形状，归 ##320）。

## 开发

```bash
cd pkgs.ts/diy-flow
./sha.sh test          # 意图测试（66 例：定义/容器/投影 26 + 槽位/求值/执行器 40）
./sha.sh check         # 本包类型 + lint
# 全仓检查（含产物 / 可执行位护栏）：在仓库根跑 ./sha.sh check
```
