# 01 · 模型：一个实例 = 一个 actor

> 对应源码：`src/runtime.ts`（`#enqueue` / `#commit`）、`src/journal.ts`

## 一、一句话

> **所有会改变状态的操作，排成一条队列，一次跑一个。**

Go 的做法是「单协程 + channel」（`for f := range ch { f() }`），TS 没有 goroutine，但单线程事件循环 +
promise 链表达的是同一件事：每个工作单元挂到队尾，严格按提交顺序执行。

```ts
#tail: Promise<unknown> = Promise.resolve();

#enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);        // 前一个失败也要继续（失败不污染队列）
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
}
```

于是 `#state` **只被队列里的工作单元读写** —— 全文件零锁、零原子操作、零重试。

## 二、为什么必须顺序

因为「读—改—写」不是原子的。两个操作并行时会交错读（上文 `bots.json` 那段）。

粒度很重要：**整段「读—改—写」是同一个工作单元**。

```ts
// ❌ 错：读和写之间别的操作可以插进来
const base = ctx.state.n;
const next = base + 1;
await something();
return { state: { n: next } };

// ✅ 对：读、算、提交都在同一个 handler 里（handler 本身就是一个工作单元）
return { state: { n: ctx.state.n + 1 } };
```

`tests/intent.runtime.test.ts` 的第一条用例就是这条：20 个并发 `add`，handler 中间故意
`await tick()` 让出事件循环，最终必须是 `n = 20`。删掉队列，这条会变成 `n = 1`。

## 三、读也排队

查询不必互斥，但**必须**看到一致的快照。如果查询绕过队列，它会读到「handler 已经读了 base、
还没提交」的中间态 —— 而这正是 actor 要消灭的东西。

所以 `#intake` 对 `cmd` 和 `query` 一视同仁地 `#enqueue`。

代价：一条慢查询会挡住后续命令。这是**刻意的取舍**（正确性优先），对策是 [四](#四长任务怎么办)
的分叉，而不是让查询插队。

## 四、状态与事件：一起提交

一次成功命令的收尾是原子的三步（`#commit`）：

```
① store.append(事件)              → 分配 seq（游标）
② store.save({ state, cursor })   → 快照 + 游标
③ 广播事件给所有 link
```

顺序不能反：

- 先落快照后追加事件 ⇒ 崩在中间会**丢事件**（状态已经是新的，历史里没有那一步）；
- 事件里不带 `commandId` ⇒ 无法把 `$command.finished` 关联回命令。

任何一步抛错就整批不认，回 `err`（[04](./04-runtime.md) §三）。真实 store（jsonl / sqlite）
把 ①② 塞进同一个事务；内存实现顺序执行即可。

## 五、长任务怎么办

长任务不能「因为慢就跳出队列」—— 那会让「读—改—写」的假设失效。两种做法：

**甲、把长活切成「受理 + 后续单元」**（本包的做法）

```ts
.command('slowAdd', { input, output, mode: 'deferred' }, (ctx, input) => {
    ctx.defer(async (inner) => {                 // 排到队尾，不阻塞当前单元
        const n = inner.state.n + input.by;
        return { state: { n }, events: [{ name: 'added', data: { by: input.by, n } }] };
    });
    return { output: { accepted: true } };       // 立刻回 accepted
})
```

三条规则：

1. **不要 `await ctx.defer(...)`** —— 队列是串行的，在队列内等队列 = 自锁。`defer` 返回 `void` 就是防这个。
2. `defer` 的单元照样在队列上跑，所以读到的 `state` 仍然一致；它可以再 `defer`（链式）。
3. 后续单元失败不会被吞：落 `$fault` 事件，`$command.finished` 带 `ok: false`（[04](./04-runtime.md) §六）。

**乙、状态机而不是锁**（diy 现有做法）

长活状态写在 store 里（`running` / `done` / `failed`），UI 通过 `watch` 或轮询看到变化。
`job` 注册表（`##408`）就是这个形态，actor 只负责「状态变化那一步的写入是串行的」。

## 六、跨实例的边界

**单实例串行 ≠ 全局串行。** 多个 app 实例（diy-app + apps/chat + dev app）各有各的 actor，互不阻塞。

| 场景 | 做法 |
|---|---|
| 同一个 actor 的多个调用方 | 一条队列（本包） |
| 多个 actor 要一起读 | 扇出读（[05](./05-multi-target.md)），**不跨节点写** |
| 不同 app 共享数据 | **不要共享** —— 各用各的 `DIY_HOME` |
| 确实要共享（实例注册表） | 只读不写，或写方只有一个 actor |

推论：**不存在「跨节点事务」**。一次操作要动两个节点上的状态 = 两次命令 + 一个补偿策略，
这个策略属于业务（kind），协议不提供。

## 七、UI 持有什么

UI **不持有业务状态**，只持有**显示状态**：

```ts
let snapshot: ViewModel | null = null;
async function refresh() {
    const got = await client.query('room', { room });   // 每次从 actor 拿
    if (!got.ok) return renderError(got);               // 失败要显示，不要假装成功
    snapshot = project(got.data);                       // 纯投影
    render();
}
```

**每次操作后重新拿**，不在 UI 里增量改（`snapshot.members.push(...)` 这种）。理由：
增量改容易和真实状态不一致；快照本来就是 actor 算好的，重新拿一次很便宜。

## 八、判据

1. 写路径里没有一把锁、没有一次 `await` 跨出 handler 后再改状态（长活必须走 `defer`）。
2. `tests/intent.runtime.test.ts` 的并发用例必须绿（20 并发 == 20 次生效）。
3. UI 代码里 `rg 'readFile|writeFile|fs\.' apps/*/renderer*` = 0。
4. 一个操作要么整批提交（状态 + 事件），要么整批不认 —— 没有「状态变了事件没落」。
5. 跨节点只读不写：`rg 'port.*cmd' ` 无命中（扇出端口只有 `query`，见 [05](./05-multi-target.md)）。
