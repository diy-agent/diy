/**
 * types.ts — EnvelopeTransport 接口 + 信封类型
 *
 * 协议消息（每个消息都有 type 鉴别器）：
 *   请求:      { type: 'call', id, method, params?, stream? }
 *   响应:      { type: 'call', id, result? | error? }
 *   流数据:    { type: 'data', stream, value }
 *   流结束:    { type: 'end', stream, error? }   —— 只表「完成/输入半关」，不兼职取消
 *   取消:      { type: 'cancel', id? | stream?, reason? } —— 显式取消信封
 *
 * end 与 cancel 语义分工（任务 185）：end 单义（server→client 完成、client→server
 * 输入半关）；整条 RPC 取消一律走 cancel 帧——ack 前（含 unary 全程）按 call.id
 * 寻址、ack 后按 streamId。旧版本收到 cancel 会忽略（无能力协商，CLI/app 同版本发布）。
 */

// ═══════════════════════════════════════════════════
//  流模式（内部路由用，非协议字段）
// ═══════════════════════════════════════════════════

/** @internal */
export type _StreamMode = 'server' | 'client' | 'bidi';

// ═══════════════════════════════════════════════════
//  EnvelopeTransport 接口
// ═══════════════════════════════════════════════════

export interface EnvelopeTransport {
  send(payload: unknown): void;
  /** 注册消息处理器，返回解除注册函数 */
  on(handler: (msg: _Envelope) => void): () => void;
  /** 注册连接断开回调 */
  onClose(cb: () => void): () => void;
}

// ═══════════════════════════════════════════════════
//  StreamHandle — 消费端流接口
//
//  取消有三条通路，各 binding 必须全部接上；少接一条，上游就会在无人消费时继续
//  产出并占用资源（任务 149：renderer 被销毁后 main 侧 agent 多跑 1 分 45 秒，
//  会话互斥锁直到那轮自然结束才释放）：
//    1. AbortSignal             —— 调用方显式取消
//    2. 迭代器 return()          —— for-await 的 break / 循环体抛错 / 外层 return
//                                   （语言规范强制调用的清理路径）
//    3. ClientBinding.dispose()  —— 消费端进程或页面消亡
// ═══════════════════════════════════════════════════

export interface StreamHandle<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

// ═══════════════════════════════════════════════════
//  信封类型（可辨识联合，type 为鉴别器）
//  _ErrorPayload 定义在 rpc/error.ts（统一错误模型）
// ═══════════════════════════════════════════════════

import type { _ErrorPayload } from './error';

/** 调用请求/响应（含流 init-ack） */
/** @internal */
export interface _CallMsg {
  type: 'call';
  id: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: _ErrorPayload;
  /** undefined/false=unary, true=请求分配 streamId, number=携带 streamId */
  stream?: true | number;
}

/** 流数据块 */
/** @internal */
export interface _DataMsg {
  type: 'data';
  stream: number;
  value: unknown;
}

/** 流结束（可带错误，替代独立的 stream-error） */
/** @internal */
export interface _EndMsg {
  type: 'end';
  stream: number;
  error?: _ErrorPayload;
}

/** 显式取消（ack 前按 id、ack 后按 stream；reason 限可序列化 code/message） */
/** @internal */
export interface _CancelMsg {
  type: 'cancel';
  /** ack 前寻址：unary 全程 / 流 init 尚未拿到 streamId */
  id?: number;
  /** ack 后寻址 */
  stream?: number;
  /** 取消原因（有限字段，不传任意 Error）；缺省 = CANCELLED */
  reason?: { code: string; message: string };
}

/** @internal */
export type _Envelope = _CallMsg | _DataMsg | _EndMsg | _CancelMsg;

// 错误模型（_ErrorPayload / RpcError / toRpcError / _toErrorPayload）见 ./error
/** @internal */
export type { _ErrorPayload } from './error';
