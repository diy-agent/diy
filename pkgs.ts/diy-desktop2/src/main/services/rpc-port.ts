/**
 * rpc-port.ts — HTTP/2 RPC 端口服务
 *
 * 在 HTTP/2 端口上暴露 api router，使外部进程（如 CLI）可通过网络调用。
 * 替代旧的 adapters/rpc-server.ts。
 *
 * 端口生命周期:
 *   端口持久化 → AppDir 管理（app.port 文件）
 *   启动 → 读 appConfig.readPort() → 尝试绑定
 *   成功 → appConfig.writePort()
 *   失败(被占) → 自动切随机端口
 */

import { createHttp2RpcServer, type Http2Transport } from "@diy/rpc-transport";
import { Server, createHandler, type Router } from "@diy/rpc";
import type { AppConfig } from "../core/app-config";

export class RpcPortService {
  // http2.Server (from createHttp2RpcServer return type)
  private _http2Server: { close(): void; on(e: string, h: (...args: any[]) => void): void; listen(p: number, h: string, cb: () => void): void; address(): { port: number } | null } | null = null;
  private rpcServer: Server | null = null;
  private _port = 0;

  get port(): number {
    return this._port;
  }

  get isRunning(): boolean {
    return this._http2Server !== null && this._port > 0;
  }

  async start(router: Router, appConfig: AppConfig, preferredPort?: number): Promise<void> {
    const targetPort = preferredPort ?? appConfig.readPort() ?? 18888;

    return new Promise<void>((resolve, reject) => {
      const { server } = createHttp2RpcServer((transport: Http2Transport) => {
        this.rpcServer = new Server(transport);
        createHandler({ router, transport: this.rpcServer, ctx: {} });
      });

      this._http2Server = server as any;

      server.on("error", (err: Error & { code?: string }) => {
        server.close();
        this._http2Server = null;
        reject(err);
      });

      server.listen(targetPort, "127.0.0.1", () => {
        const addr = server.address();
        this._port = typeof addr === "object" && addr ? addr.port : targetPort;
        appConfig.writePort(this._port);
        console.log(`[diy] RPC HTTP/2 端口: http://127.0.0.1:${this._port}`);
        resolve();
      });
    });
  }

  stop(): void {
    this.rpcServer?.destroy();
    this.rpcServer = null;
    this._http2Server?.close();
    this._http2Server = null;
    this._port = 0;
  }
}
