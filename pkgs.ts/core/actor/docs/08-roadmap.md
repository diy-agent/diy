# 08 · 落地状态与下一步

> 本包当前版本：`0.1.0`（v0，可跑、可测、无 IO）。
> 排序原则：**先让一个真实 kind 跑通，再补远端**。远端适配器写早了只会把协议里的空洞固化。

## 一、已经有的（v0）

| 能力 | 位置 | 验收 |
|---|---|---|
| 帧口径 + 编解码 | `src/wire.ts` | `tests/intent.wire.test.ts`（8 条） |
| 声明层（链式、零注解） | `src/kinds.ts` | `tests/support/fixtures.ts` 两个 kind |
| 串行队列 + 提交原子性 | `src/runtime.ts` | 20 并发 == 20 次生效 |
| 幂等（`commandId`） | `src/runtime.ts` | 同 id 两次 == 一次 |
| 长活（`deferred` / `defer` / `$fault`） | `src/runtime.ts` | `$command.finished` 用例 |
| 事件日志 + `$events` / `watch` | `src/journal.ts` + `src/client.ts` | 补历史 + 实时去重 |
| 多目标扇出（逐项 + 回执） | `src/fanout.ts` | 3 目标 1 掉线 / 全掉线 / 空目标 |
| 进程内链路 + 本地端口 | `src/transport.ts` / `src/local.ts` | 全部用例都走它 |

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

### 刀 3 · 持久化 store（jsonl 先做）

- 实现 `ActorStore`：`append` 追加到 `journal.jsonl`，`save` 写 `state.json`（同目录、同事务语义 = 先 append 再 save）；
- 启动：`load` → 从 `cursor` 之后 replay；
- 验收：杀进程再起，`snapshot()` 与崩溃前一致；重放不重复应用（idempotent replay = 按 `seq` 跳过已应用的）。

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
