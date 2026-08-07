// ═══ Zod 扩展：cliArg / cliOption（side-effect import，必须在任何 schema 定义前执行）
// meta 本身无 Node 依赖，浏览器 schema 也用它打标记
import './rpc/cli-rpc/meta';

// 传输层类型（消费者可见的最小面：信封内部类型 Envelope/CallMsg/DataMsg/EndMsg/StreamMode 不外泄）
export type { Transport, StreamHandle } from './transport/types';
// 错误（跨线抛出的公共错误类型；序列化内部件 toErrorPayload/fromErrorPayload 不外泄）
export { RpcError, toRpcError } from './rpc/error';
// 端口接口
export type { RawServer, RawClient, CallOptions } from './rpc/raw';
// meta 类型：RpcSchema/RpcImpl 工厂的返回类型，消费方导出定义时被推断类型引用，必须可命名
export type { ProcedureMeta, ProcedureDef } from './rpc/meta';
// 具体绑定 + 内存通道
export { ChannelRawServer } from './rpc/raw-server';
export { ChannelRawClient } from './rpc/raw-client';
export { createMemTransportPair } from './transport/transport-builtin';
// 第3层语义 API
export {
  RpcSchema, RpcImpl, RpcServer, router,
  createTypedClient, RpcGateway, RpcForward,
} from './rpc/index';
export type { TypedClient } from './rpc/index';
