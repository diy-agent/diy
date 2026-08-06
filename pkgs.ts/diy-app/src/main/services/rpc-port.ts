/**
 * rpc-port.ts — HTTP/2 RPC 端口服务（HttpRawServer 路由版）
 *
 * 单例 HttpRawServer + 单例 RpcGateway，注册本地 appServer + 转发 uiForward：
 *   - 每个 http2 stream = 一个 RPC，`:path` = 方法全名（curl 可直接访问）
 *   - 所有 CLI 连接共享同一个 HttpRawServer（注册表一份），handleStream 做每请求路由
 *   - 路由归属集中在这两行 register，无 pipe 广播，方法归属一处可见
 */

import * as http2 from 'node:http2';
import { RpcGateway, RpcForward, type RpcServer } from '@diy/rpc';
import { HttpRawServer } from '@diy/rpc/http';
import type { AppConfig } from '../core/app-config';
import { apiDef } from './api-def';

export class RpcPortService {
  private _httpRaw: HttpRawServer | null = null;
  private _gateway: RpcGateway | null = null;
  private _http2Server: http2.Http2Server | null = null;
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
    appServer: RpcServer,
    appConfig: AppConfig,
    preferredPort?: number,
    rendererTransport?: import('@diy/rpc').Transport,
  ): Promise<void> {
    const targetPort = preferredPort ?? appConfig.readPort() ?? 18888;

    // diy.ui.* 转发后端（共享一个，所有 CLI 连接复用）
    const uiForward = rendererTransport
      ? new RpcForward(rendererTransport, { router: apiDef.diy.ui, scope: 'diy.ui' })
      : null;

    // 单例 HttpRawServer + 单例 gateway：注册一次，所有 stream 共享路由表
    this._httpRaw = new HttpRawServer();
    this._gateway = new RpcGateway(this._httpRaw)
      .register(appServer); // diy.app.* → Main 本地
    if (uiForward) this._gateway.register(uiForward); // diy.ui.* → Renderer

    return new Promise<void>((resolve, reject) => {
      const srv = http2.createServer();
      srv.on('stream', (stream, headers) => {
        void this._httpRaw!.handleStream(stream as http2.ServerHttp2Stream, headers);
      });

      srv.on('error', (err: Error & { code?: string }) => {
        srv.close();
        this._http2Server = null;
        reject(err);
      });

      srv.listen(targetPort, '127.0.0.1', () => {
        const addr = srv.address();
        this._port = typeof addr === 'object' && addr ? addr.port : targetPort;
        this._http2Server = srv;
        appConfig.writePort(this._port);
        console.log(`[diy] RPC HTTP/2 端口: http://127.0.0.1:${this._port}`);
        resolve();
      });
    });
  }

  stop(): void {
    this._gateway?.destroy();
    this._gateway = null;
    this._httpRaw?.destroy();
    this._httpRaw = null;
    this._http2Server?.close();
    this._http2Server = null;
    this._port = 0;
  }
}
