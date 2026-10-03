/**
 * rpc-port.ts — HTTP/2 RPC 端口服务（HttpServerBinding 直编版）
 *
 * 单例 HttpServerBinding，本地 appServer + 转发 uiForward 直接 registerInto 共享它：
 *   - 每个 http2 stream = 一个 RPC，`:path` = 方法全名（curl 可直接访问）
 *   - 所有 CLI 连接共享同一个 HttpServerBinding（注册表一份），handleStream 做每请求路由
 *   - 路由归属 = binding 的 method→handler 表：diy.* 本地处理，diy.ui.* 转发 Renderer
 *   - 方法名冲突由 binding 层重复注册检查显式报错（scope 冲突的实质）
 *   - `:path === '/cli'` = 嵌入式 CLI 端点（任务 223 性能原型）：进程内跑同一份
 *     CliApp（Channel 传输 → 本进程 binding），输出/退出经注入 writer 收集后
 *     以 {body=out, x-diy-exit, x-diy-err} 返回 —— bash+curl 即可调用，免 node 启动。
 */

import * as http2 from 'node:http2';
import {
  ChannelClientBinding,
  ChannelServerBinding,
  createMemTransportPair,
  type CallOptions,
  type ClientBinding,
  type EnvelopeTransport,
  type ServerBinding,
  type StreamHandle,
} from '@diy/rpc';
import { HttpServerBinding } from '@diy/rpc/http';
import { CliApp } from '@diy/rpc/cli';
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
  /** /cli 端点的进程内客户端（与 _httpRaw 同一套 handler，经 mem channel 直连） */
  private _cliClient: ClientBinding | null = null;
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

    // /cli 嵌入式端点的进程内通道：与 _httpRaw **同一套 handler 再挂一份**到
    // ChannelServerBinding（mem transport），客户端 CliApp 走它 = 不出进程。
    // 共享同一个 RendererForwarder 实例：窗口重建换目标时 /cli 同步生效。
    const { serverTx, clientTx } = createMemTransportPair();
    const cliServer = new ChannelServerBinding(serverTx);
    bindApp(cliServer);
    if (this._forwarder) cliServer.onForward(apiDef.diy.ui, this._forwarder);
    this._cliClient = new ChannelClientBinding(clientTx);

    return new Promise<void>((resolve, reject) => {
      const srv = http2.createServer();
      srv.on('stream', (stream, headers) => {
        if (headers[':path'] === '/cli') {
          void this._handleCli(stream as http2.ServerHttp2Stream);
          return;
        }
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


  // ── /cli：嵌入式 CLI 端点（任务 223 性能原型）────────────────────────
  //
  // 请求：POST /cli  body = {"argv":["task","list"],"cwd":"/..."}
  // 响应：200，body = stdout 原始字节（curl 直接透传 → 管道天然可用），
  //       header x-diy-exit = 退出码，x-diy-err = stderr 的 base64（错误短文本）。
  // 语义与直连 CLI 对齐：进程内跑**同一份 CliApp**（仅 transport 换 Channel），
  // out/err/exit 由 CliAppConfig 注入收集 —— 输出格式化零复刻、零漂移。
  private async _handleCli(stream: http2.ServerHttp2Stream): Promise<void> {
    try {
      const raw = await readAllBody(stream);
      let req: { argv?: unknown; cwd?: unknown } = {};
      try {
        req = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        stream.respond({ ':status': 400, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ error: 'bad-json' }));
        return;
      }
      if (!Array.isArray(req.argv) || !req.argv.every((a) => typeof a === 'string')) {
        stream.respond({ ':status': 400, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ error: 'argv must be string[]' }));
        return;
      }
      const { code, out, err } = await this._runCli(req.argv as string[], req.cwd);
      const headers: Record<string, string> = {
        ':status': '200',
        'content-type': 'application/octet-stream',
        'x-diy-exit': String(code),
      };
      if (err) headers['x-diy-err'] = Buffer.from(err, 'utf8').toString('base64');
      stream.respond(headers);
      stream.end(out);
    } catch (e) {
      // 响应前崩溃：500 JSON（curl 非 0 → 调用方回退直连 CLI）
      try {
        stream.respond({ ':status': 500, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      } catch {
        /* 流已死 */
      }
    }
  }

  /** 进程内执行一次 CLI：收集 out/err/exit。退出语义经 config.exit 抛 CliExit 承接。 */
  private async _runCli(
    argv: string[],
    cwdRaw: unknown,
  ): Promise<{ code: number; out: string; err: string }> {
    if (!this._cliClient) return { code: 64, out: '', err: 'cli-binding 未初始化' };
    class CliExit extends Error {
      constructor(public readonly exitCode: number) {
        super('cli-exit');
      }
    }
    const outBuf: string[] = [];
    const errBuf: string[] = [];
    let code = 0;
    try {
      const app = new CliApp({
        name: 'diy',
        version: '0.1.0', // 与 src/cli/index.ts main() 保持一致
        router: apiDef.diy,
        transport: this._cliClient,
        cwd: typeof cwdRaw === 'string' && cwdRaw ? cwdRaw : process.cwd(),
        // 契约：hook 参数 = console.log 同参（不含换行），故这里补 \n 以对齐直连字节
        out: (line) => outBuf.push(line, '\n'),
        err: (line) => errBuf.push(line, '\n'),
        exit: (c) => {
          throw new CliExit(c);
        },
      });
      await app.parse(argv);
    } catch (e) {
      if (e instanceof CliExit) {
        code = e.exitCode;
      } else {
        code = 1;
        errBuf.push(`致命错误: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    return { code, out: outBuf.join(''), err: errBuf.join('') };
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
    this._cliClient = null;
    this._forwarder?.dispose();
    this._forwarder = null;
    this._httpRaw?.destroy();
    this._httpRaw = null;
    this._http2Server?.close();
    this._http2Server = null;
    this._port = 0;
  }
}

/** 读完整请求体（/cli 端点用；@diy/rpc/http 的 readBody 未导出，这里最小实现） */
function readAllBody(stream: http2.ServerHttp2Stream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
    stream.once('aborted', () => reject(new Error('client aborted')));
  });
}
