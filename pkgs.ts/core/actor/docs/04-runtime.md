# 04 · 执行：队列、幂等、提交、恢复

> 对应源码：`src/runtime.ts`、`src/journal.ts`
> 测试：`tests/intent.runtime.test.ts`

## 一、启动

```ts
const actor = createActor({ kind: roomKind, uri: 'diy://node-a/task/t1', store, port });
await actor.start();               // ← 必须先 start
const detach = actor.attach(link); // 再接链路
```

`start()` 做两件事：

- 有快照 → `#state = snapshot.state`，`#cursor = snapshot.cursor`；
- 没快照 → `kind.initial({ uri, now })` 过 schema，落一份（**冷启动也要落**，否则「空状态」和
  「读不到状态」又混一起了）。

构造期就算一份初始状态（不落盘），所以 `snapshot()` 在 `start()` 之前也能读 —— 别依赖这个。

## 二、入口：只有一条队列

```ts
#intake(frame, link) {
    if (frame.type === 'cmd')   return void this.#enqueue(() => this.#handleCmd(frame, link));
    if (frame.type === 'query') return void this.#enqueue(() => this.#handleQuery(frame, link));
    // 出向帧打到 actor = 协议违规
    link.send({ type: 'err', id: frame.id, code: 'E_INVALID_ARGUMENT', message: `actor 不接受 ${frame.type} 帧` });
}
```

- 回执发回**发起请求的那条 link**（多客户端时不能广播）；
- `event` 帧**广播**给所有 link（订阅者各自过滤）；
- 单元抛错不污染队列：`#enqueue` 的 `tail` 用 `then(fn, fn)` 接（[01](./01-model.md) §一）。

## 三、命令的执行路径

```
① 查声明：没有 → rejected E_UNKNOWN_METHOD
② 查幂等表：
     done    → 原样回 done（data / seq 是上次的）
     running → 回 accepted（别让调用方重复提交）
     failed  → 回 err（同一份入参重试没意义；要改就换新 commandId）
③ zod 校验 data：不符 → rejected E_INVALID_ARGUMENT + issues（**不写幂等表**，修正后可复用 id）
④ 记为 running；deferred 模式建长活簿
⑤ handler(ctx, input)
⑥ 原子提交（见 §四）
⑦ sync → done；deferred → accepted
```

任何一步抛错：幂等表记 `failed`，回 `err`（带 `retryable`），**状态与事件整批不认**。

## 四、原子提交

```ts
#commit({ state?, events? }, commandId?) {
    ① 事件过 schema（`$` 走 runtime 自己的），逐条带 at + commandId
    ② store.append(events)      → 拿到 seq（最后一条即新游标）
    ③ store.save({ state, cursor })
    ④ 更新内存 #state / #cursor
    ⑤ 广播事件给所有 link
}
```

顺序的理由见 [01](./01-model.md) §四。要点：

- **事件可以单独提交**（只要事件不要状态变化，比如 `$fault`）；
- **状态可以单独提交**（不产生事件的状态变化是允许的，但不推荐 —— 断线重连的补历史只能靠事件）；
- `kind.state.parse()` 在每次提交时都跑（schema 是契约，不是装饰）。

## 五、幂等

| 事实 | 结论 |
|---|---|
| `commandId` 由**调用方**生成并持有 | 重试只需重发同一帧，不依赖服务端会话 |
| 幂等表是内存 Map | actor 重启后清空 → 重启窗口内的重发会**再执行一次**。要跨重启幂等，必须把 `commandId` 落进 store（[08](./08-roadmap.md)） |
| `rejected` 不写幂等表 | 入参可以修正，同一个 id 允许再来一次 |
| `query` 没有幂等键 | 它本来就可以重发（读操作天然幂等） |

`tests/intent.runtime.test.ts` 的第二组用例守这两条：同一个 `commandId` 发两次 → 状态只 +1、
第二次回的是**同一个 seq**；换新 `commandId` → 真的执行两次。

## 六、长活与 `$command.finished`

| 事件 | data | 何时 |
|---|---|---|
| `$command.finished` | `{ commandId, ok, code?, message?, output? }` | `deferred` 命令的后续单元全部跑完 |
| `$fault` | `{ commandId, code, message }` | 某个后续单元失败（fire-and-forget 不能静默） |

`deferred` 命令的调用方拿结果有两条路：

```ts
// 甲：等事件（在线）
for await (const e of client.watch({ include: ['$command.finished'] })) { ... }

// 乙：冷补（重开页面 / 换设备）
await client.commandStatus(commandId);   // → { status: 'running' | 'done' | 'failed', output? }
```

`$command.status` 的三种来源：内存幂等表（本进程）/ store 里的 `$command.finished`（跨重启，roadmap）
/ `unknown`（都没有 —— 此时**别猜**，重新发起一次命令，让幂等表回答）。

## 七、`$events` 与恢复

```
崩溃后重启：load 快照（state + cursor）→ 从 cursor 之后读日志 → 补投影 / 补订阅
```

本包的 `store` 由此只有四个方法（[journal.ts](../src/journal.ts)）：

| 方法 | 语义 |
|---|---|
| `load()` | 读快照（state + cursor），没有返回 `null` |
| `save(snapshot)` | 整份落盘（与 `append` 同事务） |
| `append(entries)` | 追加事件，**返回带 seq 的条目** |
| `read(after, opts)` | 从 `after` 之后读，可按 `include` / `limit` 过滤 |

**没有 `update` / `delete`**：日志只追加。这是 `watch({ after })` 能补历史和「重开页面看到同一份答案」的前提。

游标约定：内置内存 store 用 `e<十进制>`（`e1`、`e2`…），比较走 `compareCursor`。
接别的 store（sqlite 序列号等）要保证同前缀 + 单调，否则 `$events` 的 `after` 会错。

## 八、没有实现的东西（故意的）

| 没做 | 现在怎么办 | 什么时候做 |
|---|---|---|
| 取消在途命令 | handler 自己看 `AbortSignal`（`E_CANCELLED` 码已预留） | 出现「用户点了停止」的真实需求时 |
| 并发 worker（一个 actor 多写者） | 不要 —— 那正是这套东西要消灭的 | 永不 |
| 跨重启幂等 | 接受「重启窗口内可能重放一次」 | store 里加 `commandId` 表 |
| 定时器 / 周期性任务 | 外部驱动（`job` 注册表那一套） | 不归 actor |
| 权限 | 传输层 / kind 自己判（`E_PERMISSION` 已预留） | 出现多用户时 |

## 九、判据

1. 只有 `#commit` 改 `#state`（`rg "#state =" src/runtime.ts` 只应出现在 `#commit` 和 `start`）。
2. 每个 `rejected` 都发生在 handler 之前（`rg -A2 "safeParse" src/runtime.ts` 里没有 handler 调用）。
3. 同一 `commandId` 重发 → 同一个 `seq`（有用例）。
4. `defer` 的单元失败必有 `$fault` + `$command.finished{ok:false}`（有用例）。
5. 重启后从快照 + 日志能重建同一份状态（`store` 实现方的验收项，见 [08](./08-roadmap.md)）。
