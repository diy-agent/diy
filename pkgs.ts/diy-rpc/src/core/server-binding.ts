/**
 * server-binding.ts — 第2层端口：ClientBinding / ServerBinding 接口
 *
 * 与 meta.ts（第2层类型）同层。端口描述 4 种调用语义
 * （unary / serverStream / clientStream / bidiStream）：
 *   - ServerBinding.on(meta, handler)：注册一个方法，handler 类型从 meta 的
 *     _streamMode 推导（收 { input, meta, stream? }），meta 自带 mode 无需分开
 *   - ClientBinding.invoke/serverStream/...：客户端按调用语义显式选择
 * 具体绑定（ChannelServerBinding / HttpServerBinding）各自把语义映射到协议常态。
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

// ═══════════════════════════════════════════════════
//  ServerBinding — 服务端端口（以 meta 为键强类型注册）
// ═══════════════════════════════════════════════════

export interface ServerBinding {
  /** 注册一个方法；handler 签名随 meta._streamMode 推导 */
  on<M extends _AnyProcedureMeta>(meta: M, handler: _HandlerForProc<M>): void;

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
