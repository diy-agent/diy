/**
 * raw-server.ts — ChannelRawServer：envelope 复用协议服务端（第2层绑定之一）
 *
 * 在一条双向通道（mem/WS/IPC 等 Transport）上跑信封协议（id/streamId 复用），
 * 实现 RawServer 端口。只应在入口组装代码中使用（传给 RpcServer/RpcGateway），
 * 业务代码应使用第3层 RPC。
 *
 * 四类 handler：
 *   onUnary        — unary（请求-响应）
 *   onServerStream — 服务端流（返回 AsyncGenerator）
 *   onClientStream — 客户端流（接收 StreamHandle，返回 Promise）
 *   onBidiStream   — 双向流（接收 StreamHandle，返回 AsyncGenerator）
 *   onNotify       — 单向通知
 */

import type { Transport, StreamHandle, StreamMode, Envelope } from '../transport/types';
import { AsyncQueue } from './async-queue';
import { toErrorPayload, RpcError } from './error';
import type { RawServer } from './raw';
import { validateInput, type AnyProcedureMeta, type HandlerForProc } from './meta';

let _streamId = 0;

type UnaryHandler = (params: unknown) => unknown;
type ServerStreamHandler = (params: unknown) => AsyncGenerator<unknown>;
type ClientStreamHandler = (params: unknown, chunks: StreamHandle<unknown>) => Promise<unknown>;
type BidiStreamHandler = (params: unknown, incoming: StreamHandle<unknown>) => AsyncGenerator<unknown>;
/** 各 onXxx 内部 handler 形态：收 { input, meta, stream? }（与 HandlerForProc 一致） */
type HandlerFn = (opts: { input: unknown; meta: unknown; stream?: unknown }) => unknown;

/** 从 envelope params 解包出 { input, meta }，并对 input 做 zod 校验 */
function unwrap(meta: AnyProcedureMeta, params: unknown, stream?: unknown): { input: unknown; meta: unknown; stream?: unknown } {
  const { input, meta: m } = (params ?? {}) as { input?: unknown; meta?: unknown };
  return { input: validateInput(meta, input), meta: m ?? {}, stream };
}

export class ChannelRawServer implements RawServer {
  private _unaries = new Map<string, UnaryHandler>();
  private _serverStreams = new Map<string, ServerStreamHandler>();
  private _clientStreams = new Map<string, ClientStreamHandler>();
  private _bidiStreams = new Map<string, BidiStreamHandler>();

  /** server-stream 取消器，按 streamId */
  private _serverStreamCancellers = new Map<number, () => void>();
  /** client/bidi 流的消费队列，按 streamId */
  private _streamConsumers = new Map<number, AsyncQueue<any>>();

  private _unsub: () => void;

  constructor(private tx: Transport) {
    this._unsub = tx.on((msg) => this._dispatch(msg));
  }

  /** 从 meta 取方法全名；未经 router()/RpcServer 回写（无 name）则明确报错 */
  private _nameOf(meta: AnyProcedureMeta): string {
    const name = meta.name;
    if (!name) {
      throw new Error('[ChannelRawServer] meta 无 name — 请用 router() 包裹 apiDef 或经 RpcServer 注册');
    }
    return name;
  }

  /** 销毁：解除消息监听，清理所有流 */
  destroy(): void {
    this._unsub();
    this._serverStreamCancellers.forEach(c => c());
    this._serverStreamCancellers.clear();
    this._streamConsumers.forEach(q => q.end());
    this._streamConsumers.clear();
    this._unaries.clear();
    this._serverStreams.clear();
    this._clientStreams.clear();
    this._bidiStreams.clear();
  }

  // ── 注册方法 ────────────────────────────────────

  onUnary<M extends AnyProcedureMeta & { _streamMode: 'unary' }>(meta: M, handler: HandlerForProc<M>): void {
    this._unaries.set(this._nameOf(meta), (params) => (handler as HandlerFn)(unwrap(meta, params)));
  }

  onServerStream<M extends AnyProcedureMeta & { _streamMode: 'server' }>(meta: M, handler: HandlerForProc<M>): void {
    this._serverStreams.set(
      this._nameOf(meta),
      (params) => (handler as HandlerFn)(unwrap(meta, params)) as AsyncGenerator<unknown>,
    );
  }

  onClientStream<M extends AnyProcedureMeta & { _streamMode: 'client' }>(meta: M, handler: HandlerForProc<M>): void {
    this._clientStreams.set(
      this._nameOf(meta),
      (params, chunks) => (handler as HandlerFn)(unwrap(meta, params, chunks)) as Promise<unknown>,
    );
  }

