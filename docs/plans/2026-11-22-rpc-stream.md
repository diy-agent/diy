# diy2 事件流迁到 RPC（WebSocket）

> 2026-11-22 · 事故驱动：6 条常驻 SSE 占满浏览器同源连接池，之后 POST 全部发不出去。

## 0. 事故与根因

- 现象：任务页「发送中」+「执行中 Ns」永不结束；服务端库里**没有**那条消息。
- 根因：浏览器同源 HTTP/1.1 上限 6 条（按 profile 共用）。每个对话页一条常驻 SSE，
  6 页占满后新请求**拿不到 socket**（不是慢，是根本不发）。服务端因此什么都没收到。
- 排除项：服务端健康（其它房间正常）、不是旧进程占端口、用户 Chrome 当时只剩 2 条
  （另 4 条是 Playwright 的独立 profile）。

## 1. 决定

- **命令面保持 REST**（改造大、收益小）。
- **事件流改走 WebSocket + `@diy-agent/rpc`**：一条连接，房间是 server-stream。
- 旧 SSE **保留**一个版本作为回退；客户端已切到 WS。

## 2. 落地形状

```
浏览器 ── WS /rpc ──▶ ChannelServerBinding
                        ├─ room({room}) server-stream  → app.attach(roomId) 的广播
                        └─ streams() unary             → [{conn, rooms, since}]
         ── REST /api/* ──▶ 现有路由（send / answer / cancel / CRUD）
```

- 服务端 `apps/diy2/server/rpc.ts`：`createRpcSocket({ attach, hasRoom })`；
  `handleUpgrade` 只认 `/rpc`（dev 里 vite HMR 也用 upgrade，别人的 path 不碰）。
- 客户端 `pkgs.ts/ui/chat-transport-http/src/hub.ts`：`StreamHub` 语义不变
  （`subscribe / ensure / close`），实现换成 `connectWs` + `serverStream`；
  首帧 `ready`；退避重连；非浏览器环境不连也不报错。
- `WsTransport.close()` / AbortSignal → 服务端 cancel 帧 → 流的 `finally` 里 detach。

## 3. 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | `@diy-agent/rpc/ws/browser`（浏览器适配） | ✅ #519 |
| P1 | 事件流走 WS；命令仍 REST；`streams` 观测 | ✅ 本 PR |
| P2 | 命令面迁 rpc（send/answer/cancel/CRUD），删 SSE + REST 胶水 | 待做 |
| P3 | dev app 订阅面板（连接 / 话题 / 在飞调用 / 断连次数） | 待做 |

## 4. 发布顺序（重要）

服务端与 UI 同属一个构建，但**先起服务端再刷页面**：

1. 新服务端有 `/rpc`；
2. 新 UI 才会连它。

反过来的话：旧服务端没有 `/rpc`，新 UI 的 hub 会一直退避重连（命令仍可用，但收不到事件）。

## 5. 验证

- `apps/diy2/tests/rpc.test.ts`：订阅 → `ready` → 删房间广播 `done`；`streams` 能看见
  订阅关系；不存在的房间以错误结束；客户端 `StreamHub` 真连能收到 `ready` + `done`。
- entity-chat 120 条不受影响（测试里没有 `location`，hub 静默禁用）。
