# 状态机：要不要引 xstate、接下来怎么改（结论与顺序）

> 2026-11-29 · ##43 · 输入 = `2026-11-29-state-inventory.md`（7 个真源 / 派生收敛现状）
> + `protocol/delivery.ts`（手写状态图 + 穷举转移测试）+ 用户的三条判断
> （「状态散乱到各处」「测试不够领域化」「不要为不存在的情况造状态」）。

## 一、结论

**不引 xstate。** 用「手写状态图 + 穷举转移测试 + 领域场景测试」这一套已经拿到 xstate
能给的绝大部分收益；剩下的部分（可视化、模型检测）成本高于收益，且当前状态不满足它的前提。

## 二、xstate 能给什么、这里拿不到什么

同一个「投递」状态图，用 xstate（本地参考库 `/Users/ccc/git-ref/xstate`，
`packages/core` = **6.0.0-beta.3**）会写成这样：

```ts
// 仅作对照，不引入依赖
import { createMachine } from 'xstate';

const delivery = createMachine({
    id: 'delivery',
    initial: 'pending',
    states: {
        pending: { on: { claim: 'working', cancel: 'cancelled', fail: 'failed' } },
        working: { on: { complete: 'delivered', cancel: 'cancelled', fail: 'failed', requeue: 'pending' } },
        delivered: { type: 'final' },
        failed: { type: 'final' },
        cancelled: { type: 'final' },
    },
});
```

**它能多给的**：
- `createMachine` 的转移表与我们的 `TRANSITIONS` 是同一份东西（无额外表达力）
- 可视化（Stately 编辑器）—— 我们已经有 ASCII 图贴在同一文件头，够用
- 模型检测 / 路径覆盖 —— `@xstate/test` 已并入 v5+，而我们的穷举测试（5×5 全组合）
  已经等价覆盖了「合法 11 条 + 非法 14 条」

**它给不了的（真正的痛点在这）**：
- **重启后的状态**：投递状态的真源在 sqlite（`deliveries.state`），进程重启要从库里读回。
  xstate 的 actor 活在内存里，持久化要自己接 `getPersistedSnapshot()` + 一个版本兼容层；
  状态一旦在 DB 与 machine 之间分叉，就是多一个真源 —— 正好是我们刚花两刀消灭的那类问题。
- **人机两端共用**：同一套判据要给 Rust/前端用（`deliveryViewOf` 已经被 UI 用）。
  machine 是运行时对象，不是可序列化的契约。
- **与现有 actor 内核的关系**：`RoomActor` / `BotSession` 本来就是 actor 模型（消息驱动 +
  自己的 mailbox/queue）。引 xstate 等于在 actor 之上再套一层 actor，两套调度。

**代价清单**：beta 版本（6.0.0-beta.3）、新增运行时依赖、snapshot 与 DB 的同步层、
以及「两张状态图（`delivery` / `bot`）之外还有 5 个真源没被建模」的事实不会变。

## 三、什么时候该重新考虑

同时满足这三条就值得换：

1. xstate 出稳定版（5.x/6.x GA），且体积与 tree-shaking 符合预期；
2. 状态真源迁到内存投影（DB 只做日志回放），snapshot 持久化不再需要额外一层；
3. 出现第三个、第四个需要状态图的领域（作业 / 压缩 / 审批），手写转移表开始重复。

## 四、分步顺序（含不做的理由）

| 步 | 做什么 | 状态 |
|---|---|---|
| 1 | 投递状态图 + 穷举转移测试（`protocol/delivery.ts`） | ✅ 2026-11-28 |
| 2 | 运行时接上图：取消 ≠ 失败、steer 失败退回队列、删 `keepQueue` 死代码 | ✅ 2026-11-28 |
| 3 | 正文随投递走 + 保留策略（没有它就不能冗余存正文） | ✅ 2026-11-29 |
| 4 | 「没送到」可指出是哪条 + 能重发 | ✅ 2026-11-29 |
| 5 | 领域场景测试：一条消息的一生（`delivery-lifecycle.test.ts`） | ✅ 2026-11-29 |
| 6 | **给 `bot` 也画一张状态图**（现在 `BotRow.state` 是 `server/app.ts` 里的 if 链，四处输入） | 下一步候选 |
| 7 | 「在跑」的三个表达（内存 / 活动流 / 轮询）是否合并成一个投影 | 暂不做 —— 三档各有理由（见清单 §四） |
| 8 | 用 xstate 替换 `RoomActor` / `BotSession` | **不做**，理由见上 |

### 6 为什么值得做（唯一还没被治理的领域）

`BotRow.state` 现在是：

```ts
const state: BotState = running.has(botId) ? 'running'
    : ask !== undefined ? 'asking'
    : turn !== undefined && turn.outcome !== 'done' ? 'needs-attention'
    : 'idle';
```

它自己没问题，问题在于**同一批输入在别处又判了一次**：`rooms.list` 的 `broken` 数的是
「outcome !== done」（**不排除在跑的**，那是有意的，用户 11-26 要求），而 `BotRow.state`
用优先级把在跑排前面。两处都对，但**没有任何地方写清「它们为什么不同」**。
做法：把这条优先级链抽成 `protocol` 的纯函数 `botStateOf({ running, asking, outcome })`，
`broken` 用它的另一档（或显式写成 `botStateOf(...) === 'needs-attention' || running`），
再补一条断言「表格说在跑、侧栏也红」的场景测试（用户 11-26 报过的那条）。

### 7 为什么不现在做

三档「在跑」是**同一真源的快照按新鲜度分档**：内存判活（0ms）、活动流推送（1.5s）、
`rooms.list` 兜底（30s）。合并会把「推送断了时还能不能看到在跑」这条退路砍掉。
真要合并，前提是活动流有「断了就补拉」的保证 —— 那是另一件事，不该顺手做。

## 五、一句话给未来的自己

> 状态的问题从来不是「缺一个状态机库」，而是**同一件事实被几个地方各判一遍**。
> 治理顺序永远是：先让真源唯一 → 再把判据写成可执行的那一份 → 最后才是选不选库。
> 反过来做（先上库），只会把一处重复变成两套运行时。
