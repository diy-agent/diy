# 02 · 帧口径（wire）

> 对应源码：`src/wire.ts`（唯一真源）、`src/errors.ts`（错误码）
> 测试：`tests/intent.wire.test.ts`

## 一、三层结构

```
外层 frame   type + 关联(id / commandId) + 顺序(seq) + 新鲜度(watermark / stale)   ← runtime 独占，kind 不可见
     ↓ 派发
name         kind 声明里的 key（方法名 / 事件名）                                   ← runtime 用它查声明
     ↓ 业务
data                                                                              ← **kind 的 zod 只校验这一层**
```

**判据一句话：`data` 里只装 kind 声明过的东西；`data` 外面的一切都是 runtime 的。**

推论（都踩过）：

- 业务想加「版本号 / 是否部分成功 / 目标列表」→ 一律进 `data`，不进外层；
- 外层想加字段（`routing`、`partial`）→ 先问「runtime 怎么知道它该填什么」，答不上来就不该加；
- 传输适配器只搬帧，**不许**解释 `data`（[06](./06-transport.md)）。

## 二、两条轴：执行轴 vs 业务轴

这是整套协议最重要的一条区分，也是 `partial` 被否决的根据。

| 轴 | 唯一载体 | 取值举例 | 谁决定 |
|---|---|---|---|
| **执行轴** | 帧 `type`（+ `code`） | `ok` 跑完了；`err` 没跑成（参数非法 / 网络断 / 库坏 / 没权限） | runtime |
| **业务轴** | `data` 里 | 那台机器没启动；那个成员没会话；这一轮已不在 | kind |

```
查腾讯云 10 台机器 → 8 台 running、1 台 stopped、1 台 agent 没应答
⇒  type: "ok"          ← 查询成功了，三种状态都是 data
```

只有「这 10 台我一台都问不到 / 我没有权限 / 参数写错了」才是 `err`。

**为什么不能把业务状态提到 `type` 上**（业界同口径，见 [05](./05-multi-target.md) §五）：

1. 客户端 `switch (type)` 要为「成功」和「部分成功」写两遍同一份渲染，且极易不同步；
2. 重试语义变糊：「部分成功」该重试全部还是重试失败的？`ok` + 逐项状态时，重试就是**再问一次**；
3. 会**蔓延**：任何「部分成功」都往协议里挤，最后协议变成业务状态机。

## 三、字段表

