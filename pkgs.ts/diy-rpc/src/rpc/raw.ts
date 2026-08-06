/**
 * raw.ts — 第2层端口：RawClient / RawServer 接口
 *
 * 端口只描述 4+1 种调用语义（unary / serverStream / clientStream / bidiStream / notify），
 * 不绑定任何线协议。具体绑定各自把语义映射到协议的常态：
 *   - ChannelRawServer / ChannelRawClient — envelope 复用协议跑双向通道（mem/WS/IPC）
 *   - HttpRawServer / HttpRawClient         — HTTP 常态：URL 路由 + POST + NDJSON，curl 可访问
 * 第3层（RpcServer/RpcGateway/createClient）只依赖本接口，不感知具体绑定。
 */

import type { StreamHandle } from '../transport/types';
import type { ErrorPayload, ErrorProtocolExt } from './error';

// ═══════════════════════════════════════════════════
//  CallOptions — 通用调用选项（取消/超时）
// ═══════════════════════════════════════════════════

export interface CallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

// ═══════════════════════════════════════════════════
//  RawServer — 服务端端口（只描述注册语义）
// ═══════════════════════════════════════════════════

export interface RawServer {
  onUnary<TReq = unknown, TRes = unknown>(
    name: string,
    fn: (params: TReq) => TRes | Promise<TRes>,
  ): void;

  onServerStream<TReq = unknown, TYield = unknown>(
    name: string,
    fn: (params: TReq) => AsyncGenerator<TYield>,
  ): void;

  onClientStream<TReq = unknown, TChunk = unknown, TRes = unknown>(
    name: string,
    fn: (params: TReq, incoming: StreamHandle<TChunk>) => TRes | Promise<TRes>,
  ): void;

  onBidiStream<TReq = unknown, TChIn = unknown, TChOut = unknown>(
    name: string,
    fn: (params: TReq, incoming: StreamHandle<TChIn>) => AsyncGenerator<TChOut>,
  ): void;

  onNotify<TReq = unknown>(
    name: string,
    fn: (params: TReq) => void | Promise<void>,
  ): void;

  destroy(): void;
}

// ═══════════════════════════════════════════════════
//  RawClient — 客户端端口（只描述调用语义）
// ═══════════════════════════════════════════════════

export interface RawClient {
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

  send<TReq = unknown>(method: string, params?: TReq): void;

  dispose(): void;
}

// re-export 供第3层/绑定用，避免重复 import 路径
export type { ErrorPayload, ErrorProtocolExt };
