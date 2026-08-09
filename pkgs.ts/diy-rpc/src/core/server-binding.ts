/**
 * server-binding.ts — 第2层端口：ClientBinding / ServerBinding 接口
 *
 * 与 meta.ts（第2层类型）同层。端口只描述 4 种调用语义
 * （unary / serverStream / clientStream / bidiStream），以 meta 为注册键强类型化：
 *   - ServerBinding.onUnary(meta, handler) 等：handler 收 { input, meta, stream? }，类型从 meta 推导
 *   - 具体绑定（ChannelServerBinding / HttpServerBinding）各自把语义映射到协议常态
 * 第3层（RpcServer/RpcGateway/createClient）只依赖本接口，不感知具体绑定。
 */

import type { StreamHandle } from './types';
import type { _ErrorPayload, _ErrorProtocolExt } from './error';
import type { _AnyProcedureMeta, _HandlerForProc } from './meta';

// ═══════════════════════════════════════════════════
//  CallOptions — 通用调用选项（取消/超时）
// ═══════════════════════════════════════════════════

export interface CallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/** 仅接受特定 stream mode 的 meta */
type UnaryMeta = _AnyProcedureMeta & { _streamMode: 'unary' };
type ServerMeta = _AnyProcedureMeta & { _streamMode: 'server' };
type ClientMeta = _AnyProcedureMeta & { _streamMode: 'client' };
type BidiMeta = _AnyProcedureMeta & { _streamMode: 'bidi' };

// ═══════════════════════════════════════════════════
//  ServerBinding — 服务端端口（以 meta 为键强类型注册）
// ═══════════════════════════════════════════════════

export interface ServerBinding {
  onUnary<M extends UnaryMeta>(meta: M, handler: _HandlerForProc<M>): void;

  onServerStream<M extends ServerMeta>(meta: M, handler: _HandlerForProc<M>): void;

  onClientStream<M extends ClientMeta>(meta: M, handler: _HandlerForProc<M>): void;

  onBidiStream<M extends BidiMeta>(meta: M, handler: _HandlerForProc<M>): void;

  destroy(): void;
}

// ═══════════════════════════════════════════════════
//  ClientBinding — 客户端端口（只描述调用语义）
// ═══════════════════════════════════════════════════

export interface ClientBinding {
  invoke<TReq = unknown, TRes = unknown>(
    method: string,
    params?: TReq,
    options?: CallOptions,
  ): Promise<TRes>;

  serverStream<TReq = unknown, TYield = unknown>(
    method: string,
    params?: TReq,
    options?: CallOptions,
  ): Promise<StreamHandle<TYield>>;

  clientStream<TReq = unknown, TChunk = unknown, TRes = unknown>(
    method: string,
    params: TReq,
    chunks: AsyncIterable<TChunk>,
    options?: CallOptions,
  ): Promise<TRes>;

  bidiStream<TReq = unknown, TChIn = unknown, TChOut = unknown>(
    method: string,
    params: TReq,
    chunks: AsyncIterable<TChIn>,
    options?: CallOptions,
  ): Promise<StreamHandle<TChOut>>;

  dispose(): void;
}

// re-export 供第3层/绑定用，避免重复 import 路径
/** @internal */
export type { _ErrorPayload, _ErrorProtocolExt };
