# 06 · 链路与调用方

> 对应源码：`src/transport.ts`（Link / 进程内 / frameLink）、`src/client.ts`（facade）、`src/local.ts`

## 一、链路只有两个方向

```ts
interface Link {
    send(frame: Frame): void;
    onFrame(handler: (frame: Frame) => void): () => void;
}
```

就这样。**为什么这么小**：谁连谁、断线重连、鉴权、多路复用、压缩，都不是 actor 的事。
actor 只要求三件事成立：帧到得了、回执回得去、事件推得出。

`send` 是**同步返回**的（可能内部排队），所以调用方不能靠 `await send` 判断送达 ——
送达的统一回答方式是回执 / 超时。

## 二、进程内

```ts
const pair = createInProcessPair();          // { caller, actor }
await actor.start();
actor.attach(pair.actor);
const client = createClient({ link: pair.caller, kind });
```

内部用 `queueMicrotask` 投递，**故意不直投**：真链路不会在 `send()` 里就跑对面的处理逻辑，
同步直投会把「重入 / 队列自锁」这类 bug 藏起来，等上真链路才炸。

`createLocalActor({ kind, uri, … })` 就是上面三步的封装（测试和文档示例都用它）。

## 三、接 ws / http / electron / stdio（**不依赖 `@diy-agent/rpc`**）

适配器只搬字符串：

```ts
// 适配器侧（在别的包里，比如 @diy-agent/rpc 或某个 serve 进程）
const link = frameLink({
    send: (text) => socket.send(text),
    onText: (handler) => { socket.on('message', handler); return () => socket.off('message', handler); },
});
actor.attach(link);
```

`frameLink` 干两件事：`encodeFrame` / `decodeFrame`，外加**坏帧丢弃**（丢在链路层，不往业务层传）。
一条坏帧不该让整个连接进入未定义状态。

接 `@diy-agent/rpc` 的正确方向是「rpc 里写一个 actor 桥」，不是 actor 依赖 rpc。
判据：`rg "@diy-agent/rpc" pkgs.ts/core/actor` = 0。

## 四、调用方 facade

```ts
const client = createClient({ link, kind: roomKind, timeoutMs: 30_000 });

const done = await client.cmd('post', { room, text: 'hi' });          // 写
const got  = await client.query('roster', { room });                  // 读
for await (const e of client.watch({ after: cursor, include: ['posted'] })) { … }
```

### 返回值：`Outcome` 判别联合，不抛异常

```ts
type QueryOutcome<T> =
    | { ok: true; data: T; watermark: Cursor; stale: boolean; meta?: Meta }
    | { ok: false; code: ActorCode; message: string; retryable: boolean };

type CmdOutcome<T> =
    | { ok: true; accepted: false; data: T; seq: Cursor }      // 跑完了
    | { ok: true; accepted: true;  at: Cursor }                 // 受理了，结果等 $command.finished
    | { ok: false; code: ActorCode; message: string; retryable: boolean };
```

**为什么不用 throw**：一个 try/catch 会把「参数非法」「节点掉线」「业务里没有这条」全兜成同一坨，
调用方最后只能显示「出错了」。判别联合强制每个分支都被处理，UI 才可能显示准确的话。

要抛的地方只有一个：`expect(outcome)`（在你确实要 throw 的边界用）。

### 三个容易写错的点

| 坑 | 正确做法 |
|---|---|
| 重试时换了新 `commandId` | 重试**必须**复用同一个 `commandId`，否则会写两次（[04](./04-runtime.md) §五） |
| 超时后把迟到的回执当新请求 | `#receive` 按 `id` 精确匹配，匹配不上就丢弃（不会误配） |
| 用 `break` 结束 `watch` | JS 的 async generator 没有外部取消；要真中断就传 `signal`（[八](#八watch-的两个坑)） |

## 五、重试

```ts
const commandId = newCommandId();                 // ← 调用方持有
for (;;) {
    const out = await client.cmd('post', input, { commandId });
    if (out.ok) break;
    if (!out.retryable) throw new ActorError(out.code, out.message);
    await sleep(backoff());
}
```

三种可重试的回执：

| 回执 | 重发同一帧的结果 |
|---|---|
| `err` 且 `retryable: true`（网络 / 超时 / 冲突） | 幂等表回答：`done` → 原样回；`running` → `accepted` |
| 客户端本地超时（`E_TIMEOUT`，帧可能已送达） | 同上 —— **这正是 `commandId` 存在的理由** |
| `rejected` | 修正入参后可用同一个 `commandId`（rejected 不写幂等表） |

## 六、一致性（read-your-writes）

CLI 里 `diy room focus … && diy room get …` 是两个进程，第二个很可能打到还没追平的投影。

```ts
await client.query('room', { room }, { consistency: 'owner' });
```

- 取值由 actor 的声明定**下限**，调用方只能升不能降；
- 当前 runtime 就是 owner，`stale` 恒 `false`；出现「远端投影 + 本地读」时才真正生效（[08](./08-roadmap.md)）。

## 七、`watch` 的语义

```
① 订阅实时（先订阅，避免竞态漏事件）
② $events 补历史（after = 你上次读到的 cursor）
③ 历史逐条吐；实时按 seq 去重、按 include 过滤
```

要点：

- 同一个 `seq` 只出一次（历史与实时必然重叠，重叠窗口就是订阅到补历史之间）；
- `after` 缺省是 `CURSOR_ZERO`（**全量**）—— 对长历史的 actor，业务应该自己存 cursor 并传进来
  （B2：[07](./07-naming-ledger.md) 里 `lastSeen` → `cursor` 就是这个）；
- `include` 的名字是 `cmd` / `query` 之外的第三类名字（事件名，`$` 与业务同一个空间）。

## 八、`watch` 的两个坑

1. **`break` 不会真正中断**：生成器停在 `await` 上，`finally` 要等它被恢复才跑。
   要能打断就传 `signal`（每轮循环检查 + abort 唤醒），或者外面套 `takeUntil`。
2. **不要在 `watch` 循环里 `await cmd`**：它能跑（不会自锁，watch 不在队列上），但一条慢命令会让
   事件积压在链路缓冲里。要「按事件触发命令」，让命令在另一个异步任务里跑。

## 九、判据

1. `rg "@diy-agent/rpc|from 'node:" pkgs.ts/core/actor/src` = 0（本包不依赖 rpc、不碰 IO）。
2. 适配器里没有业务词汇（`rg "room|member" pkgs.ts/core/actor/src/transport.ts` = 0）。
3. 调用方的每个 `client.cmd/query` 都处理了 `ok:false`（`rg "await client\.(cmd|query)" -A3` 逐处看）。
4. 重试路径复用了 `commandId`；`watch` 的 `after` 来自持久化的 cursor，不是 `CURSOR_ZERO`。
