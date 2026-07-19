/**
 * http2/index.ts — HTTP/2 Transport 实现（第1层）
 *
 * 在一条长连接 HTTP/2 流上双向传输 NDJSON 信封。
 * 依赖：@diy/rpc（Transport 类型）+ node:http2
 */

import * as http2 from 'node:http2';
import type { Transport } from '@diy/rpc';

const NL = '\n'.charCodeAt(0);

export class Http2Transport implements Transport {
  private handlers = new Set<(msg: any) => void>();
  private closeHandlers = new Set<() => void>();
  private buf = '';

  constructor(
    private stream: http2.ClientHttp2Stream | http2.ServerHttp2Stream,
  ) {
    stream.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString();
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'undefined') continue;

        let msg: any;
        try { msg = JSON.parse(line); } catch {
          console.error('[Http2Transport] invalid JSON:', line);
          continue;
        }

        for (const h of this.handlers) {
          try {
            const result: unknown = h(msg);
            if (result && typeof (result as any).then === 'function')
              (result as Promise<void>).catch(err => console.error('[Http2Transport] async handler error:', err));
          } catch (err) {
            console.error('[Http2Transport] handler error:', err);
          }
        }
      }
    });

    stream.on('close', () => {
      this.closeHandlers.forEach(cb => cb());
      this.handlers.clear();
      this.closeHandlers.clear();
    });
  }

  send(payload: unknown): void {
    this.stream.write(JSON.stringify(payload) + '\n');
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

export function createHttp2RpcServer(
  onTransport: (transport: Http2Transport) => void,
): { server: http2.Http2Server; port: () => number } {
  const server = http2.createServer();

  server.on('stream', (stream: any, headers) => {
    if (headers[':path'] === '/rpc') {
      stream.respond({ ':status': 200 });
      const transport = new Http2Transport(stream);
      onTransport(transport);
    } else {
      stream.respond({ ':status': 404 });
      stream.end();
    }
  });

  return {
    server,
    port: () => (server.address() as any).port,
  };
}

export async function connectHttp2Rpc(
  port: number,
  host = '127.0.0.1',
): Promise<Http2Transport> {
  const session = http2.connect(`http://${host}:${port}`);

  // session 连接失败会触发 error 事件，转为 promise reject
  const sessionError = new Promise<never>((_, reject) => {
    session.once('error', reject);
  });

  const stream = session.request({
    ':path': '/rpc',
    ':method': 'POST',
  });

  const transport = new Http2Transport(stream);

  await Promise.race([
    sessionError,
    new Promise<void>((resolve, reject) => {
      stream.once('response', (headers) => {
        if (headers[':status'] === 200) resolve();
        else reject(new Error(`HTTP ${headers[':status']}`));
      });
      stream.once('error', reject);
    }),
  ]);

  return transport;
}
