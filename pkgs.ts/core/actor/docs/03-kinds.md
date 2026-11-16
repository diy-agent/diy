# 03 · 声明：一个 kind 会什么

> 对应源码：`src/kinds.ts`（`defineKind` / `KindBuilder`）
> 测试：`tests/support/fixtures.ts`（文档里所有 kind 示例的真实版本）

## 一、为什么是声明

不做「注册一堆 handler」，是因为 runtime 必须**在调用发生前**知道三件事：

1. 怎么校验 `data`（哪个 zod schema）；
2. 哪些方法是写（走队列 / 幂等 / 失重放），哪些是读（可扇出）；
3. 事件名的封闭集合（journal 记录要能按名字筛，`watch({ include })` 才能成立）。

声明还有个副作用：**调用方的类型是从声明推出来的**（`CmdInput` / `QueryOutput`），
所以「服务端改字段、客户端忘改」编译期就红。

## 二、骨架

```ts
const counter = defineKind({
    name: 'demo.counter',                        // 域.实体，用于日志与 journal 记录
    state: z.object({ n: z.number().int() }),    // 状态 schema：initial 产物 / 新 state / 快照都过它
    initial: () => ({ n: 0 }),                   // 冷启动（seed 带 uri + now）
    events: {                                    // 事件名 → schema（封闭集合）
        added: z.object({ by: z.number().int(), n: z.number().int() }),
    },
})
    .command('add', { input, output, mode? }, handler)
    .query('get', { input, output }, resolve)
    .fanoutQuery('roster', { input, output, subquery, targets, aggregate })
    .build();
```

链式构建是为了**零注解**：`ctx.state`、`input`、返回值都从 schema 推，不用写泛型实参，
也不用记 `RoomState` 这类类型名。

## 三、命令：改状态 = 返回新 state

```ts
.command('add',
    { input: z.object({ by: z.number().int() }), output: z.object({ n: z.number().int() }) },
    (ctx, input) => {
        const n = ctx.state.n + input.by;
        return {
            output: { n },                                        // 回给调用方（done.data）
            state: { n },                                         // 新状态（不写 = 不变）
            events: [{ name: 'added', data: { by: input.by, n } }],// 一起提交
        };
    })
```

**为什么副作用是返回值，不是在 ctx 上 `setState()`**：

- runtime 能在一次提交里原子地「追加事件 → 落快照 → 推进游标」，失败了整批丢弃 ——
  状态和事件不会打架；
- handler 变成可测的纯函数（给定 state + input，出 effects）；
- `ctx.state` 只读，没有「我读到的到底是改之前还是改之后」这种问题。

`CommandResult` 的三个字段都是可选的：只读命令就只返回 `output`；不改状态就省 `state`。

## 四、两种命令模式

| `mode` | 回执 | 什么时候用 |
|---|---|---|
| `'sync'`（缺省） | `done { data, seq }` | 绝大多数写操作（handler 在队列内跑完） |
| `'deferred'` | `accepted { at }`，收尾发 `$command.finished` | 长活：spawn 会话、拉模型、等外部进程 |

`deferred` 的 handler **只负责受理**，真正的工作用 `ctx.defer(fn)` 排到队尾：

```ts
.command('slowAdd', { input, output, mode: 'deferred' }, (ctx, input) => {
    ctx.defer(async (inner) => {
        const n = inner.state.n + input.by;
        return { state: { n }, events: [{ name: 'added', data: { by: input.by, n } }] };
    });
    return { output: { accepted: true } };
})
```

`mode` 在类型上是**字面量**（不是宽化成 `'sync' | 'deferred'`）：调用方那层据此算返回类型 ——
`sync` 拿 output，`deferred` 只拿 `{ accepted: true, at }`（真结果在事件里）。见 [06](./06-transport.md) §四。

⚠️ **不要 `await ctx.defer(...)`**：队列是串行的，在队列内等队列 = 自锁。所以 `defer` 返回 `void`。
后续单元失败 → 落 `$fault`，`$command.finished` 带 `ok: false`（[04](./04-runtime.md) §六）。

## 五、查询：两种实现，一个语义

### 本地答（projection）

```ts
.query('get', { input: z.object({}), output: z.object({ n: z.number().int() }) }, (ctx) => ({ n: ctx.state.n }))
```

`resolve` 是**同步世界里的纯投影**：读当前已提交的 state，不写、不 await 外部 IO（要 IO 就说明它不是查询）。

### 多目标扇出

