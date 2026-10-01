/**
 * websocket/index.ts — WebSocket EnvelopeTransport 实现（第1层）
 *
 * 依赖：@diy/rpc（EnvelopeTransport 类型）+ ws
 */

import type { EnvelopeTransport } from '../../core/types';

type WsLike = {
  send(data: string | Buffer): void;
  close?(): void;
  on(event: 'message', cb: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: string, cb: (...args: any[]) => void): void;
};

export class WsTransport implements EnvelopeTransport {
  private handlers = new Set<(msg: any) => void>();
  private closeHandlers = new Set<() => void>();
  /** 关闭终态幂等阀：坏帧/异常/真实 close 只触发一次 onClose */
  private closed = false;

  constructor(private ws: WsLike) {
    ws.on('message', (data: Buffer) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        // 对端坏帧（R20 P1-A）：JSON.parse 此前在 handler try/catch 之外——抛错直接
        // uncaughtException 崩进程，且传输不关闭 → 上层 pending 调用永挂。协议状态
        // 不可信：转入关闭终态并触发 onClose，ChannelClientBinding 经 onClose →
        // dispose 让在飞调用以 DISPOSED 落定。
        console.error('[WsTransport] malformed frame, closing transport:', err);
        this._shutdown();
        return;
      }
      for (const h of this.handlers) {
        try {
          const result: unknown = h(msg);
          if (result && typeof (result as any).then === 'function') {
            (result as Promise<void>).catch(err => console.error('[WsTransport] async handler error:', err));
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
    try { this.ws.close?.(); } catch { /* 已断开 */ }
    for (const cb of this.closeHandlers) {
      try { cb(); } catch { /* 单个回调异常不阻断其余 */ }
    }
    this.handlers.clear();
    this.closeHandlers.clear();
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  on(handler: (msg: any) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  onClose(cb: () => void): () => void {
    this.closeHandlers.add(cb);
    return () => { this.closeHandlers.delete(cb); };
  }
}
