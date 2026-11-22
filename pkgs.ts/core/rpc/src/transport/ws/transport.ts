/**
 * websocket/transport.ts — WebSocket EnvelopeTransport 实现（第1层）
 *
 * 只依赖 `./types`（WsLike），**不碰 Node**：Node `ws` 与浏览器 `WebSocket`
 * （经 `./browser` 适配）共用这一个实现。
 *
 * 坏帧 = 关闭终态：JSON 解析失败若继续运行，传输层还活着而上层 pending 调用永挂；
 * 所以这里转入关闭终态并触发 `onClose`，让在飞调用以 DISPOSED 落定（R20 P1-A）。
 */

import type { EnvelopeTransport } from '../../core/types.js';
import type { WsLike } from './types.js';

export type { WsLike, WsMessage } from './types.js';

export class WsTransport implements EnvelopeTransport {
  private handlers = new Set<(msg: any) => void>();
  private closeHandlers = new Set<() => void>();
  /** 关闭终态幂等阀：坏帧/异常/真实 close 只触发一次 onClose */
  private closed = false;

  constructor(private ws: WsLike) {
    ws.on('message', (data: { toString(): string }) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.error('[WsTransport] malformed frame, closing transport:', err);
        this._shutdown();
        return;
      }
      for (const h of this.handlers) {
        try {
          const result: unknown = h(msg);
          if (result && typeof (result as any).then === 'function') {
            (result as Promise<void>).catch((err) =>
              console.error('[WsTransport] async handler error:', err),
            );
          }
        } catch (err) {
          console.error('[WsTransport] handler error:', err);
        }
      }
    });

    // socket 层错误同样转入关闭终态：无监听的 'error' 事件本身也会 uncaughtException（R20 P1-A 同族）
    ws.on('error', (err: unknown) => {
      console.error('[WsTransport] socket error, closing transport:', err);
      this._shutdown();
    });

    ws.on('close', () => {
      this._shutdown();
    });
  }

  /** 关闭终态（幂等）：尽力关 socket + 触发 onClose → 上层 dispose；监听器随终态清空 */
  private _shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close?.();
    } catch {
      /* 已断开 */
    }
    for (const cb of this.closeHandlers) {
      try {
        cb();
      } catch {
        /* 单个回调异常不阻断其余 */
      }
    }
    this.handlers.clear();
    this.closeHandlers.clear();
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  /**
   * 主动关闭：浏览器里切标签页 / 重连前必须能释放这条连接
   * （6 连接上限是按 profile 算的，留着一条死连接就是占额度）。
   */
  close(): void {
    this._shutdown();
  }

  on(handler: (msg: any) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onClose(cb: () => void): () => void {
    this.closeHandlers.add(cb);
    return () => {
      this.closeHandlers.delete(cb);
    };
  }
}
