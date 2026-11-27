# @diy-agent/actor

**一个 actor = 一份私有状态 + 一条串行链 + 一张方法表。`src/index.ts` 184 行，零依赖，零网络代码。**

这里没有：幂等表、游标、快照格式、多目标扇出、生命周期树、状态机。
那些只有「要持久化」时才出现，谁需要谁在外面加（`examples/05` 加十几行）。

跨进程也不在这里 —— 而且**不该在这里**。actor 不知道自己在第几个进程里；
需要让另一头也能操作它，就把调用换成帧，那层是宿主的事：

```ts
// 业务本体一字不改，用 @diy-agent/rpc 桥进来（examples/06-rpc-bridge）
mountService(server, {
    prefix: 'room',
    api: roomApi,
    handlers: {
        slow: ({ input, signal }) => room.$call('slow', [input.args[0]], { signal }),
    },
});
```

关于「为什么不自带网络层」的完整判断，见 [`docs/bridging-rpc.md`](./docs/bridging-rpc.md)。

## 状态

**开发暂停（2026-11-17）。** 内核 + `cmd` 子路径都已完成、八个范例全绿，但**仓库里还没有使用者**：
唯一完整的候选（diy2 的实体对话）评估后决定不迁 —— 它要解决的「多写者竞争 + 位置透明」
在那个功能上都不存在，理由与证据见 [`docs/plans/2026-11-17-room-as-actor.md`](../../../../docs/plans/2026-11-17-room-as-actor.md)。

等真的有第二个进程同时写同一份状态、或者需要按 command log 重放时再来接。
在那之前，改动只做「修 bug + 补范例」，不再扩设计。

链条外的活不会自己停，这是这个包最容易踩的一条：

| 你以为是 `close()` 管的         | 实际上归谁                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------- |
| 一链执行体的 abort              | 归链：`actor()` 收尾时 abort `life.signal`                                   |
| 链外的 LLM 轮次 / 定时器 / 订阅 | **归你**：必须从 `life.signal` 派生（`AbortSignal.any([life.signal, own])`） |
| 排队排到一半的工作单元          | 归链：`close()` 会排空（见 04）                                              |
| 已经发出去的帧                  | 归宿主：`close()` 不会通知对面                                               |

## 跑

```bash
./sha.sh all        # 八个范例，一次跑完
./sha.sh e03        # 只跑第三个
./sha.sh check      # 类型 + lint
```

## 内核就三件

```ts
import { serial, actor } from '@diy-agent/actor';

// 1. 串行链：所有工作单元排在同一条 promise 链尾
const chain = serial();
chain.send(() => doSomething()); // 返回的 promise 就是回执

// 2. actor：状态在闭包里，外面只拿到方法
const room = actor((life) => {
    const lines: Line[] = [];

    // 内部函数：不排队（它已经在这条链上了）
    const push = (who: string, text: string) => {
        const line = { seq: lines.length + 1, who, text };
        lines.push(line);
        return line;
    };

    return {
        async say(who: string, text: string) {
            if (life.signal.aborted) return; // ← 取消的唯一钩子
            await network();
            return push(who, text);
        },
        log: () => [...lines],
    };
});

await room.say('你', '你好'); // 普通函数调用，有类型，有返回值
await room.close(); // abort + 排空
```

## 跨进程不属于这个包

`$call(fn, args, { signal })` 是留给桥接层的唯一接缝 —— 外部能把「对面取消了」变成方法内的 `life.signal.aborted`，actor 不需要知道自己在远端。

桥怎么搭、为什么用 rpc 而不自建、什么时候干脆别桥： [`docs/bridging-rpc.md`](./docs/bridging-rpc.md)，可运行版 `examples/06-rpc-bridge/`。

## 八个范例

| #   | 目录                      | 讲什么                                                            |
| --- | ------------------------- | ----------------------------------------------------------------- |
| 01  | `examples/01-serial/`     | 不排队会丢东西                                                    |
| 02  | `examples/02-room/`       | 调用即得值                                                        |
| 03  | `examples/03-queue/`      | 连点 N 次 = N 个工作单元                                          |
| 04  | `examples/04-cancel/`     | 取消，保留已产出的                                                |
| 05  | `examples/05-persist/`    | 崩溃恢复：一次提交 = 一行                                         |
| 06  | `examples/06-rpc-bridge/` | 跨进程：actor 不改一字，rpc 桥进来                                |
| 07  | `examples/07-aggregate/`  | 多个 actor 汇总成一条流                                           |
| 08  | `examples/08-cmd/`        | 声明式（`cmd` + `implement`）：契约与实现分居两文件，类型只推一次 |

每个目录一份 README，见 [`examples/README.md`](./examples/README.md)。

## 已知取舍（不是 bug）

| 取舍                        | 后果                                  | 什么时候不能接受                           |
| --------------------------- | ------------------------------------- | ------------------------------------------ |
| 读也排队                    | 长任务跑着时，`log()` 要等它跑完      | 需要看中间态 → 用回调推，别回头查（见 04） |
| 取消靠任务自己检查 `signal` | 不检查就等它跑完                      | 长任务里每个 await 边界都加一行            |
| 取消是协作式的              | abort 只能把 signal 翻成 aborted      | 想硬杀 → 得把活拆成可丢弃的小步（见 04）   |
| 跨进程要声明 shape          | 每个方法一行 zod，位置参数包成 `args` | 方法特别多 → 考虑类型生成，别自建协议      |
| 没有幂等键                  | 重发 = 执行两次                       | 网络重试 → 在方法里自己记 `commandId`      |
| 状态在闭包里                | 不能从外面读快照做渲染                | 要渲染 → 额外暴露 `log()` / `state()`      |
| 队列在内存里                | 进程死了，排队的活就没了              | 需要「重启后继续排队」→ 队列也要落盘       |

## 为什么不用 xstate

看过 113 个 xstate 范例后的结论：它能省事的是「取消竞态」「长期挂起」「模型测试」，**队列那一块它一行都帮不上** —— 所有官方例子的队列都是 `context.xxx: T[]` 自己维护的。

详细记录见 [`docs/why-not-xstate.md`](./docs/why-not-xstate.md)。

## 和旧版的关系

这里原来有一个 5400 行的平台版（wire / client / kinds / runtime / 12 篇文档 / 4 个 demo）。已清理，需要时看 git 历史。

清理理由：那 5400 行里，`wire`(264) + `client`(293) + `kinds`(254) + 幂等/effect 那部分，基本都在补「跨机器」才需要的东西。单进程用不上，跨进程又补不完（断线重连、超时、版本协商各要几百行）。
