/**
 * transport/index.ts — 传输层核心导出
 */

export type { Transport, StreamMode, StreamHandle, Envelope } from './types';
export type { CallMsg, DataMsg, EndMsg, NotifyMsg } from './types';
export type { ErrorPayload } from '../rpc/error';
export { RpcError, toRpcError, toErrorPayload, fromErrorPayload } from '../rpc/error';

// 端口接口（第2层语义抽象）
export type { RawServer, RawClient, CallOptions, ErrorProtocolExt } from '../rpc/raw';

// 具体绑定（envelope 复用协议跑双向通道）
export { ChannelRawServer } from '../rpc/raw-server';
export { ChannelRawClient } from '../rpc/raw-client';
export { AsyncQueue } from '../rpc/async-queue';
export { createMemTransportPair, createLoggedTransport } from './transport-builtin';
export type { TransportLogHandler } from './transport-builtin';
