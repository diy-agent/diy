// ═══ Zod 扩展：cliArg / cliOption（side-effect import，必须在任何 schema 定义前执行）
// meta 本身无 Node 依赖，浏览器 schema 也用它打标记
import './rpc/cli-rpc/meta';

export type {
  Transport, StreamMode, StreamHandle, Envelope,
  ErrorPayload, CallMsg, DataMsg, EndMsg, NotifyMsg,
} from './transport/types';
export { errMsg, RpcError } from './transport/types';
export { RawServer } from './rpc/raw-server';
export { RawClient } from './rpc/raw-client';
export { AsyncQueue } from './transport/async-queue';
export { createMemTransportPair, createLoggedTransport } from './transport/transport-builtin';
export type { TransportLogHandler } from './transport/transport-builtin';
export {
  RpcSchema, RpcImpl, RpcServer, router, createHandler, createMetaHandler, createClient, flattenRouter,
  isProcedure, buildRouteTree, routeLeaves, routeResolve, routeWalk,
} from './rpc/index';
export type {
  ProcedureMeta, ProcedureDef, Router, ClientRouter,
  ProcNode, RouterNode, RouteNode,
  AnyProcedureMeta, AnyProcedureDef, AnyProcedure,
  HandlerBinding,
  RpcImplUnaryConfig, RpcImplServerStreamConfig, RpcImplClientStreamConfig, RpcImplBidiStreamConfig,
  RpcSchemaUnaryConfig, RpcSchemaServerStreamConfig, RpcSchemaClientStreamConfig, RpcSchemaBidiStreamConfig,
  ProcedureCliMeta,
} from './rpc/index';
