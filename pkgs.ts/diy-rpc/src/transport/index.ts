/**
 * transport/index.ts — 传输层核心导出
 */

export type { Transport, StreamMode, StreamHandle, Envelope } from './types';
export type { CallOptions } from '../rpc/raw-client';
export type { ErrorPayload, CallMsg, DataMsg, EndMsg, NotifyMsg } from './types';
export { errMsg, RpcError } from './types';
export { RawServer } from '../rpc/raw-server';
export { RawClient } from '../rpc/raw-client';
export { AsyncQueue } from './async-queue';
export { createMemTransportPair, createLoggedTransport } from './transport-builtin';
export type { TransportLogHandler } from './transport-builtin';
