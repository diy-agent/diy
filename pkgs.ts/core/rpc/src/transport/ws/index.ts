/**
 * websocket/index.ts — Node 侧的 WebSocket 入口。
 *
 * Node 的 `ws` 的 socket 原生满足 `WsLike`（`on('message', (data, isBinary) => …)`），
 * 直接把连接丢给 `WsTransport` 即可：
 *
 * ```ts
 * server.on('connection', (ws) => new ChannelServerBinding(new WsTransport(ws)));
 * ```
 *
 * 浏览器没有 `on()`，用 `@diy-agent/rpc/ws/browser` 的 `wsLikeOf()` / `connectWs()`
 * 包一层 —— 协议、传输实现（`./transport`）完全共用。
 */

export { WsTransport } from './transport.js';
export type { WsLike, WsMessage } from './types.js';
