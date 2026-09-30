/**
 * http/http-client-binding.ts — HttpClientBinding：HTTP 常态绑定的客户端（第2层绑定之一）
 *
 * 与 HttpServerBinding 配对的 wire 约定：
 *   unary/serverStream/notify   params 在 body；clientStream/bidi 的 params 在
 *                               header `x-diy-params`，body 是 NDJSON chunk 流
 *   单值响应  {"result": …} / 错误 {code,message,details,ext:{http:{status}}}
 *   流式响应  NDJSON：{"v"} 数据 / {"e"} 终止错误
 *   取消      AbortSignal → RST_STREAM（NGHTTP2_CANCEL）
 */

import * as http2 from 'node:http2';
import type { ClientHttp2Session, ClientHttp2Stream } from 'node:http2';
import type { StreamHandle } from '../../core/types';
import { _AsyncQueue } from '../../core/_async-queue';
import { RpcError, _fromErrorPayload, _reasonToRpcError, type _ErrorPayload } from '../../core/error';
import type { CallOptions, ClientBinding } from '../../core/server-binding';
import { codeForHttpStatus } from './_codes';

interface HttpResp {
  status: number;
  data: Buffer;
}

export class HttpClientBinding implements ClientBinding {
  private session: ClientHttp2Session;
  private disposed = false;
  /** 在飞的流：dispose 时要逐个 RST（优雅 close 会等它们自然结束，等于不取消） */
  private activeStreams = new Set<ClientHttp2Stream>();
  /** 在飞调用的本地终态 guard：dispose → DISPOSED（含 ack 前挂起的 init，任务 185） */
  private _settles = new Set<(e: unknown) => void>();
  /** 已建立的流式队列：dispose → 本地 DISPOSED（与 channel 对齐，不再干净 done） */
  private _queues = new Set<_AsyncQueue<unknown>>();
  /** 后台上传的上游 iterator 清理（best-effort，幂等）：dispose 与 settle 都需通知（review R5 P2） */
  private _upstreamCleanups = new Set<() => void>();

  constructor(private baseUrl: string) {
    this.session = http2.connect(baseUrl);
  }

  /** 把 in-flight promise 纳入 dispose 落定：dispose → reject(DISPOSED)；正常 settle 自动移除 */
  private _track<T>(p: Promise<T>): Promise<T> {
    let rejectGuard!: (e: unknown) => void;
    const guard = new Promise<never>((_, rej) => { rejectGuard = rej; });
    const settle = (e: unknown) => rejectGuard(e);
    this._settles.add(settle);
    return Promise.race([p, guard]).finally(() => { this._settles.delete(settle); });
  }

  /** 登记已建立的流式队列：settle 自动移除，dispose 未 settle 的以 DISPOSED 收尾 */
  private _trackQueue(q: _AsyncQueue<unknown>): _AsyncQueue<unknown> {
    this._queues.add(q);
    q.onSettle(() => { this._queues.delete(q); });
    return q;
  }

