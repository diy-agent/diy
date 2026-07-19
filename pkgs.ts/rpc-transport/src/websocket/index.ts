/**
 * websocket/index.ts — WebSocket Transport 实现（第1层）
 *
 * 依赖：@diy/rpc（Transport 类型）+ ws
 */

import type { Transport } from '@diy/rpc';

type WsLike = {
  send(data: string | Buffer): void;
  on(event: 'message', cb: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: string, cb: (...args: any[]) => void): void;
  removeEventListener?(event: string, cb: Function): void;
};

export class WsTransport implements Transport {
  private handlers = new Set<(msg: any) => void>();
  private closeHandlers = new Set<() => void>();

  constructor(private ws: WsLike) {
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
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

    ws.on('close', () => {
      this.closeHandlers.forEach(cb => cb());
      this.handlers.clear();
      this.closeHandlers.clear();
    });
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
