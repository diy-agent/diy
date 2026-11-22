---
desc: diy2 的事件流传输：命令走 REST、事件走 RPC/WebSocket；旧 SSE 仍在（过渡期）
updated: 2026-11-22
---

## 现在的形状

- **命令**（send / answer / cancel / CRUD）：REST `/api/**`，客户端是 `HttpChatClient`。
- **事件流**：一条 **WebSocket `/rpc`**（`@diy-agent/rpc`），房间是这条连接上的 server-stream。
  客户端在 `chat-transport-http/src/hub.ts`：先 `connectWs`，再按话题开流；每条流首帧
  `{ kind: 'ready' }`（触发上层补拉快照）。
- 旧 SSE `/api/stream` **仍在**（回退用），新客户端已经不用它。

## 为什么换

浏览器同源 HTTP/1.1 只有 **6 条并发连接**、按 profile 共用。每个对话页一条常驻 SSE，
6 页就满 —— 之后 **`POST /chat` 都发不出去**（请求拿不到 socket，服务端从未收到，
界面上就是「发送中 / 执行中」永远不结束）。WS 不占这个池。

## 约束

- `/rpc` 与 HTTP 共用一个 server（`upgrade` 分流）；dev 里 vite HMR 也走 upgrade ——
  `handleUpgrade` 遇到不是自己的 path 必须返回 false、**不要动 socket**。
- 客户端 `StreamHub` 在非浏览器环境（SSR / 单测，没有 `location`）**不连、也不报错**。
- 断线退避重连；重连后重开还活着的话题，`ready` 触发补拉快照。
- `WsTransport.close()` 与 AbortSignal 都会给服务端发 cancel 帧（流在 `finally` 里 detach）。

## 排查

- 服务端：`Diy2App.rpcStreams()` / RPC 方法 `streams` → `[{ conn, rooms, since }]`。
- 客户端：DevTools → Network → WS → `/rpc`（应当只有一条）；先 `ready`，之后才该有
  `item` / `delivery` 帧。没有 `ready` = 连接没建起来，先查端口与 `/rpc` 路由。

设计记录：`docs/plans/2026-11-22-rpc-stream.md`。
