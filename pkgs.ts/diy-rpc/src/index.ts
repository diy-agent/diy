// ═══ Zod 扩展：cliArg / cliOption（side-effect import，必须在任何 schema 定义前执行）
// meta 本身无 Node 依赖，浏览器 schema 也用它打标记
import './rpc/cli-rpc/meta';

export type {
  Transport, StreamMode, StreamHandle, Envelope,
  CallMsg, DataMsg, EndMsg,
} from './transport/types';
export type { ErrorPayload, ErrorProtocolExt } from './rpc/error';
export { RpcError, toRpcError, toErrorPayload, fromErrorPayload } from './rpc/error';
// 端口接口
export type { RawServer, RawClient, CallOptions } from './rpc/raw';
// 具体绑定
export { ChannelRawServer } from './rpc/raw-server';
export { ChannelRawClient } from './rpc/raw-client';
export { AsyncQueue } from './rpc/async-queue';
export { createMemTransportPair, createLoggedTransport } from './transport/transport-builtin';
export type { TransportLogHandler } from './transport/transport-builtin';
export {
  RpcSchema, RpcImpl, RpcServer, router, createHandler, createMetaHandler, createClient, flattenRouter,
  createTypedClient, validateInput,
  RpcGateway, RpcForward,
  isProcedure, buildRouteTree, routeLeaves, routeResolve, routeWalk,
} from './rpc/index';
export type {
  ProcedureMeta, ProcedureDef, Router, ClientRouter, TypedClient,
  ProcNode, RouterNode, RouteNode,
  AnyProcedureMeta, AnyProcedureDef, AnyProcedure,
  HandlerBinding, HandlerForProc,
  RpcBackend, RpcForwardOptions,
  RpcImplUnaryConfig, RpcImplServerStreamConfig, RpcImplClientStreamConfig, RpcImplBidiStreamConfig,
  RpcSchemaUnaryConfig, RpcSchemaServerStreamConfig, RpcSchemaClientStreamConfig, RpcSchemaBidiStreamConfig,
  ProcedureCliMeta,
} from './rpc/index';