  onBidiStream<M extends AnyProcedureMeta & { _streamMode: 'bidi' }>(meta: M, handler: HandlerForProc<M>): void {
    this._bidiStreams.set(
      this._nameOf(meta),
      (params, incoming) => (handler as HandlerFn)(unwrap(meta, params, incoming)) as AsyncGenerator<unknown>,
    );
  }

  // ── 单一分发器 ──────────────────────────────────

  private _dispatch = async (msg: Envelope) => {
    if (msg.type === 'call' && !msg.stream) {
      await this._handleUnary(msg);
    } else if (msg.type === 'call' && msg.stream === true) {
      // Client 请求分配 streamId，从 msg.method 获取方法名
      const mode = this._detectStreamMode(msg.method!);
      if (mode === 'server') this._startServerStream(msg);
      else if (mode === 'client') this._startClientStream(msg);
      else if (mode === 'bidi') this._startBidiStream(msg);
    } else if (msg.type === 'data') {
      const consumer = this._streamConsumers.get(msg.stream);
      if (consumer) consumer.push(msg.value);
    } else if (msg.type === 'end') {
      const consumer = this._streamConsumers.get(msg.stream);
      if (consumer) {
        if (msg.error) consumer.error(new RpcError(msg.error.code, msg.error.message));
        else consumer.end();
        this._streamConsumers.delete(msg.stream);
      }
      // end 也作为 server-stream 的取消信号
      const cancel = this._serverStreamCancellers.get(msg.stream);
      if (cancel) cancel();
    }
  };

  /** 根据 method 名从已注册 handler 推断 stream mode */
  private _detectStreamMode(method: string): StreamMode | null {
    if (this._serverStreams.has(method)) return 'server';
    if (this._clientStreams.has(method)) return 'client';
    if (this._bidiStreams.has(method)) return 'bidi';
    return null;
  }

  // ── Unary ────────────────────────────────────────

  private async _handleUnary(msg: Envelope & { type: 'call' }) {
    const fn = this._unaries.get(msg.method!);
    if (!fn) return;
    try {
      this.tx.send({ type: 'call', id: msg.id, result: await fn(msg.params) });
    } catch (err: unknown) {
      this.tx.send({ type: 'call', id: msg.id, error: toErrorPayload(err) });
    }
  }

  // ── Server-Stream ────────────────────────────────

  private _startServerStream(msg: Envelope & { type: 'call' }) {
    const fn = this._serverStreams.get(msg.method!);
    if (!fn) return;

    const streamId = ++_streamId;
    let cancelled = false;

    this._serverStreamCancellers.set(streamId, () => { cancelled = true; });
    this.tx.send({ type: 'call', id: msg.id, stream: streamId });

    (async () => {
      try {
        for await (const value of fn(msg.params)) {
          if (cancelled) return;
          this.tx.send({ type: 'data', stream: streamId, value });
        }
        if (!cancelled) this.tx.send({ type: 'end', stream: streamId });
      } catch (err: unknown) {
        if (!cancelled) this.tx.send({ type: 'end', stream: streamId, error: toErrorPayload(err) });
      } finally {
        this._serverStreamCancellers.delete(streamId);
      }
    })();
  }

  // ── Client-Stream ────────────────────────────────

  private async _startClientStream(msg: Envelope & { type: 'call' }) {
    const fn = this._clientStreams.get(msg.method!);
    if (!fn) return;

    const streamId = ++_streamId;
    const queue = new AsyncQueue<any>();
    this._streamConsumers.set(streamId, queue);

    this.tx.send({ type: 'call', id: msg.id, stream: streamId });

    try {
      const result = await fn(msg.params, queue);
      this.tx.send({ type: 'call', id: msg.id, result });
    } catch (err: unknown) {
      this.tx.send({ type: 'call', id: msg.id, error: toErrorPayload(err) });
    } finally {
      this._streamConsumers.delete(streamId);
    }
  }

  // ── Bidi-Stream ───────────────────────────────────

  private async _startBidiStream(msg: Envelope & { type: 'call' }) {
    const fn = this._bidiStreams.get(msg.method!);
    if (!fn) return;

    const streamId = ++_streamId;
    const queue = new AsyncQueue<any>();
    this._streamConsumers.set(streamId, queue);

    // bidi 不注册 cancellation：客户端 end 仅表示上游已完成，
    // 不应取消服务端向下游发送数据。
    this.tx.send({ type: 'call', id: msg.id, stream: streamId });

    try {
      for await (const value of fn(msg.params, queue)) {
        this.tx.send({ type: 'data', stream: streamId, value });
      }
      this.tx.send({ type: 'end', stream: streamId });
    } catch (err: unknown) {
      this.tx.send({ type: 'end', stream: streamId, error: toErrorPayload(err) });
    } finally {
      this._streamConsumers.delete(streamId);
    }
  }
}
