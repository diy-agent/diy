# 并发架构：单实例 = 单 actor（备忘）

> 2026-11-02 用户裁：**轻量级 UI + 所有业务操作到核心层 + 单实例特性 ⇒ 系统性顺序执行（actor 形式）**。
> 起因：bot UI 改造时发现，如果 UI 层直接读写存储，多个操作交叉会造成状态错乱。

## 一、一句话

> **一个 app 实例是一个 actor。所有会改变状态的操作，排成一条队列，一次跑一个。**

## 二、三层职责

```
┌─────────────────────────────────────┐
│ UI（渲染层）                         │
│  只做两件事：显示状态 / 发起请求       │
│  ❌ 不读文件、不写文件、不调子进程      │
└──────────────┬──────────────────────┘
               │ RPC（单向、异步）
┌──────────────▼──────────────────────┐
│ 核心层（主进程）                      │
│  ✅ 全部业务逻辑                      │
│  ✅ 全部存储读写                      │
│  ✅ 队列调度：一次一个                │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│ 存储（文件 / 内存）                   │
│  只被核心层访问                       │
└─────────────────────────────────────┘
```

**判据**：UI 代码里出现 `fs` / `readFile` / `writeFile` / `child_process` ⇒ 架构错了。

## 三、为什么必须是顺序的

**单实例的真谛**：一个 app 只有一份内存状态。

如果两个操作同时跑：

```
操作 A: 读 bots.json → [b1]     ┐ 交错
操作 B: 读 bots.json → [b1]     │
操作 A: 写入 [b1, b2]           │ ⇒ b3 丢了
操作 B: 写入 [b1, b3]           ┘
```

**这不是理论风险**。见过的真实表现：
- 点了两次「新 bot」，结果只多了一个
- 改了 bot 名，刷新后又变回旧名
- session 里消息顺序颠倒

**顺序执行**就都能避免：A 完整跑完（读→改→写），B 才开始。

## 四、实现方式

### 队列

```ts
// 极简版，够用
let tail: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = tail.then(fn, fn);   // 前一个失败也要继续
    tail = next.catch(() => {});      // 不让失败污染队列
    return next;
}
```

**所有会写状态的操作都包在 `serial()` 里**：

```ts
async createBot(input) {
    return serial(async () => {
        const list = await store.list();      // 读
        const next = [...list, makeBot(input)];// 改
        await store.save(next);                // 写
        return snapshot();                     // 回
    });
}
```

**纯读操作不用排队**（`listBots` / `getBot`）。读不需要互斥，只要写是串行的。

### 粒度：整段"读—改—写"是一个原子

```ts
// ❌ 错：读和写之间可能被别的操作插进来
const list = await store.list();
await otherWork();
await store.save([...list, x]);

// ✅ 对：整段包起来
await serial(async () => {
    const list = await store.list();
    await store.save([...list, x]);
});
```

## 五、跨实例的边界

**单实例串行 ≠ 全局串行**。多个 app 实例（diy-app + apps/chat + dev app）各有各的队列，**互不阻塞**。

如果两个实例写**同一个文件**（比如都写 `~/.diy/bots/`），仍然会冲突。

**规约**：

| 场景 | 做法 |
|---|---|
| 同一个 app 的多个操作 | 队列串行（本节） |
| 不同 app 共享数据 | **不要共享** —— 各用各的 `DIY_HOME` |
| 确实要共享（如 dev app 读实例注册表） | 只读不写 |

## 六、长任务怎么办

有些操作很慢（跑构建、等 LLM 回复）。**不能因为慢就跳出队列** —— 那会让「读—改—写」的假设失效。

两种做法：

**甲、快操作排队，长任务异步化**

```ts
// 入队（快）
const jobId = await serial(() => enqueueJob({ kind: 'build' }));
// 长任务在后台跑，但它的结果落盘也走队列（写结果时再入队一次）
```

**乙、用状态机而不是锁**

长任务的状态写在文件里（`running` / `done` / `failed`），UI 轮询或订阅变化。

**diy 现有做法是乙**（`##408` job 注册表 + `##401` 异步等待），保持一致。

## 七、和 UI 的关系

UI **不持有业务状态**，只持有**显示状态**：

```ts
// UI 侧
let snapshot: ChatSnapshot | null = null;   // 显示用的快照
async function refresh() {
    snapshot = await rpc('chat.snapshot');   // 每次从核心层拿
    render();
}
```

**每次操作后重新拿快照**，不在 UI 里增量改（`snapshot.bots.push(...)` 这种）。理由：
- 增量改容易和核心层的真实状态不一致
- 快照本来就是核心层算好的，重新拿一次成本很低

## 八、判据

1. UI 层代码里 `rg 'readFile|writeFile|fs\.' apps/*/renderer*` = 0
2. 所有「读—改—写」操作都包在 `serial()` 里（`rg -c 'serial\('` 对比 `rg -c 'store\.save'`）
3. 并发测试：两个 `createBot` 同时发起，最终列表长度 +2（不是 +1）
4. 失败不污染队列：一个操作抛错，下一个照常跑
5. UI 每次操作后重新取快照，不做增量更新

## 九、历史讨论的位置

这条原则散落在几处，实现时对照看：

- `##480` store 方向：接口 + 内存缺省 + 装配器注入（**禁枚举分派**）
- `##401` 异步事件激活长进程：job 注册表 + 采样
- `##408` spawned job 注册表
- `local-agent` 的 turn 串行：一个任务同时只有一个 turn

**共同点**：都不在 UI 里做业务，都靠主进程串起来。