```ts
.fanoutQuery('roster', {
    input: z.object({}),
    output: z.object({ members: z.array(z.object({
        memberId: z.string(),
        state: z.enum(['running', 'idle', 'unknown']),   // ← 三态：读不到有它自己的值
        label: z.string().optional(),
        reason: z.string().optional(),                    // ← unknown 的原因
    })) }),
    subquery: 'live',                                     // 在 target 上执行的方法名
    targets: (ctx) => ctx.state.members.map((m) => ({ target: m.target, memberId: m.memberId })),
    aggregate: ({ ctx, results }) => ({ /* 逐项折成业务答案 */ }),
})
```

**三件必须记住的事**（细节见 [05](./05-multi-target.md)）：

1. `targets` 从 **state** 算 —— 摆放知识只属于 actor，调用方不许指定；
2. `aggregate` 拿到的 `results` **每个 target 都有一项**，没拿到的是 `answered: false` + `code`；
3. **不存在的状态要在 `output` schema 里显式表示**（`state: 'unknown'` + `reason`）。
   用 `null` 表示「读不到」= 把未知说成没有 = [07](./07-naming-ledger.md) A2 那个 bug。

## 六、事件

- 事件名是**封闭集合**：`events` 里没声明 → 提交时抛 `E_UNKNOWN_METHOD`（kind 的 bug 立刻可见）；
- 事件 `data` 也过 schema（不是「反正内部用」）；
- 事件与状态**一起提交**，`seq` 由 store 分配，单调；
- `$` 开头是 runtime 保留（`$command.finished` / `$fault`），kind 不许占。

事件是**给外面看的形状**：`watch` 的订阅者、journal 的读者、断线重连的补历史，都靠它。
所以事件的 `data` 要能自解释（带足够 id），不要只发 `{ ok: true }` 这种。

## 七、命名纪律（会被 review 拦下的）

| 规则 | 理由 |
|---|---|
| 命令名用动词（`post` / `join` / `compact`），查询名用名词视角（`get` / `roster` / `resolve`） | 读代码的人能一眼分出写和读 |
| 一个成员只有一个稳定身份 `memberId`；显示名 `memberName`；会话地址 `memberUri` | [07](./07-naming-ledger.md) B1 |
| 入参指代房间时叫 `room`（值可以是 taskUri），**不要**叫 `id` | 与帧外层 `id` 撞名（A1） |
| `data` **内部**允许业务自己的 `type`（块树 `{type:"text"}`） | 那是业务词汇，不是帧词汇（A3） |
| 不用 `payload`、不用 `k`、不用 `q` | 旧名一律不兼容（C1 / C2） |

## 八、判据

1. `state` / 每条 `input` / 每条 `output` / 每个事件都有 zod schema（`rg "z.object"` 覆盖全部方法）。
2. handler 里没有 `this`、没有闭包持有的可变外部状态（要外部 IO → 它就不该是 handler 的一部分）。
3. `ctx.defer` 的调用点没有 `await`（`rg "await ctx.defer"` = 0）。
4. 所有「可能读不到」的业务状态都在 `output` schema 里有独立取值，**没有**用 `null` 兼职。
5. `defineKind` 里没有 `$` 开头的名字（构建期会抛）。

## 九、类型是怎么推出来的（两处易碎点）

调用方那层（[06](./06-transport.md) §四 `useKind`）能写 `await counter.add({ by: 2 })` 直接得 `{ n: 2 }`，
靠的是 `Kind` 上带着**每条方法的 schema 类型**。有两处一改就会悄悄退化成「看着有类型、其实什么都没校验」：

| 易碎点 | 坏掉的症状 | 现在怎么做 |
|---|---|---|
| `CommandDef` / `QueryDef` 存的是 **schema 本身**（`In extends z.ZodType`） | 存成 `z.ZodType<O>`（只留输出类型）时，`z.input<...>` 只能给 `unknown` —— 入参怎么写都不报错 | 声明里存 schema，入参/出参各自 `z.input` / `z.output` |
| `KindBuilder` 的初始类型参数是 **`{}`**，不是 `Record<string, never>` | 后者带字符串索引签名 → `keyof C` 变 `string` → `CmdNames` 退化成 `string`（拼错名字不报错）、`CmdInput` 退化成 `unknown` | 起点 `{}`，链上一层层长成 `{ add: … } & { get: … }` |

两处都是「编译不报错、运行时才炸」的类型退化，所以用 `@ts-expect-error` 钉在
`tests/api.test.ts`（拼错名字、写错字段，raw 层同样校验）。**判据**：
`npx tsc --noEmit -p pkgs.ts/core/actor` 若报「Unused '@ts-expect-error' directive」，
说明那几行又能编译了 —— 也就是类型退化回来了。
