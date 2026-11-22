---
desc: diy2 的传输面：命令与事件都走 /rpc（WebSocket），HTTP 只剩 /api/info 与静态
updated: 2026-11-22
---

## 现在的形状

```
浏览器 ── WS /rpc ──▶ diy2.*（命令，unary）
                     └─ room({room})（事件，server-stream）
         ── HTTP ────▶ GET /api/info（探活 / 身份）
                     └─ 静态文件（UI 产物）
```

- **REST 已删（2026-11-22）**：`/api/rooms`、`/api/bots`、`/api/drafts`、`/api/stream`（SSE）
  全部不存在了（404）。别再加回来 —— 新接口一律进 `@diy-agent/protocol/src/api.ts` 的
  `diy2Api`，服务端 `app.ts#bindDiy2Api`，客户端 `HttpChatClient`。
- `GET /api/info` **保留**：`bin/diy2` / `instances` 探活靠它（判据是自报的 `home` + `app`）。
- 客户端实现：`pkgs.ts/ui/chat-transport-http/src/{hub,index}.ts`（包名是历史遗留，里面已无 HTTP）。

## 为什么换（事故根因）

浏览器同源 HTTP/1.1 只有 **6 条并发连接**、按 profile 共用。每个对话页一条常驻 SSE，
6 页就满 —— 之后连 `POST /chat` 都发不出去（请求拿不到 socket，服务端从未收到，
界面上就是「发送中 / 执行中」永远不结束）。WS 不占这个池。

## 约束

- `/rpc` 与 HTTP 共用一个 server（`upgrade` 分流）；dev 里 vite HMR 也走 upgrade ——
  `handleUpgrade` 遇到不是自己的 path 必须返回 false、**不要动 socket**。
- 客户端 `StreamHub` 在非浏览器环境（SSR / 单测，没有 `location`）**不连、也不报错**；
  单测要命令面就注入假客户端（`store.setDiy2Client`）。
- 断线退避重连；重连后重开还活着的话题，`ready` 触发补拉快照。
- `WsTransport.close()` 与 AbortSignal 都会给服务端发 cancel 帧（流在 `finally` 里 detach）。

## 排查

- 服务端：`Diy2App.rpcStreams()` / RPC 方法 `streams` → `[{ conn, rooms, since }]`。
- 客户端：DevTools → Network → WS → `/rpc`（应当只有一条）；先 `ready`，之后才该有
  `item` / `delivery` 帧。没有 `ready` = 连接没建起来，先查端口与 `/rpc` 路由。
- dev app「实例」页展开 diy2 行也能看到同一份订阅快照（`diy.instances.streams`）。

设计记录：`docs/plans/2026-11-22-rpc-stream.md`。
