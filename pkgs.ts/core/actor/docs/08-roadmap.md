# 08 · 落地状态与下一步

> 本包当前版本：`0.1.0`（内核 v0：可跑、可测、**零 IO**；真链路与落盘在 `examples/`，[10](./10-scenario.md)）。
> 排序原则：**先让一个真实 kind 跑通，再补远端**。远端适配器写早了只会把协议里的空洞固化。

## 一、已经有的（v0）

| 能力 | 位置 | 验收 |
|---|---|---|
| 帧口径 + 编解码 | `src/wire.ts` | `tests/intent.wire.test.ts`（10 条） |
| 声明层（链式、零注解） | `src/kinds.ts` | `tests/support/fixtures.ts` 两个 kind |
| 串行队列 + 提交原子性 | `src/runtime.ts` | 20 并发 == 20 次生效 |
| 幂等（`commandId`） | `src/runtime.ts` | 同 id 两次 == 一次 |
| 长活（`deferred` / `defer` / `$fault`） | `src/runtime.ts` | `$command.finished` 用例 |
| 事件日志 + `$events` / `watch` | `src/journal.ts` + `src/client.ts` | 补历史 + 实时去重 |
| 多目标扇出（逐项 + 回执） | `src/fanout.ts` | 3 目标 1 掉线 / 全掉线 / 空目标 |
| 进程内链路 + 本地端口 | `src/transport.ts` / `src/local.ts` | 全部用例都走它 |
| **调用方函数层**（`useKind`：契约 → 静态类型方法） | `src/api.ts` | `tests/api.test.ts`（6 条，+ 编译期锁） |
| **入门范例**（单进程 40 行 / 两进程 40 行） | `examples/hello-*.ts` | `tests/examples.hello.test.ts`（2 条，[09](./09-hello.md)） |
| **真链路范例**（3 进程 + unix socket + `kill -9`） | `examples/demo/` | `tests/examples.scenario.test.ts`（九步，[10](./10-scenario.md)） |
| **落盘 store**（一行一次提交） | `examples/lib/store-jsonl.ts` | `tests/examples.store.test.ts`（5 条，含半行截断） |

## 二、下一步（按这个顺序）

### 刀 1 · `diy.room` 迁成 kind（第一个真实业务）

- 入参 `id → room`、`member → memberRef`（[07](./07-naming-ledger.md) A1 / B1）；
- `post` → `command`（sync）、`turn` → `query`、`read` → `query`；
- `roster` 先按本地答写（`resolve`），保持行为不变；
- 验收：`pkgs.ts/room` 的现有用例全绿，且**没有任何字段叫 `id` / `payload` / `body`**。

### 刀 2 · `roster` / `turn` 改逐项状态（销 A2）

- `roster` 换 `fanoutQuery`：每个成员一项，三态 + `reason`；
- 一个成员所在 target 不可达 → 那一项是 `unknown`，**不是** `null`、**不是**消失；
- 验收：3 成员 1 掉线的用例（照 `tests/intent.fanout.test.ts` 抄）；UI 头像行能区分「没会话」和「读不到」。

### 刀 3 · 持久化 store（**范例已跑通**，剩下裁剪与幂等表）

`examples/lib/store-jsonl.ts` 已经不是"两个文件"，而是**一行一次提交**（状态 + 游标 + 事件），
所以不存在「append 与 save 之间崩掉」那个窗口；尾部半行在 open 时截掉（[10](./10-scenario.md) 六）。
剩下两件事：

- **日志裁剪 / 快照**：现在每行都带一份完整 state，库会一直长。要按「N 次提交 + 已有快照」折叠；
- **幂等表落盘**（= 刀7）：现在重启后同一个 `commandId` 会**再写一次** —— 范例第 ⑧ 步把它显形了。

验收：杀进程再起，`snapshot()` 与崩溃前一致；重发同一 `commandId` 拿到上次的回执（⑧ 那一步变绿）。

### 刀 4 · 跨节点端口（`ws` 适配器 + 一个真实扇出）

- 适配器：`frameLink(TextLink)` 包 ws；按 `target` 找链路（这个映射属**上层**，不进协议）；
- 顺带定 `meta.fanout` 的名字（[07](./07-naming-ledger.md) C5）；
- 验收：两台机器、一个成员的节点被 kill → 那个成员是 `unknown`，其它成员照常；`err` 只在全掉线时出现。

### 刀 5 · 一致性与投影（`stale` 真正生效）

现在 runtime 就是 owner，`stale` 恒 `false`。等「远端只读投影 + 本地读」出现时：

- 投影侧声明 `consistency: "projection"`，`ok` 带 `stale: true` + `watermark`；
- 调用方 `consistency: "owner"` → 等待追平（用 store 的 `caughtUp`）；
- 验收：CLI 的 `room focus && room get` 不再读到旧值（read-your-writes）。

### 刀 6 · 取消

- `cmd` 帧加 `signal`（或 `$cancel` 命令），handler 拿 `AbortSignal`；
- 在途工作单元不能强停（JS 限制），由 handler 自己协作中断 —— 与 `serial-queue` 同口径；
- 验收：用户点「停止」后，`$command.finished` 是 `ok: false, code: E_CANCELLED`。

### 刀 7 · 跨重启幂等

- store 加 `commandId → 结果` 表（可以和 `$command.finished` 事件合并，不必新表）；
- 验收：命令提交后杀进程，重启后重发同一 `commandId` → 拿到上次的回执，不重复执行。

## 三、明确不做

| 不做 | 理由 |
|---|---|
| 一个 actor 多写者 / 并发 worker | 那正是这套东西要消灭的东西（[01](./01-model.md)） |
| 跨节点写事务 / 分布式锁 | 跨节点写 = 两次命令 + 业务补偿；协议不提供幻觉 |
| 消息队列（持久投递、ACK、重投） | 平台是「一个实例一个 actor」，投递在本进程内就是队列；跨进程投递是 `job` 注册表的事 |
| 结构化并发 / async_hooks 追踪 | 现在 `onLog` + `$fault` 够用；等有第二个消费方才值得 |
| 内置压缩 / 快照裁剪 | 属业务（`compaction` 那一套），actor 只保证「日志只追加 + 能 replay」 |
| 权限模型 | `E_PERMISSION` 已预留；多用户是产品问题，不是协议问题 |

## 四、维护约定

- 改协议 **必须**同时改：[02](./02-wire.md) 字段表 + [07](./07-naming-ledger.md)（若涉及改名）+ `tests/intent.wire.test.ts`；
- 改执行语义 **必须**有对应 intent 测试（"如果没有这条不变量会出什么事"）；
- 文档里的示例代码要和 `tests/support/fixtures.ts` 同源 —— 示例烂了等于没有文档。
