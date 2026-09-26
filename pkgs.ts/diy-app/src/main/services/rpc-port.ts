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
import {
  ChannelClientBinding,
  type CallOptions,
  type ClientBinding,
  type EnvelopeTransport,
  type ServerBinding,
  type StreamHandle,
} from '@diy/rpc';
import { HttpServerBinding } from '@diy/rpc/http';
import type { AppConfig } from '../core/app-config';
import { apiDef } from './api-def';

/**
 * 可替换目标的「渲染进程转发」壳。
 *
 * 为什么需要这一层：`ServerBinding.onForward` 是**一次性注册**（同名方法重复注册会由
 * 注册表显式报错），而窗口是可重建的 —— macOS 上关掉窗口 app 仍常驻，点 Dock 图标
 * （`activate`）会 new BrowserWindow，那时 webContents 全新，转发目标必须跟着换。
 * 于是注册进 RPC 注册表的是本壳，壳内的 client 由 setRendererTransport() 随时替换。
 */
class RendererForwarder implements ClientBinding {
  private client: ClientBinding | null = null;

  constructor(transport?: EnvelopeTransport) {
    if (transport) this.client = new ChannelClientBinding(transport);
  }

  /** 换到新窗口的通道（旧 renderer 已销毁，其 client 一并 dispose） */
  setTransport(transport: EnvelopeTransport): void {
    this.client?.dispose();
    this.client = new ChannelClientBinding(transport);
  }

  private get target(): ClientBinding {
    // 窗口还没建/已销毁：diy.ui.* 无家可归。明确报错，别静默挂住调用方
    if (!this.client) throw new Error('[rpc] 渲染进程通道未就绪（窗口不存在）');
    return this.client;
  }

  invoke<TReq = unknown, TRes = unknown>(
    method: string,
    params?: TReq,
    options?: CallOptions,
  ): Promise<TRes> {
    return this.target.invoke<TReq, TRes>(method, params, options);
  }

  serverStream<TReq = unknown, TYield = unknown>(
    method: string,
    params?: TReq,
    options?: CallOptions,
  ): Promise<StreamHandle<TYield>> {
    return this.target.serverStream<TReq, TYield>(method, params, options);
  }

  clientStream<TReq = unknown, TChunk = unknown, TRes = unknown>(
    method: string,
    params: TReq,
    chunks: AsyncIterable<TChunk>,
    options?: CallOptions,
  ): Promise<TRes> {
    return this.target.clientStream<TReq, TChunk, TRes>(method, params, chunks, options);
  }

  bidiStream<TReq = unknown, TChIn = unknown, TChOut = unknown>(
    method: string,
    params: TReq,
    chunks: AsyncIterable<TChIn>,
    options?: CallOptions,
  ): Promise<StreamHandle<TChOut>> {
    return this.target.bidiStream<TReq, TChIn, TChOut>(method, params, chunks, options);
  }

  dispose(): void {
    this.client?.dispose();
    this.client = null;
  }
}

export class RpcPortService {
  private _httpRaw: HttpServerBinding | null = null;
  private _http2Server: http2.Http2Server | null = null;
  private _forwarder: RendererForwarder | null = null;
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
      // diy.ui.* → Renderer 转发。经可替换壳注册：窗口重建后由 setRendererTransport() 换目标
      this._forwarder = new RendererForwarder(rendererTransport);
      this._httpRaw.onForward(apiDef.diy.ui, this._forwarder);
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

  /**
   * 把 diy.ui.* 的转发目标换到新窗口的通道（窗口重建后调用；首启不需要，start 已绑）。
   * 端口服务本身不动 —— 窗口是视图，RPC 是常驻服务，二者生命周期解耦（见 main/index.ts
   * 的 window-all-closed）。
   */
  setRendererTransport(transport: EnvelopeTransport): void {
    if (!this._forwarder) {
      // 极端情况：窗口先于 RPC 服务起来（当前不会，但别静默丢转发）
      if (!this._httpRaw) throw new Error('[rpc] RPC 服务未启动，无法绑定渲染进程通道');
      this._forwarder = new RendererForwarder(transport);
      this._httpRaw.onForward(apiDef.diy.ui, this._forwarder);
      return;
    }
    this._forwarder.setTransport(transport);
  }

  /**
   * 窗口销毁时调用：断开转发目标，让后续 diy.ui.* 调用**立即明确报错**
   * （「渲染进程通道未就绪（窗口不存在）」），而不是挂在一个已死的通道上等到超时。
   */
  clearRendererTransport(): void {
    this._forwarder?.dispose();
  }

  stop(): void {
    this._forwarder?.dispose();
    this._forwarder = null;
    this._httpRaw?.destroy();
    this._httpRaw = null;
    this._http2Server?.close();
    this._http2Server = null;
    this._port = 0;
  }
}
