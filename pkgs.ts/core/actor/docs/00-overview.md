# 00 · 概览：这个包是什么、不是什么

> 对应源码：`src/index.ts`（全部导出都在这一处）

## 一、是什么

**actor 的基础工具**：把「单实例 = 单写者」这条并发纪律，连同它需要的帧口径、声明层、执行体、
事件日志、多目标扇出，做成一个**与传输无关、与业务无关**的库。

它解决的是同一类 bug 的复发：

```
操作 A: 读 bots.json → [b1]     ┐ 交错
操作 B: 读 bots.json → [b1]     │
操作 A: 写入 [b1, b2]           │ ⇒ b3 丢了
操作 B: 写入 [b1, b3]           ┘
```

见过的真实表现：点了两次「新 bot」只多一个；改了名字刷新又变回去；session 里消息顺序颠倒；
`roster` 把「节点掉线读不到」画成「暂无」（这条是 `unknown` 被压成 `null`，见 [07](./07-naming-ledger.md) A2）。

## 二、不是什么

| 不是 | 为什么 |
|---|---|
| **不是 RPC 框架** | 不认识 `@diy-agent/rpc`，不做服务发现、不做路由、不做鉴权、不做多路复用。传输层只要求一个 `Link.send(frame)` / `onFrame`（[06](./06-transport.md)） |
| **不是数据库** | 只定义 `ActorStore`（事件日志 + 快照）接口，自带一个内存实现。持久化（jsonl / sqlite）在别的包，本包零 IO |
| **不是工作流引擎** | 没有 DAG、没有重试编排、没有定时器。长活只有 `deferred` + `ctx.defer` 一种形态（[01](./01-model.md) §五） |
| **不是分布式共识** | 不做 leader 选举、不做跨节点事务。一个 actor 一个写者；多个 actor 之间靠扇出**读**聚合，写不跨节点 |
| **不含业务** | 没有 room / bot / session。它们是 kind（[03](./03-kinds.md)），`diy.room` 在 `pkgs.ts/room` |

## 三、边界（依赖方向）

```
        ┌─────────────────────────────┐
        │ @diy-agent/actor            │   ← 只依赖 zod
        │  wire / kinds / runtime     │
        │  journal / fanout / client  │
        └───────────┬─────────────────┘
                    │ 被依赖（implementation）
    ┌───────────────┼────────────────┬──────────────────┐
    │               │                │                  │
 diy.room     agent-session      diy-cli / diy-app   远端适配器
 (kind)       (kind)             (client + 渲染)     (ws/http 桥)
```

**判据**：

```bash
rg -n "@diy-agent/rpc" pkgs.ts/core/actor     # 必须 0 命中
rg -n "from 'node:" pkgs.ts/core/actor/src    # 必须 0 命中（本包不碰 IO）
```

反过来说：**谁需要 RPC，谁去接适配器**。`@diy-agent/rpc` 要接 actor，是在它那边写一个
`frameLink(TextLink)` 的桥（[06](./06-transport.md) §三），而不是让 actor 依赖它。

## 四、三个动词，别的都不给

| 动词 | 语义 | 有副作用 | 幂等键 |
|---|---|---|---|
| `cmd(name, data)` | 写：走队列、提交状态与事件 | 有 | `commandId` |
| `query(name, data)` | 读：**也排队**（读不到中间态），可多目标扇出 | 无 | 无（可重发） |
| `watch({ after, include })` | 事件流：先补历史再接实时 | 无 | 用 `seq` 去重 |

没有 `get` / `set` / `subscribe` / `call` / `emit`。少一个动词，调用方就少一条绕过纪律的路。

## 五、一次命令的一生（全链路）

```
client.cmd('add', {by:1}, {commandId})
   │  ① 生成 id（每次尝试唯一）
   ▼
Link.send({type:'cmd', id, commandId, name, data})        ← 传输层（ws / 进程内）
   ▼
runtime #intake → #enqueue(…)                             ← 串行队列：队尾挂上去
   ▼
① 查幂等表：done → 原样回；running → 回 accepted；failed → 回 err
② zod 校验 data：不符 → rejected（**没进 handler**）
③ handler(ctx, input) → { output, state?, events? }
④ 原子提交：append(事件) → save(快照 + 游标) → 广播事件
   ▼
Link.send({type:'done', id, commandId, data: output, seq})
   ▼
client resolve → { ok:true, accepted:false, data, seq }
```

长活（`mode: 'deferred'`）在这一步分叉：handler 只受理 → 回 `accepted`，后续单元跑完后发
`$command.finished`（[04](./04-runtime.md) §六）。

## 六、约定（全仓一致）

| 事项 | 约定 |
|---|---|
| 命名 | 帧字段小写（`type` / `name` / `data` / `seq`）；事件名 `domain.verb`（`room.posted`）；`$` 前缀 runtime 保留 |
| 时间 | 事件 `at` 是毫秒数（跨机器排序要 UTC 语感）；需要人读时区的地方**不进协议**，在渲染层格式化 |
| 错误 | 执行轴封闭枚举 `E_*`（[02](./02-wire.md) §五），新增要改协议 + 改文档 |
| 日志 | 本包不写日志，只有 `onLog` 回调（适配器决定落到哪） |
| 测试 | `tests/*.test.ts` 全是 intent 测试；fixture 就是文档示例（`tests/support/fixtures.ts`） |