  dispose(): void {
    if (this.disposed) return; // 幂等（与 ChannelClientBinding 一致）
    this.disposed = true;
    // 本地终态先落定：所有在飞调用/流队列以 DISPOSED 收尾 —— 与 channel 对齐。
    // 此前 dispose-after-ack 时本地队列干净结束（与 channel 的 DISPOSED 分叉）、
    // dispose-before-ack 时 firstResponseStatus 永不落定（任务 185 实测挂起）。
    const d = new RpcError('DISPOSED', 'Client disposed');
    // 直接迭代：settle 的删除发生在微任务（Promise.finally），q.error 的 onSettle 删除
    // 的是「刚取出的当前项」——对 Set 均安全
    for (const s of this._settles) s(d);
    this._settles.clear();
    for (const q of this._queues) q.error(d);
    this._queues.clear();
    // 后台上传的上游 iterator：best-effort 通知清理（review R5 P2 —— dispose 不会
    // abort 调用方 signal，必须在本路径主动通知；通知不能强制打断第三方 next()）
    for (const f of this._upstreamCleanups) f();
    this._upstreamCleanups.clear();
    // session.close() 是**优雅关闭**：它在等所有活跃流结束，对端感知不到「客户端不要了」。
    // 必须先把在飞的流逐个 RST_STREAM —— 服务端 stream.on('close') 才会触发，
    // 进而 g.return() 收尾生成器。否则服务端继续白跑（任务 149 的放大机制）。
    for (const stream of this.activeStreams) {
      if (!stream.closed && !stream.destroyed) {
        try {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        } catch {
          // 流已在关闭途中：忽略，后面 session.close() 兜底
        }
      }
    }
    this.activeStreams.clear();
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
    const resp = await this._track(collectResponse(stream, options));
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

    const status = await this._track(firstResponseStatus(stream, options));
    if (status !== 200) {
      const data = await readAll(stream, options);
      throw parseError(status, data);
    }
    return this._trackQueue(createNdjsonStream(stream, options)) as StreamHandle<TYield>;
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

    /** 远端终态（响应 resolve/reject）已到——终态后不再发送上游数据（review R10 P1） */
    let remoteSettled = false;
    // abort → 写取消帧 + 优雅结束 + 上游 return() 通知（服务端收 __cancel 会同时
    // error 输入队列并 abort 调用级 signal，与 channel 对齐，review P1）
    const upstream = chunks[Symbol.asyncIterator]();
    let notified = false;
    const notifyUpstream = () => {
      if (notified) return;
      notified = true;
      try { void upstream.return?.(undefined)?.catch(() => {}); } catch { /* ignore */ }
    };
    this._upstreamCleanups.add(notifyUpstream);
    const onAbort = () => {
      try { stream.write(JSON.stringify({ __cancel: true }) + '\n'); } catch { /* ignore */ }
      try { stream.end(); } catch { /* ignore */ }
      notifyUpstream();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    // 上传后台化（review P1）：上游 next() 不可取消地挂起时，调用落定不得被拖住 ——
    // collectResponse 不等上传；abort 后服务端经 __cancel 立即收尾并回响应
    let uploadErr: unknown;
    void (async () => {
      try {
        for (;;) {
          // 终态/流关闭后不再拉取：drain 被 close/error 唤醒后在此止步（R16 P1 + R18）
          if (signal?.aborted || remoteSettled || stream.closed || stream.destroyed) break;
          const n = await upstream.next();
          if (n.done) break;
          // 终态后不再拉取/发送（review R10 P1）：在途 next 无法撤销，但返回后必须停
          if (signal?.aborted || remoteSettled || stream.closed || stream.destroyed) break;
          if (!stream.write(JSON.stringify(n.value) + '\n')) await onceDrain(stream);
        }
      } catch (e) {
        uploadErr = e;
        // 上游迭代出错则中止上传（不吞错——R19 P1-2）
      }
      if (!signal?.aborted && !remoteSettled) {
        try { stream.end(); } catch { /* 已断开 */ }
      }
    })();

    try {
      const resp = await this._track(collectResponse(stream, options));
      if (uploadErr) throw uploadErr;
      return parseResult<TRes>(resp);
    } finally {
      remoteSettled = true; // 终态（成功/错误/异常）后封锁上传
      // 远端终态后主动收束 request-side（review R12/R13）：仅停写/半关会留下半开流
      this._settleStream(stream);
      if (signal) signal.removeEventListener('abort', onAbort);
      // dispose 与正常 settle 都通知上游 iterator（review R5 P2；幂等）
      this._upstreamCleanups.delete(notifyUpstream);
      notifyUpstream();
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

    /** 远端终态（响应结束/队列 settle/早错）已到——终态后不再发送上游数据（review R10 P1） */
    let remoteEnded = false;
    // 上游 return() 尽力通知（review P1）：abort 后若上传正挂在 next()，发 return 唤醒清理；
    // 随队列终态/调用 settle/dispose 移除（onSettle）——不残留共享 signal 上的 listener
    const upstream = chunks[Symbol.asyncIterator]();
    let notified = false;
    let sentCancel = false;
    const onUpstreamAbort = () => {
      // signal abort 语义下补发显式取消帧（与 clientStream 对称）：Node http2 客户端 RST 在服务端
      // 表现为 end→aborted→close，'end' 先到会被 body reader 误判为正常结束，已启动的 handler
      // 观察不到取消（意图测试 C2：bidi handler signal.aborted）
      if (!sentCancel && signal?.aborted) {
        sentCancel = true;
        try { stream.write('{"__cancel":true}\n'); } catch { /* 流已断 */ }
      }
      if (notified) return;
      notified = true;
      try { void upstream.return?.(undefined)?.catch(() => {}); } catch { /* ignore */ }
    };
    this._upstreamCleanups.add(onUpstreamAbort);
    if (signal) signal.addEventListener('abort', onUpstreamAbort, { once: true });

    // 后台：边传 chunk 边读响应（http2 全双工）；上传不阻塞调用落定（review P1）
    void (async () => {
      try {
        for (;;) {
          // 终态/流关闭后不再拉取：drain 被 close/error 唤醒后在此止步（R16 P1 + R18）
          if (signal?.aborted || remoteEnded || stream.closed || stream.destroyed) break;
          const n = await upstream.next();
          if (n.done) break;
          // 终态后不再拉取/发送（review R10 P1）：在途 next 无法撤销，但返回后必须停
          if (signal?.aborted || remoteEnded || stream.closed || stream.destroyed) break;
          if (!stream.write(JSON.stringify(n.value) + '\n')) await onceDrain(stream);
        }
      } catch {
        /* ignore */
      }
      if (!signal?.aborted && !remoteEnded) {
        try { stream.end(); } catch { /* 已断开 */ }
      }
    })();

    const status = await this._track(firstResponseStatus(stream, options));
    if (status !== 200) {
      const data = await readAll(stream, options);
      remoteEnded = true;
      this._settleStream(stream); // 早错也是终态：主动收束 request-side（review R12/R13）
      if (signal) signal.removeEventListener('abort', onUpstreamAbort);
      this._upstreamCleanups.delete(onUpstreamAbort);
      onUpstreamAbort(); // 早错也是终态：通知上游 iterator（review R10 同族缺口，幂等）
      throw parseError(status, data);
    }
    const queue = createNdjsonStream(stream, options);
    queue.onSettle(() => {
      remoteEnded = true; // 队列终态（正常结束/断开/dispose）
      this._settleStream(stream); // 队列终态：主动收束 request-side（review R12/R13）
      signal?.removeEventListener('abort', onUpstreamAbort);
      this._upstreamCleanups.delete(onUpstreamAbort);
      onUpstreamAbort(); // 队列终态（dispose/断开/正常结束）→ 通知上游 iterator（幂等）
    });
    return this._trackQueue(queue) as StreamHandle<TChOut>;
  }

  // ── 内部 ─────────────────────────────────────────

  private request(method: string, contentType: string, params?: unknown): ClientHttp2Stream {
    if (this.disposed) throw new RpcError('DISPOSED', 'Client disposed');
    const headers: Record<string, string> = {
      ':path': `/${method}`,
      ':method': 'POST',
      'content-type': contentType,
    };
    if (params !== undefined) headers['x-diy-params'] = JSON.stringify(params);
    const stream = this.session.request(headers);
    // 统一登记所有流（unary 与流式）：dispose 时才能一个不漏地取消
    this.activeStreams.add(stream);
    stream.once('close', () => this.activeStreams.delete(stream));
    return stream;
  }

  /**
   * 终态主动收束 request-side（review R12/R13 验收）：RST_STREAM 关闭流并**同步**移出
   * activeStreams —— 不依赖后续 HTTP/2 close 事件才收束。安全性：RPC 终态 = 响应已入队/
   * 已解析完毕，此时主动 RST 不会丢弃调用方仍需要的数据。
   */
  private _settleStream(stream: ClientHttp2Stream): void {
    this.activeStreams.delete(stream);
    if (!stream.closed && !stream.destroyed) {
      try {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      } catch {
        // 流已在关闭途中：忽略（close 事件兜底删除）
      }
    }
  }
}

// ═══════════════════════════════════════════════════
//  helpers
// ═══════════════════════════════════════════════════

/** 等 drain；流 close/error 也唤醒（终态后不得悬挂在背压等待中，review R12 P1）。注册前后
 *  各查一次 closed/destroyed：同步代码内事件无法插入两检之间，夹住「事件先于注册」竞态（R16）。 */
function onceDrain(stream: ClientHttp2Stream): Promise<void> {
  if (stream.closed || stream.destroyed) return Promise.resolve();
  return new Promise((r) => {
    const done = () => {
      stream.removeListener('drain', done);
      stream.removeListener('close', done);
      stream.removeListener('error', done);
      r();
    };
    stream.once('drain', done);
    stream.once('close', done);
    stream.once('error', done);
    if (stream.closed || stream.destroyed) done();
  });
}

/** 等响应头，返回 :status（监听 close 兜底 + abort listener 随终态移除，任务 185） */
function firstResponseStatus(stream: ClientHttp2Stream, options?: CallOptions): Promise<number> {
  const { signal, timeout } = options ?? {};
  return new Promise<number>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      stream.removeListener('response', onResp);
      stream.removeListener('error', onErr);
      stream.removeListener('close', onClose);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    };
    const onResp = (headers: Record<string, unknown>) => { cleanup(); resolve(Number(headers[':status'] ?? 0)); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    // 流关闭但既无 response 也无 error（本地 dispose RST / 对端静默关流）→ 必须落定，
    // 否则 init promise 永挂（任务 185 实测：dispose-before-ack TIMEOUT 未落定）
    const onClose = () => { cleanup(); reject(new RpcError('CANCELLED', 'Stream closed before response')); };
    const onAbort = () => {
      cleanup(); stream.close(http2.constants.NGHTTP2_CANCEL);
      reject(_reasonToRpcError(signal!.reason));
    };
    stream.on('response', onResp);
    stream.on('error', onErr);
    stream.on('close', onClose);
    if (timeout != null && timeout > 0) {
      timer = setTimeout(() => {
        cleanup(); stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(new RpcError('TIMEOUT', `Response timed out after ${timeout}ms`));
      }, timeout);
    }
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 读完整个响应 body；abort → RST + 以 reason 落定（覆盖「响应头已到、body 未完」窗口） */
function readAll(stream: ClientHttp2Stream, options?: CallOptions): Promise<Buffer> {
  const signal = options?.signal;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    const onAbort = () => {
      settled = true;
      cleanup();
      if (!stream.closed && !stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL);
      reject(_reasonToRpcError(signal!.reason));
    };
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => { settled = true; cleanup(); resolve(Buffer.concat(chunks)); });
    stream.on('error', (e) => { settled = true; cleanup(); reject(e); });
    // close 兑底（review P2）：流被销毁而未收到 end/error/abort 时，不留残留 listener、不悬死
    stream.on('close', () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new RpcError('CANCELLED', 'Connection closed'));
    });
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 收集单值响应（写 body 已由调用方完成，这里只读响应） */
function collectResponse(stream: ClientHttp2Stream, options?: CallOptions): Promise<HttpResp> {
  return firstResponseStatus(stream, options).then((status) =>
    readAll(stream, options).then((data) => ({ status, data })),
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
      if (f.e) { q.error(_fromErrorPayload(f.e), { drain: true }); return; }
      if ('v' in f) q.push(f.v);
    }
  });
  stream.on('end', () => q.end());
  stream.on('error', (e) => q.error(e instanceof Error ? e : new Error(String(e)), { drain: true }));

  const signal = options?.signal;
  let onAbort: (() => void) | undefined;
  if (signal) {
    onAbort = () => {
      cleanup();
      if (!stream.closed && !stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL);
      q.error(_reasonToRpcError(signal.reason));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort!);
    // listener 生命周期 = 队列终态（end/error/消费端 return），不随调用泄漏
    q.onSettle(cleanup);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // 消费端提前退出（break / 外层 return / 迭代器 return）→ 也发 RST_STREAM。
  // 这条路径此前完全没有信号：AbortSignal 只是取消的通路之一，而 for-await 的
  // break 走的是迭代器 return()，与此无关 —— 上游因此会在无人消费时继续产出。
  q.onReturn(() => {
    onAbort?.(); // 幂等：先移除 listener，再 RST（无 abort 时只 RST）
    if (!stream.closed && !stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL);
  });

  return q;
}
