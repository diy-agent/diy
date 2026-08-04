/**
 * rpc-port.ts — HTTP/2 RPC 端口服务（RpcGateway 路由版）
 *
 * 对每个 CLI 连接创建一个 RpcGateway，绑定来源 cliTx：
 *   - 注册本地后端 appServer（diy.app.*，Main 进程直接处理）
 *   - 注册转发后端 uiForward（diy.ui.*，经 ipcTransport 转发到 Renderer）
 *
 * 路由归属集中在这两行 register，无 pipe 广播，方法归属一处可见。
 */

import { createHttp2RpcServer, type Http2Transport } from '@diy/rpc-transport';
import { RpcGateway, RpcForward } from '@diy/rpc';
import type { AppConfig } from '../core/app-config';
import { apiDef } from './api-def';

export class RpcPortService {
  private gateways: RpcGateway[] = [];
  private _http2Server: ReturnType<typeof createHttp2RpcServer>['server'] | null = null;
  private _port = 0;

  get port(): number {
    return this._port;
  }

  get isRunning(): boolean {
    return this._http2Server !== null && this._port > 0;
  }

  /**
   * @param appServer    Main 侧本地 handler 注册表（createAppServer()，scope diy.app）
   * @param appConfig    端口配置
   * @param preferredPort 首选端口
   * @param rendererTransport 主进程↔渲染进程 IPC Transport（可选，用于 diy.ui 转发）
   */
  async start(
    appServer: import('@diy/rpc').RpcServer,
    appConfig: AppConfig,
    preferredPort?: number,
    rendererTransport?: import('@diy/rpc').Transport,
  ): Promise<void> {
    const targetPort = preferredPort ?? appConfig.readPort() ?? 18888;

    // diy.ui.* 转发后端（共享一个，所有 CLI 连接复用）
    const uiForward = rendererTransport
      ? new RpcForward(rendererTransport, { router: apiDef.diy.ui, scope: 'diy.ui' })
      : null;

    return new Promise<void>((resolve, reject) => {
      const { server } = createHttp2RpcServer((cliTx: Http2Transport) => {
        const gateway = new RpcGateway(cliTx)
          .register(appServer); // diy.app.* → Main 本地
        if (uiForward) gateway.register(uiForward); // diy.ui.* → Renderer
        this.gateways.push(gateway);
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
    for (const g of this.gateways) g.destroy();
    this.gateways = [];
    this._http2Server?.close();
    this._http2Server = null;
    this._port = 0;
  }
}
