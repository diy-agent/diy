# @diy-agent/actor

**一个 actor = 一份私有状态 + 一条串行链 + 一张方法表。`src/index.ts` 128 行，零依赖。**

这里没有：帧协议、幂等表、游标、快照格式、多目标扇出、生命周期树、状态机。
那些只有「要持久化 / 要跨机器」时才出现，谁需要谁在外面加（`examples/05`、`06` 各加十几行）。

## 跑

```bash
./sha.sh all        # 七个范例，一次跑完
./sha.sh e03        # 只跑第三个
./sha.sh check      # 类型 + lint
```

## 内核就三件

```ts
import { serial, actor } from '@diy-agent/actor';

// 1. 串行链：所有工作单元排在同一条 promise 链尾
const chain = serial();
chain.send(() => doSomething());   // 返回的 promise 就是回执

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
            if (life.signal.aborted) return;      // ← 取消的唯一钩子
            await network();
            return push(who, text);
        },
        log: () => [...lines],
    };
});

await room.say('你', '你好');   // 普通函数调用，有类型，有返回值
await room.close();             // abort + 排空
```

## 七个范例

| # | 目录 | 讲什么 |
|---|------|--------|
| 01 | `examples/01-serial/` | 不排队会丢东西 |
| 02 | `examples/02-room/` | 调用即得值 |
| 03 | `examples/03-queue/` | 连点 N 次 = N 个工作单元 |
| 04 | `examples/04-cancel/` | 取消，保留已产出的 |
| 05 | `examples/05-persist/` | 崩溃恢复：一次提交 = 一行 |
| 06 | `examples/06-net/` | 跨进程：调用方不用改 |
| 07 | `examples/07-aggregate/` | 多个 actor 汇总成一条流 |

每个目录一份 README，见 [`examples/README.md`](./examples/README.md)。

## 已知取舍（不是 bug）

| 取舍 | 后果 | 什么时候不能接受 |
|------|------|------------------|
| 读也排队 | 长任务跑着时，`log()` 要等它跑完 | 需要看中间态 → 用回调推，别回头查（见 04） |
| 取消靠任务自己检查 `signal` | 不检查就等它跑完 | 长任务里每个 await 边界都加一行 |
| `args` 必须可序列化 | 跨进程不能传函数 / class | 只在 06 那种场景才有 |
| 没有幂等键 | 重发 = 执行两次 | 网络重试 → 在方法里自己记 `commandId` |
| 状态在闭包里 | 不能从外面读快照做渲染 | 要渲染 → 额外暴露 `log()` / `state()` |
| 队列在内存里 | 进程死了，排队的活就没了 | 需要「重启后继续排队」→ 队列也要落盘 |

## 为什么不用 xstate

看过 113 个 xstate 范例后的结论：它能省事的是「取消竞态」「长期挂起」「模型测试」，**队列那一块它一行都帮不上** —— 所有官方例子的队列都是 `context.xxx: T[]` 自己维护的。

详细记录见 [`docs/why-not-xstate.md`](./docs/why-not-xstate.md)。

## 和旧版的关系

这里原来有一个 5400 行的平台版（wire / client / kinds / runtime / 12 篇文档 / 4 个 demo）。已清理，需要时看 git 历史。

清理理由：那 5400 行里，`wire`(264) + `client`(293) + `kinds`(254) + 幂等/effect 那部分，基本都在补「跨机器」才需要的东西。单进程用不上，跨进程又补不完（断线重连、超时、版本协商各要几百行）。
