/**
 * websocket/browser.ts —— 浏览器 WebSocket → WsLike 适配 + 建连助手。
 *
 * 浏览器与 Node `ws` 的 API 差异只有三处：
 *   1. 事件：`addEventListener('message' | 'close' | 'error')` vs `on(event, cb)`
 *   2. 帧：浏览器给 `string | ArrayBuffer`（`binaryType` 默认是 `blob`，blob 只能异步读，
 *      会打乱帧顺序 —— 所以这里强制 `arraybuffer`，同步 `TextDecoder` 解码）
 *   3. 开连接没有 `once('open')`：要自己等 open / error / 超时
 *
 * 协议本身（帧格式、请求 id、流）与 Node 完全一致 —— 复用 `./transport` 的 `WsTransport`。
 *
 * 用法：
 * ```ts
 * const transport = new WsTransport(await connectWs('/rpc', { timeoutMs: 5000 }));
 * const client = new ChannelClientBinding(transport);
 * ```
 * 相对 URL 由调用方拼成绝对地址（`new WebSocket` 在浏览器里接受相对路径，Node 测试里不行）。
 */

import { WsTransport, type WsLike } from './transport.js';

export type { WsLike, WsMessage } from './types.js';
export { WsTransport } from './transport.js';

/** 把一条已经建好的浏览器 WebSocket 包成 WsLike（不改变协议，只补形状） */
export function wsLikeOf(socket: WebSocket): WsLike {
  // blob 只能异步读：一异步，相邻两帧的先后就乱了。同步解码必须用 arraybuffer。
  socket.binaryType = 'arraybuffer';
  const decoder = new TextDecoder();

  return {
    send(data) {
      socket.send(typeof data === 'string' ? data : decoder.decode(data));
    },
    close() {
      socket.close();
    },
    on(event, cb) {
      switch (event) {
        case 'message':
          socket.addEventListener('message', (message: MessageEvent) => {
            const data: unknown = message.data;
            const text = typeof data === 'string' ? data : decoder.decode(data as ArrayBuffer);
            // 第二个参数（isBinary）是 Node ws 的签名；WsTransport 不看它
            cb({ toString: () => text }, false);
          });
          return;
        case 'close':
          socket.addEventListener('close', () => cb());
          return;
        case 'error':
          socket.addEventListener('error', () => cb(new Error('websocket error')));
          return;
        default:
          // WsTransport 只用 message / close / error；别的事件没有对应物，静默忽略
          return;
      }
    },
  };
}

export interface ConnectWsOptions {
  /** 子协议（宿主按子协议分流时用） */
  protocols?: string | string[];
  /** 建连超时，缺省 10s；超时会主动 close */
  timeoutMs?: number;
}

/**
 * 建连并等到 `open`，返回可直接喂给 `WsTransport` 的 WsLike。
 *
 * 失败（error / 超时）一律 reject —— 调用方负责退避重连，这里不藏循环。
 */
export function connectWs(url: string, options: ConnectWsOptions = {}): Promise<WsLike> {
  const { protocols, timeoutMs = 10_000 } = options;
  const socket = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);

  return new Promise<WsLike>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* 已经关了 */
      }
      reject(new Error(`websocket 建连超时（${timeoutMs}ms）：${url}`));
    }, timeoutMs);

    socket.addEventListener(
      'open',
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(wsLikeOf(socket));
      },
      { once: true },
    );

    socket.addEventListener(
      'error',
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`websocket 建连失败：${url}`));
      },
      { once: true },
    );
  });
}
