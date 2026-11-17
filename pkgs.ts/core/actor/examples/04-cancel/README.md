# 04 — 取消：中断正在跑的，保留已经产出的

**这一节讲三件事：取消怎么触发、取消时返回什么、为什么「看中间态」只能靠推。**

## 跑

```bash
./sha.sh e04
```

## 输出

```
  （跑到第 12 个 chunk 时按了取消）
stream() 的返回值 → { 12 字, cancelled: true }
↑ 已经收到的部分还在，调用方拿得到，不需要重启或另外查库

关掉之后再调用 → actor closed: stream()
room.closed = true

不检查 signal 的 actor：close() 等了 200ms，结果 = 我还是跑完了
↑ 该停的时候没停 —— 这一行 if 没人能替你写
```

## 三件事

### 1. 取消是任务自己检查的，不是框架送的

```ts
const room = actor((life) => ({
    async stream(_prompt: string) {
        for (let i = 0; i < 100; i++) {
            // ↓ 唯一要自己写的一行
            if (life.signal.aborted) {
                return { text: chunks.join(''), cancelled: true };
            }
            await sleep(10);
            chunks.push('字');
        }
        return { text: chunks.join(''), cancelled: false };
    },
}));
```

`close()` 会 `abort()`，但**不会**打断正在 `await` 的代码。任务在下一个边界上看一眼 `signal`，自己决定停在哪。

第三段是反例：不看 `signal` 的 actor，`close()` 会一直等它跑完（200ms），然后才返回。**这一行 `if` 没人能替你写。**

### 2. 取消时正常返回，不抛异常

```ts
const running = room.stream('...');
await sleep(120);
await room.close();

const result = await running;   // resolve，不是 reject
// → { text: '字字字...（12 个）', cancelled: true }
```

已经产出的部分在返回值里。调用方不需要「重启任务再查库」—— 这次的产出就是这次的返回值。

> 这条形状是刻意设计的：流式 LLM 被中断时，**已收到的文字是有价值的**，不该因为「没跑完」就丢掉。

### 3. 关掉之后新调用被拒，不是悄悄排队

```
关掉之后再调用 → actor closed: stream()
```

如果它悄悄排队，调用方会永远等下去。这里直接 reject。

## 为什么「看中间态」只能靠推

`stream()` 跑着的时候，`room.log()` 是**排在它后面**的 —— 要等它跑完才 resolve。所以在第 12 个 chunk 想知道「现在几个字」，回头查是查不到的。

办法只有往外推：

```ts
if (chunks.length === 12) console.log(`...`);   // 在任务内部
// 真实场景：onChunk?.(chunks.join('')) 或者往另一个 actor 的 emit() 投一条
```

**读排队**是简化版的取舍之一（见 README「已知取舍」）。要彻底解决得给读开旁路，那就不再是 130 行的事了。
