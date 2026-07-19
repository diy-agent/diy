/**
 * transport/index.ts — 传输层核心导出
 */

export type { Transport, StreamMode, StreamHandle, Envelope } from './types';
export type { CallOptions } from './client';
export type { ErrorPayload, CallMsg, DataMsg, EndMsg, NotifyMsg } from './types';
export { errMsg, RpcError } from './types';
export { Server } from './server';
export { Client } from './client';
export { AsyncQueue } from './async-queue';
export { createMemTransportPair, createLoggedTransport } from './transport-builtin';
export type { TransportLogHandler } from './transport-builtin';
