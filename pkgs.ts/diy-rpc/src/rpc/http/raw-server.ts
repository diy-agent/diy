/**
 * http/raw-server.ts — HttpRawServer：HTTP 常态绑定的服务端（第2层绑定之一）
 *
 * 每个 http2 stream = 一个 RPC：`:path` 即方法全名（/diy.app.task.list），
 * 按协议常态实现四种语义 + notify，curl 可直接访问。
 *
 * wire 约定（JSON，无 protobuf）：
 *   unary/serverStream/notify   params 在请求 body（JSON）；clientStream/bidi 的
 *                               params 在 header `x-diy-params`，body 是 NDJSON chunk 流
 *   单值响应  {"result": …}                    200 + application/json
 *   错误响应  {code,message,details,ext:{http:{status}}}   映射后的 HTTP 状态
 *   流式响应  NDJSON：{"v": <chunk>} 数据帧 / {"e": {…}} 终止错误帧
 *   通知      204，无 body
 *   取消      server-stream：客户端 RST_STREAM（http2 原生流取消）
 *             client-stream：客户端写保留帧 {"__cancel":true} 再 end（http 的 RST
 *             无法让服务端可靠识别 client-stream 取消，用协议内取消帧确定性送达 CANCELLED）
 *             （注意：__cancel 是保留帧键，业务 chunk 不应使用）
 *
 * 单例 + handleStream：注册表启动时建一次，所有 stream 共享；每请求状态
 * （读 body / 写响应 / 取消）都是 handleStream 调用栈里的局部量。
 */

import type { ServerHttp2Stream, IncomingHttpHeaders } from 'node:http2';
import type { StreamHandle } from '../../transport/types';
import { AsyncQueue } from '../async-queue';
import { RpcError, toErrorPayload, type ErrorPayload } from '../error';
import { httpStatusForCode } from './codes';
import type { RawServer } from '../raw';

type UnaryHandler = (params: unknown) => unknown;
type ServerStreamHandler = (params: unknown) => AsyncGenerator<unknown>;
type ClientStreamHandler = (params: unknown, chunks: StreamHandle<unknown>) => Promise<unknown>;
type BidiStreamHandler = (params: unknown, incoming: StreamHandle<unknown>) => AsyncGenerator<unknown>;
type NotifyHandler = (params: unknown) => void | Promise<void>;

export class HttpRawServer implements RawServer {
  private _unaries = new Map<string, UnaryHandler>();
  private _serverStreams = new Map<string, ServerStreamHandler>();
  private _clientStreams = new Map<string, ClientStreamHandler>();
  private _bidiStreams = new Map<string, BidiStreamHandler>();
  private _notifies = new Map<string, NotifyHandler>();

  onUnary<TReq = unknown, TRes = unknown>(name: string, fn: (params: TReq) => TRes | Promise<TRes>) {
    this._unaries.set(name, fn as UnaryHandler);
  }

  onServerStream<TReq = unknown, TYield = unknown>(name: string, fn: (params: TReq) => AsyncGenerator<TYield>) {
    this._serverStreams.set(name, fn as ServerStreamHandler);
  }

  onClientStream<TReq = unknown, TChunk = unknown, TRes = unknown>(
    name: string,
    fn: (params: TReq, chunks: StreamHandle<TChunk>) => TRes | Promise<TRes>,
  ) {
    this._clientStreams.set(name, fn as ClientStreamHandler);
  }

  onBidiStream<TReq = unknown, TChIn = unknown, TChOut = unknown>(
    name: string,
    fn: (params: TReq, incoming: StreamHandle<TChIn>) => AsyncGenerator<TChOut>,
  ) {
    this._bidiStreams.set(name, fn as BidiStreamHandler);
  }

  onNotify<TReq = unknown>(name: string, fn: (params: TReq) => void | Promise<void>) {
    this._notifies.set(name, fn as NotifyHandler);
  }

  destroy(): void {
    this._unaries.clear();
    this._serverStreams.clear();
    this._clientStreams.clear();
    this._bidiStreams.clear();
    this._notifies.clear();
  }

  // ── 每请求入口 ──────────────────────────────────

