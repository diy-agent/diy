# 一条连接，多话题：把 SSE 从「每房间一条」改成「每应用一条」

> 2026-11-19 · 关联：`apps/diy2/server/stream.ts`、`pkgs.ts/ui/chat-transport-http/src/hub.ts`、
> `docs/plans/2026-11-18-workbench-pages.md`（那里的「前置阻塞项」由本文解掉）

## 1. 现场

多页工作台（3 个对话页开着）用了一会儿后，整个应用**发不出消息、也拉不到历史**：所有请求
不返回，等多久都不返回（不是慢）。点「停止」也没反应。

原因不是后端卡了，而是**连接配额**：

- 浏览器同源 HTTP/1.1 只有 **6 条**并发连接，且这个配额**按 profile 共用**（同 profile 的
  所有标签页共享 6 条）；
- 老传输层「一个房间一条常驻 SSE」（`GET /api/rooms/:id/events`）；
- 每次发送又**再挂一条** SSE（`POST /api/rooms/:id/chat` 本身就是那条 SSE，一直挂到整轮
  结束 —— 可能十几分钟），并且插话时会新增而不是复用。

于是：3 个聊天页 = 3 条常驻 + 每次发送 1 条 = 4~6 条常驻不动的连接。配额一满，同 profile 下
对这个源的**任何**请求都排在队尾永远不执行 —— 连 `GET /history`、`POST /cancel` 都发不出去。

## 2. 改法

**连接数与「开着多少个房间」解耦：一个 app 实例一条 SSE，房间是这条连接上的话题。**

```
GET  /api/stream                    → SSE，首帧 {$conn:{conn}}
POST /api/stream/subscribe  {conn, topic}   topic = `room:<roomId>`
POST /api/stream/unsubscribe {conn, topic}
帧：data: {topic, event}
```

- 身份 `$conn` **由服务端下发**：客户端自造 id 会和「上一个进程 / 上一次连接」撞车，
  而那正是重连后订阅挂空的原因。
- 一条话题只在**第一个**订阅者出现时接上房间广播，最后一个走了就摘掉（`teardown`）。
  没人看的房间不该继续占广播，也不该让服务端往死 socket 上白写。
- `POST /api/rooms/:id/chat` 改成**受理即返**（`{ok:true}`）。发送失败不再能用状态码表达
  （那时响应早发完了），改为在话题上推一条 `{kind:'error'}` —— UI 本来就有这条路。
- 房间被删：先广播一条 `{kind:'done'}`（传输层收尾帧，不属于 `RoomEvent`），再把话题从
  所有连接上 `drop` 掉。
- 心跳（20s 注释帧）与 `x-accel-buffering: no` 保持，别让反代把 SSE 憋住。

客户端（`chat-transport-http`）：

- `StreamHub` 持有一条连接 + 「话题 → 监听者」表；
- `watch(roomId)` = 订话题；`post()` = 在已订话题上挂**一份临时**回调 + 一次 JSON POST
  （不再开第二条连接，也不再等整轮）；
- 断线退避重连（0.5s → 30s 封顶；第一个重试就是 0.5s，不是 1s），重连后按本地话题表
  重订，并对每个话题补一条 `{kind:'ready'}`，上层据此补拉快照填断线。
- 订阅请求去重：`watch` 和 `post` 可能同时要同一条话题，别订两遍。

## 3. 凭什么说修好了

- `apps/diy2/tests/stream.test.ts`：一条连接订两个话题事件各归各的、`hub.size === 1`、
  最后一个订阅者走了摘数据源、连接断了话题一起退、未知连接订阅 404。
- `pkgs.ts/ui/chat-transport-http/tests/stream-mux.test.ts`：看多个房间只开一条 SSE、
  按话题分发、`post` 不再多开连接且立刻返回、退订/重订、断线重连后重订并补 `ready`。
- 真实进程冒烟（`DIY2_PORT=5399`，脚本直连）：`/api/stream` 首帧 `$conn` → 建房 → 订阅 →
  `POST /chat` **4ms** 返回 `{ok:true}` → `item/delivery/running` 全部走那条共用连接 →
  删房后该话题 404、伪连接 404。

## 4. 没做的（有意）

- **单连接内的多路流控**（背压/优先级）：一条连接被某个房间的事件占满时没有公平性保证。
  量级上还不需要（事件是小 JSON，房间数是几十）。
- **跨标签页共享同一条连接**（SharedWorker / BroadcastChannel）：连接数已经降到
  「标签页数」，先把工作台跑起来再看。
- `chat-core` 的 `release()` 概念**删掉**了：连接是共用的，没有「收掉这个房间的连接」这回事；
  `dispose()` 只退订话题。
