# 06 — 跨进程：调用方那几行一个字都不用改

**这一节只讲一件事：方法调用本来就是消息。换进程只改「帧怎么送」，不改「代码怎么写」。**

## 跑

```bash
./sha.sh e06
```

## 输出

```
跨进程调用，每个调用拿回自己那一条：
  seq=1  你: 一
  seq=2  你: 二
  seq=3  你: 三

对面进程里的日志：
  1. 你: 一
  2. 你: 二
  3. 你: 三
```

## 对比两种 `run`

```
本地：  run = () => fn.apply(impl, args)
远程：  run = () => 把 { id, method, args } 发出去，等 { id, ok, data }
```

`actor()` 里那一行是前者。这个范例把后者手写了 20 行，**别的什么都没改**。

## 服务端（另一个进程）

```ts
if (process.env.ROLE === 'server') {
    const room = actor(() => ({ ... }));   // ← 和 02 完全同一个 actor

    // 整个跨进程适配器就这 7 行
    process.on('message', async (frame) => {
        try {
            const data = await room[frame.method](...frame.args);
            process.send({ id: frame.id, ok: true, data });
        } catch (err) {
            process.send({ id: frame.id, ok: false, error: err.message });
        }
    });
}
```

## 客户端（本进程）

```ts
// 帧协议的全部内容：id + method + args / ok + data
const pending = new Map();
let nextId = 0;

child.on('message', (frame) => {
    const waiter = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.ok) waiter.resolve(frame.data);
    else waiter.reject(new Error(frame.error));
});

function call(method, ...args) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, method, args });
    });
}

// 这一层就是「远程的 actor」。类型手写一次，别的地方不再管传输。
const room = {
    say: (who, text) => call('say', who, text),
    log: () => call('log'),
};
```

下面调用方写的 `room.say('你', '一')`，和 02 里一模一样。

## 代价只有一条

**`args` / 返回值必须可序列化。** 不能传函数、class 实例、循环引用。

这条代价只在「真的跨进程」时才存在 —— 单进程用 `actor()` 就没有这个限制。

## 这个范例故意不做的

真实系统里这 20 行会变成 300 行，因为要补：

| 缺口 | 不补的后果 |
|---|---|
| 断线重连 | 进程死了，`pending` 里的 promise 永远不 resolve |
| 请求超时 | 对面卡住，调用方也卡住 |
| 幂等键 | 重发 = 执行两次 |
| 版本/协议协商 | 两端代码不同步时静默出错 |

这些是「跨机器」才要的，不是「actor」要的。想看补齐了的样子，去翻旧版（已删，见 git 历史）。
