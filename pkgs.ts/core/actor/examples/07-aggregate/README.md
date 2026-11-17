# 07 — 多个 actor 汇总成一条流

**这一节只讲一件事：整体状态不是「问 N 个」，是一个 actor 的 state。**

## 跑

```bash
./sha.sh e07
```

## 输出

```
nav ⟵ (空)
nav ⟵ t1[running 0轮]
nav ⟵ t1[running 0轮]  t2[running 0轮]
nav ⟵ t1[running 0轮]  t2[running 0轮]  t3[running 0轮]
nav ⟵ t1[done 1轮]  t2[running 0轮]  t3[running 0轮]
...

乱序投递：
  投一条 t1 的旧行（seq=1）→ {"accepted":false,"reason":"旧行：seq 1 ≤ 2"}
  投一条 t1 的新行（seq=99）→ {"accepted":true,"reason":"替换"}

源重启（sessionId 换个值）：
  → {"accepted":true,"reason":"替换"}
```

## 结构

```
t1 ─┐
t2 ─┼──→ catalog（一个 actor，state = 一张行表）──→ nav（只订阅这 1 条流）
t3 ─┘
```

三个 session 各自是独立的 actor，互相不认识。它们**单向上报**给 catalog，nav 只订阅 catalog。

## 为什么不用扇出查询

```
nav → 问 t1 / 问 t2 / 问 t3 → 拼起来
```

三个问题：

1. **返回值拿到那一刻就过期** —— 三个回答不是同一时刻的，拼出来的整体状态从来没有真实存在过。
2. **N 条查询会把写挡住** —— 读也排队（见 `02-room`），三个 session 的写要等三个查询。
3. **nav 要知道有几个 session** —— 加一个就改一次 nav。

catalog 方案下，nav 不知道有几个 session，也不需要知道。

## 单调合并

```ts
function isNewer(next: Row, prev: Row | undefined): boolean {
    if (!prev) return true;
    if (next.sessionId !== prev.sessionId) return true;  // 源重启过，整行替换
    return next.seq > prev.seq;                          // 同一次生命内，只认更大的 seq
}
```

这两行让**乱序和重放都安全**：

- 旧行晚到 → 丢掉（`seq 1 ≤ 2`）
- 同一条重发 → 丢掉
- 源重启（`sessionId` 变了）→ 整行替换，不看 seq

之所以能这么简单，是因为每条上报都自带 `(sessionId, seq)` —— **身份在数据里，不在连接里**。

## 一个要自己想的点

`emit()` 是在 actor 内部同步调用的：

```ts
const emit = () => {
    const snapshot = [...rows.values()];
    for (const cb of subs) cb(snapshot);
};
```

订阅回调跑在 actor 的链上。所以**回调里不能 await catalog 自己的方法**（自己等自己）。

真实场景里回调通常是「往 UI 推一条」，同步的，没问题。要异步就往另一个 actor 投递。
