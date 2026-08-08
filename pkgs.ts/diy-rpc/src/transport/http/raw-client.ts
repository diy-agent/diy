/**
 * http/raw-client.ts — HttpRawClient：HTTP 常态绑定的客户端（第2层绑定之一）
 *
 * 与 HttpRawServer 配对的 wire 约定：
 *   unary/serverStream/notify   params 在 body；clientStream/bidi 的 params 在
 *                               header `x-diy-params`，body 是 NDJSON chunk 流
 *   单值响应  {"result": …} / 错误 {code,message,details,ext:{http:{status}}}
 *   流式响应  NDJSON：{"v"} 数据 / {"e"} 终止错误
 *   取消      AbortSignal → RST_STREAM（NGHTTP2_CANCEL）
 */

import * as http2 from 'node:http2';
import type { ClientHttp2Session, ClientHttp2Stream } from 'node:http2';
import type { StreamHandle } from '../../core/types';
import { _AsyncQueue } from '../../core/async-queue';
import { RpcError, _fromErrorPayload, type _ErrorPayload } from '../../core/error';
import type { CallOptions, RawClient } from '../../core/raw';
import { codeForHttpStatus } from './codes';

interface HttpResp {
  status: number;
  data: Buffer;
}

export class HttpRawClient implements RawClient {
  private session: ClientHttp2Session;
  private disposed = false;

  constructor(private baseUrl: string) {
    this.session = http2.connect(baseUrl);
  }

  dispose(): void {
    this.disposed = true;
    this.session.close();
  }

  /**
   * 等待 http2 会话就绪（用于探测端口可达性，连接失败回退本地客户端）。
   * 已连接立即 resolve，超时/出错 reject。
   */
  ready(timeout = 3000): Promise<void> {
    const session = this.session;
    return new Promise<void>((resolve, reject) => {
      if (session.closed || session.destroyed) {
        reject(new RpcError('UNAVAILABLE', 'Connection closed'));
        return;
      }
      if (!session.connecting) {
        resolve(); // 已连接
        return;
      }
      const t = setTimeout(() => {
        cleanup();
        reject(new RpcError('UNAVAILABLE', `Connect to ${this.baseUrl} timed out after ${timeout}ms`));
      }, timeout);
      const cleanup = () => {
        clearTimeout(t);
        session.removeListener('connect', onConnect);
        session.removeListener('error', onErr);
      };
      const onConnect = () => { cleanup(); resolve(); };
      const onErr = (e: Error) => { cleanup(); reject(e); };
      session.once('connect', onConnect);
      session.once('error', onErr);
    });
  }

  // ── unary ────────────────────────────────────────

  async invoke<TReq = unknown, TRes = unknown>(
    method: string,
    params?: TReq,
    options?: CallOptions,
  ): Promise<TRes> {
    const stream = this.request(method, 'application/json');
    stream.write(JSON.stringify(params ?? {}));
    stream.end();
    const resp = await collectResponse(stream, options);
    return parseResult<TRes>(resp);
  }

  // ── serverStream ─────────────────────────────────

  async serverStream<TReq = unknown, TYield = unknown>(
    method: string,
    params?: TReq,
    options?: CallOptions,
  ): Promise<StreamHandle<TYield>> {
    const stream = this.request(method, 'application/json');
    stream.write(JSON.stringify(params ?? {}));
    stream.end();

    const status = await firstResponseStatus(stream, options);
    if (status !== 200) {
      const data = await readAll(stream);
      throw parseError(status, data);
    }
    return createNdjsonStream(stream, options) as StreamHandle<TYield>;
  }

  // ── clientStream ─────────────────────────────────

