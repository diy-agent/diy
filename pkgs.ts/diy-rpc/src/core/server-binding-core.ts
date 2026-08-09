/**
 * server-binding-core.ts — 各 ServerBinding 共享的注册核心（第2层）
 *
 * 纯注册逻辑，与具体协议无关：持有 4 张 method→handler 表、meta.name 解析、
 * unwrap 解包 + zod 校验。ChannelServerBinding / HttpServerBinding 继承它，
 * 各自只写协议 dispatch（envelope / http2 stream），不再重复注册机制。
 */

import type { StreamHandle } from './types';
import { _validateInput, type _AnyProcedureMeta, type _HandlerForProc } from './meta';

type UnaryHandler = (params: unknown) => unknown;
type ServerStreamHandler = (params: unknown) => AsyncGenerator<unknown>;
type ClientStreamHandler = (params: unknown, chunks: StreamHandle<unknown>) => Promise<unknown>;
type BidiStreamHandler = (params: unknown, incoming: StreamHandle<unknown>) => AsyncGenerator<unknown>;
/** 各 onXxx 内部 handler 形态：收 { input, meta, stream? }（与 _HandlerForProc 一致） */
type HandlerFn = (opts: { input: unknown; meta: unknown; stream?: unknown }) => unknown;

/** 从 envelope params 解包出 { input, meta }，并对 input 做 zod 校验 */
function unwrap(
  meta: _AnyProcedureMeta,
  params: unknown,
  stream?: unknown,
): { input: unknown; meta: unknown; stream?: unknown } {
  const { input, meta: m } = (params ?? {}) as { input?: unknown; meta?: unknown };
  return { input: _validateInput(meta, input), meta: m ?? {}, stream };
}

/**
 * 服务端绑定共享核心。注册（onUnary/onServerStream/...）与 name 解析 / unwrap /
 * zod 校验在此一处实现；子类经受保护的 accessor 取 handler，把 method 映射到线协议。
 */
export abstract class ServerBindingCore {
  protected _unaries = new Map<string, UnaryHandler>();
  protected _serverStreams = new Map<string, ServerStreamHandler>();
  protected _clientStreams = new Map<string, ClientStreamHandler>();
  protected _bidiStreams = new Map<string, BidiStreamHandler>();

  /** 从 meta 取方法全名；未经 router()/RpcServer 回写（无 name）则明确报错 */
  protected _nameOf(meta: _AnyProcedureMeta): string {
    const name = meta.name;
    if (!name) {
      throw new Error('[ServerBinding] meta 无 name — 请用 router() 包裹 apiDef 或经 RpcServer 注册');
    }
    return name;
  }

  onUnary<M extends _AnyProcedureMeta & { _streamMode: 'unary' }>(meta: M, handler: _HandlerForProc<M>): void {
    this._unaries.set(this._nameOf(meta), (params) => (handler as HandlerFn)(unwrap(meta, params)));
  }

  onServerStream<M extends _AnyProcedureMeta & { _streamMode: 'server' }>(meta: M, handler: _HandlerForProc<M>): void {
    this._serverStreams.set(
      this._nameOf(meta),
      (params) => (handler as HandlerFn)(unwrap(meta, params)) as AsyncGenerator<unknown>,
    );
  }

  onClientStream<M extends _AnyProcedureMeta & { _streamMode: 'client' }>(meta: M, handler: _HandlerForProc<M>): void {
    this._clientStreams.set(
      this._nameOf(meta),
      (params, chunks) => (handler as HandlerFn)(unwrap(meta, params, chunks)) as Promise<unknown>,
    );
  }

  onBidiStream<M extends _AnyProcedureMeta & { _streamMode: 'bidi' }>(meta: M, handler: _HandlerForProc<M>): void {
    this._bidiStreams.set(
      this._nameOf(meta),
      (params, incoming) => (handler as HandlerFn)(unwrap(meta, params, incoming)) as AsyncGenerator<unknown>,
    );
  }

  /** 清空所有注册表（子类 destroy 复用） */
  protected _clear(): void {
    this._unaries.clear();
    this._serverStreams.clear();
    this._clientStreams.clear();
    this._bidiStreams.clear();
  }

  // ── dispatch accessors：子类把 method 映射到线协议时按需取 handler ──

  /** 由 method 推断已注册的流模式（用于 stream 路由） */
  protected _modeOf(method: string): 'unary' | 'server' | 'client' | 'bidi' | null {
    if (this._serverStreams.has(method)) return 'server';
    if (this._clientStreams.has(method)) return 'client';
    if (this._bidiStreams.has(method)) return 'bidi';
    if (this._unaries.has(method)) return 'unary';
    return null;
  }

  protected _getUnary(method: string): UnaryHandler | undefined {
    return this._unaries.get(method);
  }
  protected _getServer(method: string): ServerStreamHandler | undefined {
    return this._serverStreams.get(method);
  }
  protected _getClient(method: string): ClientStreamHandler | undefined {
    return this._clientStreams.get(method);
  }
  protected _getBidi(method: string): BidiStreamHandler | undefined {
    return this._bidiStreams.get(method);
  }
}
