/**
 * types.ts — Transport 接口 + 信封类型
 *
 * 协议消息（每个消息都有 type 鉴别器）：
 *   请求:      { type: 'call', id, method, params?, stream? }
 *   响应:      { type: 'call', id, result? | error? }
 *   流数据:    { type: 'data', stream, value }
 *   流结束:    { type: 'end', stream, error? }
 *   通知:      { type: 'notify', method, params? }
 */

// ═══════════════════════════════════════════════════
//  流模式（内部路由用，非协议字段）
// ═══════════════════════════════════════════════════

export type StreamMode = 'server' | 'client' | 'bidi';

// ═══════════════════════════════════════════════════
//  Transport 接口
// ═══════════════════════════════════════════════════

export interface Transport {
  send(payload: unknown): void;
  /** 注册消息处理器，返回解除注册函数 */
  on(handler: (msg: Envelope) => void): () => void;
  /** 注册连接断开回调 */
  onClose(cb: () => void): () => void;
}

// ═══════════════════════════════════════════════════
//  StreamHandle — 消费端流接口（不可取消，取消由 AbortSignal 驱动）
// ═══════════════════════════════════════════════════

export interface StreamHandle<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

// ═══════════════════════════════════════════════════
//  信封类型（可辨识联合，type 为鉴别器）
//  ErrorPayload 定义在 rpc/error.ts（统一错误模型）
// ═══════════════════════════════════════════════════

import type { ErrorPayload } from '../rpc/error';

/** 调用请求/响应（含流 init-ack） */
export interface CallMsg {
  type: 'call';
  id: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: ErrorPayload;
  /** undefined/false=unary, true=请求分配 streamId, number=携带 streamId */
  stream?: true | number;
}

/** 流数据块 */
export interface DataMsg {
  type: 'data';
  stream: number;
  value: unknown;
}

/** 流结束（可带错误，替代独立的 stream-error） */
export interface EndMsg {
  type: 'end';
  stream: number;
  error?: ErrorPayload;
}

/** 通知 */
export interface NotifyMsg {
  type: 'notify';
  method: string;
  params?: unknown;
}

export type Envelope = CallMsg | DataMsg | EndMsg | NotifyMsg;

// 错误模型（ErrorPayload / RpcError / toRpcError / toErrorPayload）见 ../rpc/error
export type { ErrorPayload } from '../rpc/error';