  async clientStream<TReq = unknown, TChunk = unknown, TRes = unknown>(
    method: string,
    params: TReq,
    chunks: AsyncIterable<TChunk>,
    options?: CallOptions,
  ): Promise<TRes> {
    const { signal } = options ?? {};
    const stream = this.request(method, 'application/x-ndjson', params);

    // abort → 写取消帧 + 优雅结束（http 的 RST 无法让服务端可靠识别 client-stream 取消，
    // 用协议内的 {"__cancel":true} 帧确定性送达 CANCELLED）
    const onAbort = () => {
      try { stream.write(JSON.stringify({ __cancel: true }) + '\n'); } catch { /* ignore */ }
      try { stream.end(); } catch { /* ignore */ }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      try {
        for await (const c of chunks) {
          if (signal?.aborted) break;
          if (!stream.write(JSON.stringify(c) + '\n')) await onceDrain(stream);
        }
      } catch {
        /* 上游迭代出错则中止上传 */
      }
      if (!signal?.aborted) stream.end();

      const resp = await collectResponse(stream, options);
      return parseResult<TRes>(resp);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // ── bidi ─────────────────────────────────────────

  async bidiStream<TReq = unknown, TChIn = unknown, TChOut = unknown>(
    method: string,
    params: TReq,
    chunks: AsyncIterable<TChIn>,
    options?: CallOptions,
  ): Promise<StreamHandle<TChOut>> {
    const { signal } = options ?? {};
    const stream = this.request(method, 'application/x-ndjson', params);

    // 后台：边传 chunk 边读响应（http2 全双工）
    (async () => {
      try {
        for await (const c of chunks) {
          if (signal?.aborted) break;
          if (!stream.write(JSON.stringify(c) + '\n')) await onceDrain(stream);
        }
      } catch {
        /* ignore */
      }
      if (!signal?.aborted) stream.end();
    })();

    const status = await firstResponseStatus(stream, options);
    if (status !== 200) {
      const data = await readAll(stream);
      throw parseError(status, data);
    }
    return createNdjsonStream(stream, options) as StreamHandle<TChOut>;
  }

  // ── 内部 ─────────────────────────────────────────

  private request(method: string, contentType: string, params?: unknown): ClientHttp2Stream {
    const headers: Record<string, string> = {
      ':path': `/${method}`,
      ':method': 'POST',
      'content-type': contentType,
    };
    if (params !== undefined) headers['x-diy-params'] = JSON.stringify(params);
    return this.session.request(headers);
  }
}

// ═══════════════════════════════════════════════════
//  helpers
// ═══════════════════════════════════════════════════

function onceDrain(stream: ClientHttp2Stream): Promise<void> {
  return new Promise((r) => stream.once('drain', r));
}

/** 等响应头，返回 :status */
function firstResponseStatus(stream: ClientHttp2Stream, options?: CallOptions): Promise<number> {
  const { signal, timeout } = options ?? {};
  return new Promise<number>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      stream.removeListener('response', onResp);
      stream.removeListener('error', onErr);
      if (timer) clearTimeout(timer);
    };
    const onResp = (headers: Record<string, unknown>) => { cleanup(); resolve(Number(headers[':status'] ?? 0)); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    stream.on('response', onResp);
    stream.on('error', onErr);
    if (timeout != null && timeout > 0) {
      timer = setTimeout(() => {
        cleanup(); stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(new RpcError('TIMEOUT', `Response timed out after ${timeout}ms`));
      }, timeout);
    }
    if (signal?.aborted) {
      cleanup(); stream.close(http2.constants.NGHTTP2_CANCEL);
      reject(new RpcError('CANCELLED', 'Call aborted'));
      return;
    }
    signal?.addEventListener('abort', () => {
      cleanup(); stream.close(http2.constants.NGHTTP2_CANCEL);
      reject(new RpcError('CANCELLED', 'Call aborted'));
    }, { once: true });
  });
}

/** 读完整个响应 body */
function readAll(stream: ClientHttp2Stream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** 收集单值响应（写 body 已由调用方完成，这里只读响应） */
function collectResponse(stream: ClientHttp2Stream, options?: CallOptions): Promise<HttpResp> {
  return firstResponseStatus(stream, options).then((status) =>
    readAll(stream).then((data) => ({ status, data })),
  );
}

/** 解析单值响应：200 → result；否则抛 RpcError（保留 ext.http） */
function parseResult<T>(resp: HttpResp): T {
  if (resp.status === 200) {
    const parsed = JSON.parse(resp.data.toString() || '{}');
    return parsed.result as T;
  }
  throw parseError(resp.status, resp.data);
}

function parseError(status: number, data: Buffer): RpcError {
  let body: Partial<_ErrorPayload> = {};
  try { body = JSON.parse(data.toString() || '{}'); } catch { /* 非 JSON 错误体 */ }
  const code = body.code ?? codeForHttpStatus(status);
  return new RpcError(
    code,
    body.message ?? `HTTP ${status}`,
    { details: body.details, ext: { ...body.ext, http: { status } } },
  );
}

/** 把流式响应（NDJSON {"v"}/{"e"}）桥接成 _AsyncQueue；AbortSignal → RST_STREAM */
function createNdjsonStream(stream: ClientHttp2Stream, options?: CallOptions): _AsyncQueue<unknown> {
  const q = new _AsyncQueue<unknown>();
  let buf = '';

  stream.on('data', (c: Buffer) => {
    buf += c.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let f: { v?: unknown; e?: _ErrorPayload } | null = null;
      try { f = JSON.parse(line); } catch { continue; }
      if (!f) continue;
      if (f.e) { q.error(_fromErrorPayload(f.e)); return; }
      if ('v' in f) q.push(f.v);
    }
  });
  stream.on('end', () => q.end());
  stream.on('error', (e) => q.error(e instanceof Error ? e : new Error(String(e))));

  if (options?.signal) {
    options.signal.addEventListener('abort', () => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      q.error(new RpcError('CANCELLED', 'Call aborted'));
    }, { once: true });
  }
  return q;
}
