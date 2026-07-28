/**
 * rpc-port.ts — HTTP/2 RPC 端口服务（桥接模式）
 *
 * 不再创建独立的 RpcServer，而是将 HTTP/2 传输层 pipe 到 IPC 传输层。
 * CLI 的 RPC 调用通过 pipe 透明到达 Renderer 和 Main 的 RpcServer。
 *
 * 架构:
 *   CLI ──HTTP/2──→ Main Process ──pipe──→ IPC Transport
 *                                             ├── Main RpcServer(api)
 *                                             └── Renderer RpcServer(rendererApi)
 */

import { createHttp2RpcServer, type Http2Transport } from '@diy/rpc-transport';
import type { Transport } from '@diy/rpc';
import type { AppConfig } from '../core/app-config';

/** 传输层桥接：a 收到的消息转发给 b，b 收到的消息转发给 a */
function pipe(a: Transport, b: Transport): () => void {
  const ua = a.on((msg) => b.send(msg));
  const ub = b.on((msg) => a.send(msg));
  return () => { ua(); ub(); };
}

export class RpcPortService {
  private bridges: Array<{ unsub: () => void; close(): void }> = [];
  private _http2Server: ReturnType<typeof createHttp2RpcServer>['server'] | null = null;
  private _port = 0;

  get port(): number {
    return this._port;
  }

  get isRunning(): boolean {
    return this._http2Server !== null && this._port > 0;
  }

  /**
   * @param ipcTransport 主进程↔渲染进程的 IPC Transport，用于桥接
   */
  async start(
    appConfig: AppConfig,
    preferredPort?: number,
    ipcTransport?: Transport,
  ): Promise<void> {
    const targetPort = preferredPort ?? appConfig.readPort() ?? 18888;

    return new Promise<void>((resolve, reject) => {
      const { server } = createHttp2RpcServer((cliTx: Http2Transport) => {
        if (ipcTransport) {
          // 桥接模式：CLI 的 transport 直通 IPC transport
          const unsub = pipe(cliTx, ipcTransport);
          this.bridges.push({
            unsub,
            close: () => cliTx.close(),
          });
        }
      });

      this._http2Server = server as any;

      server.on('error', (err: Error & { code?: string }) => {
        server.close();
        this._http2Server = null;
        reject(err);
      });

      server.listen(targetPort, '127.0.0.1', () => {
        const addr = server.address();
        this._port = typeof addr === 'object' && addr ? addr.port : targetPort;
        appConfig.writePort(this._port);
        console.log(`[diy] RPC HTTP/2 端口: http://127.0.0.1:${this._port} (桥接模式)`);
        resolve();
      });
    });
  }

  stop(): void {
    for (const b of this.bridges) {
      b.unsub();
      b.close();
    }
    this.bridges = [];
    this._http2Server?.close();
    this._http2Server = null;
    this._port = 0;
  }
}
