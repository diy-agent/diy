/**
 * ws/types.ts —— WebSocket 的最小形状（**不依赖 Node**）。
 *
 * 浏览器 `WebSocket` 与 Node `ws` 都能适配成它：
 *   · Node `ws`：原生就是这个形状（`on('message', (data, isBinary) => …)`）；
 *   · 浏览器：见 `./browser` 的 `wsLikeOf()`（`addEventListener` → `on`，ArrayBuffer → 文本）。
 *
 * 单独一个文件是为了让 `tsconfig.browser.json` 能在 `types: []` 下编译 —— 这里不能出现
 * `Buffer` / `node:*`，否则浏览器构建直接失败。
 */

export type WsMessage = {
  /** 文本帧的内容；`WsTransport` 只调 `.toString()`，所以不要求真 Buffer */
  toString(): string;
};

export interface WsLike {
  /** 发送一帧（文本 / 二进制都允许；上层传的是 JSON 字符串） */
  send(data: string | Uint8Array): void;
  /** 主动关闭；已断开时允许省略或抛错（由实现决定） */
  close?(): void;
  /** 事件订阅。`WsTransport` 只用到 `message` / `close` / `error` */
  on(event: string, cb: (...args: any[]) => void): void;
}
