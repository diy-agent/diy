/**
 * core/index.ts — @diy/rpc 平台无关浏览器安全核 barrel
 *
 * 这是 @diy/rpc 根导出的统一公共代码。只含纯 TS + zod，无 node/electron/http/ws 依赖，
 * tsconfig.browser 只 include 本目录（+ src/index.ts 根 barrel）。具体线协议绑定
 * （transport/http|ws|electron）与 CLI（cli/）另立目录，经子路径导出。
 */

// Zod 扩展：cliArg / cliOption（side-effect import，必须在任何 schema 定义前执行）
import './_cli-meta';

// 传输类型（消费者可见的最小面：信封内部类型 _Envelope/_CallMsg/_DataMsg/_EndMsg/_StreamMode 不外泄）
export type { EnvelopeTransport, StreamHandle } from './types';
// 错误（跨线抛出的公共错误类型；序列化内部件 _toErrorPayload/_fromErrorPayload 不外泄）
export { RpcError, toRpcError } from './error';
// 端口接口
export type { ServerBinding, ClientBinding, CallOptions } from './server-binding';
// meta 类型：RpcSchema 工厂的返回类型，消费方导出定义时被推断类型引用，必须可命名
export type { ProcedureMeta } from './meta';
// 具体绑定 + 内存通道
export { ChannelServerBinding } from './channel-server-binding';
export { ChannelClientBinding } from './channel-client-binding';
export { createMemTransportPair } from './mem';
// 第3层语义 API
export {
  RpcSchema, router,
  createTypedClient,
} from './rpc';
export type { TypedClient } from './rpc';
