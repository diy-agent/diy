# 02 — 调用即得值

**这一节只讲一件事：`await room.say(...)` 拿到的是这一次调用的结果，不是消息对象。**

## 跑

```bash
./sha.sh e02
```

## 输出

```
三个调用同时发出，每个都拿回自己那一条：
  seq=1  你: 你好
  seq=2  agent: 你好，我是 agent
  seq=3  你: 下一题

日志里的顺序（由投递顺序决定，与完成先后无关）：
  1. 你: 你好
  2. agent: 你好，我是 agent
  3. 你: 下一题
```

## 要点

方法表就是接口定义。类型是白拿的：

```ts
const room = actor(() => {
    const lines: Line[] = [];
    let seq = 0;

    // ↓ 内部函数：不排队。它已经在这条链上了，再排一次就是自己等自己。
    const push = (who: string, text: string): Line => { ... };

    return {
        async say(who: string, text: string): Promise<Line> { ... },
        log(): readonly Line[] { return [...lines]; },
    };
});
```

`ActorOf<...>` 会把每个方法都包成 `Promise` 化版本，参数和返回类型原样保留。

## 为什么不用消息式

消息式的调用方要写这些：

```ts
room.send({ type: 'say', who, text });
const off = room.on('said', ({ seq, id }) => {
    if (id === myId) resolve(seq);
});
```

三件额外的事：自己生成 id、维护 `id → resolve` 的表、记得取消订阅。

这里一件都不用做 —— **方法的返回值本来就是回执**。

## 两个容易踩的坑

1. **actor 内部互调要走内部函数**，别走 `room.xxx()`。后者会再排一次队，等于自己等自己（死锁）。
2. **读也排队**。`room.log()` 排在所有已投递的写后面，所以它一定看得见更早投递的写，看见的永远是「某个工作单元跑完」的状态，不会读到写了一半的中间态。

第 2 条的代价：**长任务跑着时，读要等**。需要看中间态就别回头查，用回调往外推（见 `04-cancel`）。
