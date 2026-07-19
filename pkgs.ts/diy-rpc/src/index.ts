// ═══ Zod 扩展：cliArg / cliOption（side-effect import，必须在任何 schema 定义前执行）
import './rpc/cli-rpc/meta';

export type {
  Transport, StreamMode, StreamHandle, Envelope,
  ErrorPayload, CallMsg, DataMsg, EndMsg, NotifyMsg,
} from './transport/types';
export { errMsg, RpcError } from './transport/types';
export { Server } from './transport/server';
export { Client } from './transport/client';
export { AsyncQueue } from './transport/async-queue';
export { createMemTransportPair, createLoggedTransport } from './transport/transport-builtin';
export type { TransportLogHandler } from './transport/transport-builtin';
export {
  rpc, router, createHandler, createClient, flattenRouter,
  isProcedure, buildRouteTree, routeLeaves, routeResolve, routeWalk,
} from './rpc/index';
export type {
  ProcedureDef, Router, ClientRouter,
  ProcNode, RouterNode, RouteNode,
  AnyProcedure,
  UnaryConfig, ServerStreamConfig, ClientStreamConfig, BidiStreamConfig,
  ProcedureCliMeta,
} from './rpc/index';
export { CliApp, createCli } from './rpc/cli-rpc/index';
export type { CliConfig, CliOptionMeta, CliArgMeta } from './rpc/cli-rpc/index';