  async handleStream(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): Promise<void> {
    const method = String(headers[':path'] ?? '').replace(/^\//, '');

    if (this._unaries.has(method)) return this._handleUnary(stream, method);
    if (this._serverStreams.has(method)) return this._handleServerStream(stream, method);
    if (this._clientStreams.has(method)) return this._handleClientStream(stream, method, headers);
    if (this._bidiStreams.has(method)) return this._handleBidiStream(stream, method, headers);
    if (this._notifies.has(method)) return this._handleNotify(stream, method);

    // 未注册 → UNIMPLEMENTED
    respondError(stream, toErrorPayload(new RpcError('UNIMPLEMENTED', `No handler for "${method}"`)));
  }

  // ── Unary ────────────────────────────────────────

  private async _handleUnary(stream: ServerHttp2Stream, method: string): Promise<void> {
    const fn = this._unaries.get(method)!;
    try {
      const body = await readBody(stream);
      respondResult(stream, await fn(parseBodyParams(body)));
    } catch (e) {
      respondError(stream, e);
    }
  }

  // ── Server-Stream ────────────────────────────────

  private async _handleServerStream(stream: ServerHttp2Stream, method: string): Promise<void> {
    const fn = this._serverStreams.get(method)!;
    let g: AsyncGenerator<unknown>;
    try {
      const body = await readBody(stream);
      g = fn(parseBodyParams(body));
    } catch (e) {
      respondError(stream, e);
      return;
    }

    stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
    let aborted = false;
    const onClose = () => { aborted = true; void g.return?.(undefined); };
    stream.on('close', onClose);

    try {
      for await (const v of g) {
        if (aborted) break;
        safeWrite(stream, JSON.stringify({ v }) + '\n');
      }
      if (!aborted) safeEnd(stream);
    } catch (e) {
      if (!aborted) {
        safeWrite(stream, JSON.stringify({ e: toErrorPayload(e) }) + '\n');
        safeEnd(stream);
      }
    } finally {
      stream.removeListener('close', onClose);
    }
  }

  // ── Client-Stream ────────────────────────────────

  private async _handleClientStream(
    stream: ServerHttp2Stream,
    method: string,
    headers: IncomingHttpHeaders,
  ): Promise<void> {
    const fn = this._clientStreams.get(method)!;
    const params = paramsFromHeader(headers);
    const incoming = createBodyReader(stream);

    try {
      respondResult(stream, await fn(params, incoming));
    } catch (e) {
      respondError(stream, e);
    }
  }

  // ── Bidi-Stream ──────────────────────────────────

  private async _handleBidiStream(
    stream: ServerHttp2Stream,
    method: string,
    headers: IncomingHttpHeaders,
  ): Promise<void> {
    const fn = this._bidiStreams.get(method)!;
    const params = paramsFromHeader(headers);
    const incoming = createBodyReader(stream);

    stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
    let aborted = false;
    const onClose = () => { aborted = true; };
    stream.on('close', onClose);

    try {
      for await (const out of fn(params, incoming)) {
        if (aborted) break;
        safeWrite(stream, JSON.stringify({ v: out }) + '\n');
      }
      if (!aborted) safeEnd(stream);
    } catch (e) {
      if (!aborted) {
        safeWrite(stream, JSON.stringify({ e: toErrorPayload(e) }) + '\n');
        safeEnd(stream);
      }
    } finally {
      stream.removeListener('close', onClose);
    }
  }

  // ── Notify ───────────────────────────────────────

  private async _handleNotify(stream: ServerHttp2Stream, method: string): Promise<void> {
    const fn = this._notifies.get(method)!;
    try {
      const body = await readBody(stream);
      await fn(parseBodyParams(body));
      stream.respond({ ':status': 204 });
      stream.end();
    } catch (e) {
      respondError(stream, e);
    }
  }
}

// ═══════════════════════════════════════════════════
//  请求/响应 helpers
// ═══════════════════════════════════════════════════

/** 读取完整请求 body；客户端中断（aborted/close/error）→ reject（CANCELLED） */
function readBody(stream: ServerHttp2Stream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let ended = false;
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('aborted', onAbort);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onErr);
    };
    const onData = (c: Buffer) => { if (!ended) chunks.push(c); };
    const onEnd = () => { ended = true; cleanup(); resolve(Buffer.concat(chunks)); };
    const onAbort = () => { if (!ended) { cleanup(); reject(new RpcError('CANCELLED', 'Client disconnected')); } };
    const onClose = () => { if (!ended) { cleanup(); reject(new RpcError('CANCELLED', 'Client disconnected')); } };
    const onErr = () => { if (!ended) { cleanup(); reject(new RpcError('CANCELLED', 'Client disconnected')); } };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('aborted', onAbort);
    stream.on('close', onClose);
    stream.on('error', onErr);
  });
}

function parseBodyParams(body: Buffer): unknown {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return {};
  }
}

/** 把请求 body 的 NDJSON chunk 流桥接成 AsyncQueue（StreamHandle） */
function createBodyReader(stream: ServerHttp2Stream): AsyncQueue<unknown> {
  const q = new AsyncQueue<unknown>();
  let buf = '';
  let finished = false;

  stream.on('data', (c: Buffer) => {
    buf += c.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const v = JSON.parse(line);
        // 保留帧：客户端取消 → incoming 以 CANCELLED 收尾（http 的 RST 服务端不可靠）
        if (v !== null && typeof v === 'object' && (v as { __cancel?: boolean }).__cancel === true) {
          q.error(new RpcError('CANCELLED', 'Client cancelled'));
          return;
        }
        q.push(v);
      } catch { /* 跳过非法行 */ }
    }
  });
  const onEnd = () => { finished = true; q.end(); };
  const onAbort = () => { if (!finished) q.error(new RpcError('CANCELLED', 'Request aborted')); };
  stream.on('end', onEnd);
  stream.on('aborted', onAbort);
  stream.on('close', () => { if (!finished) q.error(new RpcError('CANCELLED', 'Request closed')); });
  return q;
}

/** clientStream/bidi 的初始 params 从 header 取（body 全是 chunk 帧） */
function paramsFromHeader(headers: IncomingHttpHeaders): unknown {
  const raw = headers['x-diy-params'];
  if (raw == null) return {};
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

/** 写入流（客户端已断开时静默忽略，避免未处理 rejection） */
function safeWrite(stream: ServerHttp2Stream, data: string): void {
  try { stream.write(data); } catch { /* ignore */ }
}

function safeEnd(stream: ServerHttp2Stream): void {
  try { stream.end(); } catch { /* ignore */ }
}

function respondResult(stream: ServerHttp2Stream, result: unknown): void {
  try {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end(JSON.stringify({ result }));
  } catch { /* 客户端已断开则忽略 */ }
}

function respondError(stream: ServerHttp2Stream, err: unknown): void {
  try {
    const p: ErrorPayload = toErrorPayload(err);
    const status = httpStatusForCode(p.code);
    const body: ErrorPayload = { ...p, ext: { ...p.ext, http: { status } } };
    stream.respond({ ':status': status, 'content-type': 'application/json' });
    stream.end(JSON.stringify(body));
  } catch { /* 客户端已断开则忽略 */ }
}
