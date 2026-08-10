/**
 * server-binding-core.ts — 各 ServerBinding 共享的注册核心（第2层）
 *
 * 纯注册逻辑，与具体协议无关：持有 4 张 method→handler 表、meta.name 解析、
 * unwrap 解包 + zod 校验。ChannelServerBinding / HttpServerBinding 继承它，
 * 各自只写协议 dispatch（envelope / http2 stream），不再重复注册机制。
 */

import type { StreamHandle } from './types';
import type { ClientBinding } from './server-binding';
import { _validateInput, type _AnyProcedureMeta, type _AnyProcedureDef, type _HandlerForProc, type _Router } from './meta';
import { _flattenRouter } from './_tree';

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

  /** 从 meta 取方法全名；未经 router() 回写（无 name）则明确报错 */
  protected _nameOf(meta: _AnyProcedureMeta): string {
    const name = meta.name;
    if (!name) {
      throw new Error('[ServerBinding] meta 无 name — 请用 router() 包裹 apiDef');
    }
    return name;
  }

  /** 注册前检查方法全名是否已存在——重复注册（多后端 scope 冲突的实质）显式报错 */
  private _assertNotRegistered(name: string): void {
    if (
      this._unaries.has(name) ||
      this._serverStreams.has(name) ||
      this._clientStreams.has(name) ||
      this._bidiStreams.has(name)
    ) {
      throw new Error(
        `[ServerBinding] 方法 "${name}" 已注册 — 每个方法只能归属一个后端（scope 冲突？）`,
      );
    }
  }

  onUnary<M extends _AnyProcedureMeta & { _streamMode: 'unary' }>(meta: M, handler: _HandlerForProc<M>): void {
    const name = this._nameOf(meta);
    this._assertNotRegistered(name);
    this._unaries.set(name, (params) => (handler as HandlerFn)(unwrap(meta, params)));
  }

  onServerStream<M extends _AnyProcedureMeta & { _streamMode: 'server' }>(meta: M, handler: _HandlerForProc<M>): void {
    const name = this._nameOf(meta);
    this._assertNotRegistered(name);
    this._serverStreams.set(
      name,
      (params) => (handler as HandlerFn)(unwrap(meta, params)) as AsyncGenerator<unknown>,
    );
  }

  onClientStream<M extends _AnyProcedureMeta & { _streamMode: 'client' }>(meta: M, handler: _HandlerForProc<M>): void {
    const name = this._nameOf(meta);
    this._assertNotRegistered(name);
    this._clientStreams.set(
      name,
      (params, chunks) => (handler as HandlerFn)(unwrap(meta, params, chunks)) as Promise<unknown>,
    );
  }

  onBidiStream<M extends _AnyProcedureMeta & { _streamMode: 'bidi' }>(meta: M, handler: _HandlerForProc<M>): void {
    const name = this._nameOf(meta);
    this._assertNotRegistered(name);
    this._bidiStreams.set(
      name,
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

  // ═══════════════════════════════════════════════════
  //  注册辅助：按 mode 分发 / router 批量 / 转发
  // ═══════════════════════════════════════════════════

  /** 按 def 的 stream mode 注册（handler 收 { input, meta, stream? }），等价于 onXxx 的自动分派 */
  register(def: _AnyProcedureMeta, handler: _HandlerForProc<_AnyProcedureMeta>): void {
    const mode = def._streamMode;
    const on = this as unknown as Record<string, (m: unknown, h: unknown) => void>;
    if (mode === 'unary') on.onUnary(def, handler);
    else if (mode === 'server') on.onServerStream(def, handler);
    else if (mode === 'client') on.onClientStream(def, handler);
    else if (mode === 'bidi') on.onBidiStream(def, handler);
  }

  /** 批量注册 router 树：含 call 的（RpcImpl）自动注册，无 call 的（RpcSchema）跳过等调用方 on */
  registerRouter(router: _Router): void {
    for (const [, def] of Object.entries(_flattenRouter(router))) {
      const call = (def as _AnyProcedureDef).call;
      if (typeof call === 'function') this.register(def as _AnyProcedureMeta, call as any);
    }
  }

  /**
   * 注册转发：把 router 树下的每个方法注册为转发 handler——收到调用后经
   * client 发到远端（如 ipcTransport → renderer），拿回结果/逐块回写。
   * def.name 必须是全名（router() 已回写），client 连远端进程。
   */
  onForward(router: _Router, client: ClientBinding): void {
    for (const [name, def] of Object.entries(_flattenRouter(router))) {
      const full = (def as { name?: string }).name ?? name;
      const mode = def._streamMode;

      if (mode === 'unary') {
        (this.onUnary as any)(def, ((opts: { input: unknown; meta: unknown }) =>
          client.invoke(full, { input: opts.input, meta: opts.meta })));
      } else if (mode === 'server') {
        (this.onServerStream as any)(def, ((opts: { input: unknown; meta: unknown }) =>
          this._forwardServerStream(client, full, opts)));
      } else if (mode === 'client' || mode === 'bidi') {
        throw new Error(`[ServerBinding] ${full}: client/bidi 转发暂不支持`);
      } else {
        throw new Error(`[ServerBinding] ${full}: 未知 stream mode ${mode}`);
      }
    }
  }

  private async *_forwardServerStream(
    client: ClientBinding,
    full: string,
    opts: { input: unknown; meta: unknown },
  ): AsyncGenerator<unknown> {
    const handle = await client.serverStream(full, { input: opts.input, meta: opts.meta });
    for await (const chunk of handle) yield chunk;
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