| 字段 | 谁写 | 谁校验 | 生命周期 | 说明 |
|---|---|---|---|---|
| `type` | 构造方 | `FrameSchema` | 单帧 | 八个之一：`cmd` `query` `accepted` `done` `rejected` `ok` `err` `event`。**没有 `partial`** |
| `name` | 调用方 | runtime 查 kind | 单帧 | 方法名 / 事件名；`$` 前缀 runtime 保留（[四](#四--前缀是-runtime-保留)） |
| `data` | 调用方 / actor | **kind 的 zod** | 单帧 | 只有这一层进业务 schema |
| `id` | 调用方 | codec | **每次尝试唯一** | 在途匹配用；重试换新 `id`（否则迟到的回执会误配） |
| `commandId` | 调用方 | codec | **跨重试稳定** | 去重表 + `$command.status` 的键；`query` 结构上没有 |
| `seq` | actor | codec | 单调 | 事件流位置（`done` 带它 = 这个命令的事件末尾） |
| `at` | actor | codec | 单调 | `accepted` 的受理点（其后的事件才是这个命令产生的） |
| `watermark` | actor | codec | 单帧 | 这份答案物化到的事件位置（`ok` 才有） |
| `stale` | actor | codec | 单帧 | 投影慢半拍：`consistency: "owner"` 之前它为 `true` |
| `meta.fanout` | runtime | codec | 单帧，可选 | 扇出的**执行回执**；给重试与可观测性，**UI 不读**（[05](./05-multi-target.md)） |

三个 id 混用会同时坏掉三件事：在途匹配、幂等去重、断点续读。所以它们是 branded 类型
（`RequestId` / `CommandId` / `Cursor`），**不许**裸 `string` 直传。

## 四、`$` 前缀是 runtime 保留

| 名字 | 方向 | 用途 |
|---|---|---|
| `$command.finished` | 事件 | `deferred` 命令的长活尾巴跑完（含 `ok` / `code` / `output`） |
| `$command.status` | 查询 | 冷补命令状态（重开页面 / 换设备） |
| `$events` | 查询 | 读事件日志（`watch({ after })` 补历史） |
| `$fault` | 事件 | 队列里某个后续工作单元失败（fire-and-forget 不能静默） |

`defineKind` 会拒绝业务名以 `$` 开头。理由：`$` 空间是**协议**的，业务占进去以后就没人分得清
「这条事件是不是 runtime 自己发的」。

## 五、错误码（执行轴封闭枚举）

| code | 谁产生 | 含义 |
|---|---|---|
| `E_INVALID_ARGUMENT` | codec / runtime | `data` 与 schema 不符 → `rejected`（**没进 handler**） |
| `E_UNKNOWN_METHOD` | runtime | actor 有，但没声明这个方法/事件 |
| `E_NOT_FOUND` | 端口 / runtime | **收件人**不存在（target actor 找不到、目标节点没有这个 actor） |
| `E_UNAVAILABLE` | runtime / kind | 依赖不可用：扇出全败、端口没注入 |
| `E_TIMEOUT` | 端口 / client | 单项超时 |
| `E_CONFLICT` | kind | 乐观并发失败（读到的版本已过期） |
| `E_PERMISSION` | kind | 无权执行 |
| `E_CANCELLED` | kind | 被取消（协议预留；当前 runtime 不主动产生） |
| `E_INTERNAL` | runtime | handler 抛了非 `ActorError` 的异常 |

**注意 `E_NOT_FOUND` 的精确含义**：它是「找错了收件人」，不是「资源里没有这条」。
后者是业务事实，必须 `ok` + `data.items[i].state = "missing"`。

`ActorError(code, message, { retryable })` 是唯一允许业务抛的异常；`retryable` 缺省：
网络 / 超时 / 冲突为 `true`，其余 `false`（重试同一份坏入参只是浪费一次往返）。

## 六、八个帧（方向是硬约束）

| type | 方向 | 关键字段 | 何时出现 |
|---|---|---|---|
| `cmd` | 调用方 → actor | `id` `commandId` `name` `data` | 发起命令 |
| `query` | 调用方 → actor | `id` `name` `data` `consistency?` | 发起查询 |
| `accepted` | actor → 调用方 | `id` `commandId` `at` | 长活命令已受理（结果走 `$command.finished`） |
| `done` | actor → 调用方 | `id` `commandId` `data` `seq` | 命令跑完并已提交 |
| `rejected` | actor → 调用方 | `id` `commandId?` `code` `message` `issues?` | 帧本身不成立（**没进 handler**） |
| `ok` | actor → 调用方 | `id` `data` `watermark` `stale?` `meta?` | 查询成功（业务状态好坏都在 `data`） |
| `err` | actor → 调用方 | `id` `code` `message` `retryable?` `meta?` | 执行失败 |
| `event` | actor → 调用方 | `name` `data` `seq` `at` `commandId?` | 事件推送（`$` 与业务同一个 seq 空间） |

`rejected` 与 `err` 的分界：**进没进 handler**。`rejected` = 帧没成立，状态一定没动，修正后可用
同一个 `commandId` 重试；`err` = handler（或提交）失败了，`commandId` 记成 `failed`。

## 七、`consistency`

声明给**下限**，调用方只能升不能降：

| 取值 | 含义 | 谁用 |
|---|---|---|
| `projection`（缺省） | 投影可能慢半拍；`stale` 可能为 `true` | UI 渲染 |
| `owner` | 至少追到 owner 当前位置 | CLI 两步式命令（`room focus && room get`） |

当前 runtime **就是 owner**，所以 `stale` 恒为 `false`。等出现「远端投影 + 本地读」的形态时才真正生效
（[08](./08-roadmap.md)）。

## 八、编解码

传输层只搬字符串：`encodeFrame(frame)` → JSON；`decodeFrame(text | unknown)` → `{ ok, frame } | { ok:false, message, issues }`。

适配器只用这两个函数 + `frameLink(textLink)`（[06](./06-transport.md)），不需要知道帧长什么样。
坏帧在链路层丢弃并计数，**不往业务层传** —— 一条坏帧不该让整个连接进入未定义状态。

**`data` 必须显形。** JSON 没有 `undefined`，`JSON.stringify` 会把值为 `undefined` 的键**删掉**；
于是 `output: z.void()` 的命令回 `done` 时 `data` 消失，对面判「帧结构不符」→ 整帧被丢掉 →
调用方干等到超时（进程内链路对象直投、不过编解码，永远发现不了这条）。所以：

- `encodeFrame` 对 **`data` 这一位**做归一化：`undefined` → `null`；
- 其它可选的元字段（`consistency` / `stale` / `meta`）继续「没有这个键」—— 写成 `null` 会让
  `.optional()` 判它不合法（这条也踩过）；
- 反向：runtime 解析入参前把 `null` 换回 `undefined`（`runtime.ts` 的 `noData`），
  这样 `input: z.void()` 的声明仍然成立。

判据：`tests/intent.wire.test.ts`「`data` 是空值的帧不许被丢掉」（把归一化删掉立刻红），
真链路上的证据在 [10](./10-scenario.md) 的剧本里。

## 九、判据

1. `FrameSchema` 的 `type` 枚举里没有 `partial`（有测试守着：`tests/intent.wire.test.ts`）。
2. 新增外层字段时，能一句话答出「runtime 从哪知道该填什么」；答不上来 → 进 `data`。
3. 新增错误码必须同时改这三处：`ACTOR_CODES`、本篇表格、`docs/07-naming-ledger.md`（若涉及改名）。
4. `rg "type: 'partial'" src/` = 0；`rg "payload" src/` = 0（旧名一律不兼容）。
