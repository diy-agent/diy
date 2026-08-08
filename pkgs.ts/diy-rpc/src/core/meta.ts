/**
 * meta.ts — 第2层：Procedure 元信息类型 + handler 类型推导 + zod 校验
 *
 * 作为第2层的一部分（与 RawServer/RawClient 端口、各 raw 绑定同层）：
 *   - ProcedureMeta 描述一个 RPC 过程的 schema（input/output/chunk + stream mode）
 *   - _HandlerForProc 从 meta 推导 handler 签名（收 { input, meta, stream? }）
 *   - _validateInput 做 zod 校验（ZodError → INVALID_ARGUMENT）
 * raw 绑定用这些类型实现强类型注册（onUnary(meta, handler) 等）；第3层（index.ts）import 本文件。
 */

import { z } from 'zod';
import type { StreamHandle } from './types';
import { toRpcError } from './error';

/** @internal */
export interface _ProcedureCliMeta {
  description?: string;
}

/** 从 ProcedureMeta 的类型参数推导 handler 签名 */
type HandlerFor<TIn, TOut, TChIn, TChOut, TMode> =
  TMode extends 'unary'   ? (opts: { input: TIn }) => TOut | Promise<TOut> :
  TMode extends 'server'  ? (opts: { input: TIn }) => AsyncGenerator<TOut> :
  TMode extends 'client'  ? (opts: { input: TIn; stream: StreamHandle<TChIn> }) => TOut | Promise<TOut> :
  TMode extends 'bidi'    ? (opts: { input: TIn; stream: StreamHandle<TChIn> }) => AsyncGenerator<TChOut> :
  never;

/** 从 ProcedureMeta 类型参数推导 handler 签名（供 onXxx / RpcServer.on 使用） */
/** @internal */
export type _HandlerForProc<T> =
  T extends ProcedureMeta<infer TIn, infer TOut, infer TChIn, infer TChOut, infer TMode>
    ? HandlerFor<TIn, TOut, TChIn, TChOut, TMode>
    : never;

// ═══════════════════════════════════════════════════
//  ProcedureMeta — 元信息形式（半完成态）
// ═══════════════════════════════════════════════════

export interface ProcedureMeta<
  TIn = unknown,
  TOut = unknown,
  TChIn = never,
  TChOut = never,
  TMode extends string = 'unary',
> {
  readonly _type: 'procedure';
  readonly _input: TIn;
  readonly _output: TOut;
  readonly _chunkIn: TChIn;
  readonly _chunkOut: TChOut;
  readonly _streamMode: TMode;
  inputSchema?: z.ZodType<TIn>;
  outputSchema?: z.ZodType<TOut>;
  chunkInSchema?: z.ZodType<TChIn>;
  chunkOutSchema?: z.ZodType<TChOut>;
  summary?: string;
  description?: string;
  cliDesc?: _ProcedureCliMeta;
  /**
   * 方法全名（相对路径，如 'math.add'）。由 router() 包裹时遍历回写；
   * RpcServer 构造时按 scope 覆盖为完整全名（如 'diy.app.task.create'）。
   * 裸对象（未经 router()/RpcServer）无此字段。
   */
  readonly name?: string;
}

// ═══════════════════════════════════════════════════
//  ProcedureDef — 完整形式（含 call）
// ═══════════════════════════════════════════════════

export interface ProcedureDef<
  TIn = unknown,
  TOut = unknown,
  TChIn = never,
  TChOut = never,
  TMode extends string = 'unary',
> extends ProcedureMeta<TIn, TOut, TChIn, TChOut, TMode> {
  call: (opts: { input: TIn; meta?: unknown }) => unknown;
}

/** @internal */
export type _AnyProcedureMeta = ProcedureMeta<any, any, any, any, any>;
/** @internal */
export type _AnyProcedureDef = ProcedureDef<any, any, any, any, any>;
/** @deprecated 用 _AnyProcedureMeta */
/** @internal */
export type _AnyProcedure = _AnyProcedureDef;
/** @internal */
export interface _Router { [key: string]: _AnyProcedureMeta | _Router; }

// ═══════════════════════════════════════════════════
//  zod 校验
// ═══════════════════════════════════════════════════

/** 校验 input：zod parse 失败 → INVALID_ARGUMENT（非 INTERNAL） */
/** @internal */
export function _validateInput(def: _AnyProcedureMeta, input: unknown): unknown {
  if (!def.inputSchema) return input;
  try {
    return def.inputSchema.parse(input);
  } catch (e) {
    throw toRpcError(e); // ZodError → INVALID_ARGUMENT
  }
}
