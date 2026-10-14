/**
 * core/index.ts — @diy/rpc 平台无关浏览器安全核 barrel
 *
 * 这是 @diy/rpc 根导出的统一公共代码。只含纯 TS + zod，无 node/electron/http/ws 依赖，
 * tsconfig.browser 只 include 本目录（+ src/index.ts 根 barrel）。具体线协议绑定
 * （transport/http|ws|electron）与 CLI（cli/）另立目录，经子路径导出。
 */

// Zod 扩展：cliArg / cliOption（side-effect import，必须在任何 schema 定义前执行）
//
// 「schema 定义前」是**字面**要求，不是顺序洁癖：zod v4 的 schema 实例在创建时就把原型链定死，
// 事后往 `z.ZodType.prototype` 上补方法看不见（实测：先建 `z.enum(...)` 再打补丁 → 该实例上
// 没有 `cliArg`）。而**打包会把被多个 chunk 共用的模块提升成独立 chunk，先于入口模块体求值** ——
// 于是一个带 schema 的模块只要被拖进共享 chunk，它的 schema 就"先于补丁"创建了，症状是启动即
// `TypeError: TaskStateSchema.cliArg is not a function`（实测于 ##322：把共享常量模块
// shared/task-head.ts 牵进了 shared/task-detail.ts → main/core/task-state.ts）。
import './_cli-meta';

// 传输类型（消费者可见的最小面：信封内部类型 _Envelope/_CallMsg/_DataMsg/_EndMsg/_StreamMode 不外泄）
export type { EnvelopeTransport, StreamHandle } from './types';
// 错误（跨线抛出的公共错误类型；序列化内部件 _toErrorPayload/_fromErrorPayload 不外泄）
export { RpcError, toRpcError } from './error';
// 端口接口
export type { ServerBinding, ClientBinding, CallOptions } from './server-binding';
// meta 类型：RpcSchema 工厂的返回类型，消费方导出定义时被推断类型引用，必须可命名
export type { ProcedureMeta } from './meta';
// _Router 是 ProcedureMeta.children 的类型（RpcSchema 返回类型被消费方导出值引用），
// 不导出则消费方 `export const apiDef = router({...})` 触发 TS2883（与 ProcedureMeta 同理）。
export type { _Router } from './meta';
// 具体绑定 + 内存通道
export { ChannelServerBinding } from './channel-server-binding';
export { ChannelClientBinding } from './channel-client-binding';
export { createMemTransportPair } from './mem';
// 第3层语义 API
export {
  RpcSchema,
  createTypedClient,
} from './rpc';
export type { TypedClient } from './rpc';
