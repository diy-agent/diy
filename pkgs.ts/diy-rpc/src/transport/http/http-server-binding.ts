/**
 * http/http-server-binding.ts — HttpServerBinding：HTTP 常态绑定的服务端（第2层绑定之一）
 *
 * 每个 http2 stream = 一个 RPC：`:path` 即方法全名（/diy.app.task.list），
 * 按协议常态实现四种语义（unary/serverStream/clientStream/bidi），curl 可直接访问。
 * 注册逻辑继承自 ServerBindingCore（meta 强类型注册 + zod 校验），这里只写 http2 dispatch。
 *
 * wire 约定（JSON，无 protobuf）：
 *   unary/serverStream   params 在请求 body（JSON）；clientStream/bidi 的
 *                        params 在 header `x-diy-params`，body 是 NDJSON chunk 流
 *   单值响应  {"result": …}                    200 + application/json
 *   错误响应  {code,message,details,ext:{http:{status}}}   映射后的 HTTP 状态
 *   流式响应  NDJSON：{"v": <chunk>} 数据帧 / {"e": {…}} 终止错误帧
 *   取消      server-stream：客户端 RST_STREAM（http2 原生流取消）
 *             client-stream：客户端写保留帧 {"__cancel":true} 再 end（http 的 RST
 *             无法让服务端可靠识别 client-stream 取消，用协议内取消帧确定性送达 CANCELLED）
 *             （注意：__cancel 是保留帧键，业务 chunk 不应使用）
 *
 * 单例 + handleStream：注册表启动时建一次，所有 stream 共享；每请求状态
 * （读 body / 写响应 / 取消）都是 handleStream 调用栈里的局部量。
 */

import type { ServerHttp2Stream, IncomingHttpHeaders } from 'node:http2';
import { _AsyncQueue } from '../../core/_async-queue';
import { RpcError, _toErrorPayload, type _ErrorPayload } from '../../core/error';
import { httpStatusForCode } from './_codes';
import type { ServerBinding } from '../../core/server-binding';
import { ServerBindingCore } from '../../core/server-binding-core';

export class HttpServerBinding extends ServerBindingCore implements ServerBinding {
  destroy(): void {
    super._clear();
  }

  // ── 每请求入口 ──────────────────────────────────

  async handleStream(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): Promise<void> {
    const method = String(headers[':path'] ?? '').replace(/^\//, '');

    if (this._getUnary(method)) return this._handleUnary(stream, method);
    if (this._getServer(method)) return this._handleServerStream(stream, method);
    if (this._getClient(method)) return this._handleClientStream(stream, method, headers);
    if (this._getBidi(method)) return this._handleBidiStream(stream, method, headers);

    // 未注册 → UNIMPLEMENTED
    respondError(stream, _toErrorPayload(new RpcError('UNIMPLEMENTED', `No handler for "${method}"`)));
  }

  // ── Unary ────────────────────────────────────────

  private async _handleUnary(stream: ServerHttp2Stream, method: string): Promise<void> {
    const fn = this._getUnary(method)!;
    try {
      const body = await readBody(stream);
      respondResult(stream, await fn(parseBodyParams(body)));
    } catch (e) {
      respondError(stream, e);
    }
  }

  // ── Server-Stream ────────────────────────────────

  private async _handleServerStream(stream: ServerHttp2Stream, method: string): Promise<void> {
    const fn = this._getServer(method)!;
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
        safeWrite(stream, JSON.stringify({ e: _toErrorPayload(e) }) + '\n');
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
    const fn = this._getClient(method)!;
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
    const fn = this._getBidi(method)!;
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
        safeWrite(stream, JSON.stringify({ e: _toErrorPayload(e) }) + '\n');
        safeEnd(stream);
      }
    } finally {
      stream.removeListener('close', onClose);
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

/** 把请求 body 的 NDJSON chunk 流桥接成 _AsyncQueue（StreamHandle） */
function createBodyReader(stream: ServerHttp2Stream): _AsyncQueue<unknown> {
  const q = new _AsyncQueue<unknown>();
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
    const p: _ErrorPayload = _toErrorPayload(err);
    const status = httpStatusForCode(p.code);
    const body: _ErrorPayload = { ...p, ext: { ...p.ext, http: { status } } };
    stream.respond({ ':status': status, 'content-type': 'application/json' });
    stream.end(JSON.stringify(body));
  } catch { /* 客户端已断开则忽略 */ }
}
