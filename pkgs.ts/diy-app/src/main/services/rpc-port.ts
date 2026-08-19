/**
 * rpc-port.ts — HTTP/2 RPC 端口服务（HttpServerBinding 直编版）
 *
 * 单例 HttpServerBinding，本地 appServer + 转发 uiForward 直接 registerInto 共享它：
 *   - 每个 http2 stream = 一个 RPC，`:path` = 方法全名（curl 可直接访问）
 *   - 所有 CLI 连接共享同一个 HttpServerBinding（注册表一份），handleStream 做每请求路由
 *   - 路由归属 = binding 的 method→handler 表：diy.* 本地处理，diy.ui.* 转发 Renderer
 *   - 方法名冲突由 binding 层重复注册检查显式报错（scope 冲突的实质）
 */

import * as http2 from 'node:http2';
import { ChannelClientBinding, type ServerBinding } from '@diy/rpc';
import { HttpServerBinding } from '@diy/rpc/http';
import type { AppConfig } from '../core/app-config';
import { apiDef } from './api-def';

export class RpcPortService {
  private _httpRaw: HttpServerBinding | null = null;
  private _http2Server: http2.Http2Server | null = null;
  private _port = 0;

  get port(): number {
    return this._port;
  }

  get isRunning(): boolean {
    return this._http2Server !== null && this._port > 0;
  }

  /**
   * @param bindApp    Main 侧 handler 绑定函数（bindAppHandlers，把 diy.* 绑到传入 binding）
   * @param appConfig    端口配置
   * @param preferredPort 首选端口
   * @param rendererTransport 主进程↔渲染进程 IPC EnvelopeTransport（可选，用于 diy.ui 转发）
   */
  async start(
    bindApp: (binding: ServerBinding) => void,
    appConfig: AppConfig,
    preferredPort?: number,
    rendererTransport?: import('@diy/rpc').EnvelopeTransport,
  ): Promise<void> {
    const targetPort = preferredPort ?? appConfig.readPort() ?? 18888;

    // 单例 HttpServerBinding：本地 handler + 转发 diy.ui.* 直接共享注册表
    this._httpRaw = new HttpServerBinding();
    bindApp(this._httpRaw); // diy.* → Main 本地
    if (rendererTransport) {
      this._httpRaw.onForward(apiDef.diy.ui, new ChannelClientBinding(rendererTransport)); // diy.ui.* → Renderer 转发
    }

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
    this._httpRaw?.destroy();
    this._httpRaw = null;
    this._http2Server?.close();
    this._http2Server = null;
    this._port = 0;
  }
}
