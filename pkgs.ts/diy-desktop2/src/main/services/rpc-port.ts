/**
 * rpc-port.ts — HTTP/2 RPC 端口服务（桥接 + 本地双模式）
 *
 * 对每个 CLI 连接同时做两件事：
 *   1. 创建 RpcServer(router) 处理 Main 侧的 method（task.*, subject.* 等）
 *   2. pipe 到 IPC transport，让 Renderer 处理自己注册的 method（component.*, page.*）
 *
 * 两边不认识的方法被各自 RpcServer 忽略，互不干扰。
 */

import { createHttp2RpcServer, type Http2Transport } from '@diy/rpc-transport';
import { RpcServer, type Transport } from '@diy/rpc';
import type { AppConfig } from '../core/app-config';

/** 传输层桥接：a 收到的消息转发给 b，b 收到的消息转发给 a */
function pipe(a: Transport, b: Transport): () => void {
  const ua = a.on((msg) => b.send(msg));
  const ub = b.on((msg) => a.send(msg));
  return () => { ua(); ub(); };
}

export class RpcPortService {
  private bridges: Array<() => void> = [];
  private servers: RpcServer[] = [];
  private _http2Server: ReturnType<typeof createHttp2RpcServer>['server'] | null = null;
  private _port = 0;

  get port(): number {
    return this._port;
  }

  get isRunning(): boolean {
    return this._http2Server !== null && this._port > 0;
  }

  /**
   * @param bindServer  Main 侧绑定工厂（bindApi），为每个 cli transport 创建已绑 handler 的 RpcServer
   * @param ipcTransport 主进程↔渲染进程的 IPC Transport（可选，用于桥接）
   */
  async start(
    bindServer: (transport: Transport) => RpcServer,
    appConfig: AppConfig,
    preferredPort?: number,
    ipcTransport?: Transport,
  ): Promise<void> {
    const targetPort = preferredPort ?? appConfig.readPort() ?? 18888;

    return new Promise<void>((resolve, reject) => {
      const { server } = createHttp2RpcServer((cliTx: Http2Transport) => {
        // 1. Main 侧 RpcServer — 处理 task.*, subject.*, agent.* 等
        const mainServer = bindServer(cliTx);
        this.servers.push(mainServer);

        // 2. Renderer 桥接 — component.*, page.* 等透传给 Renderer
        if (ipcTransport) {
          const unsub = pipe(cliTx, ipcTransport);
          this.bridges.push(unsub);
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
        console.log(`[diy] RPC HTTP/2 端口: http://127.0.0.1:${this._port}`);
        resolve();
      });
    });
  }

  stop(): void {
    for (const s of this.servers) s.destroy();
    for (const u of this.bridges) u();
    this.servers = [];
    this.bridges = [];
    this._http2Server?.close();
    this._http2Server = null;
    this._port = 0;
  }
}
