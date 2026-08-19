/**
 * meta.ts — 第2层：Procedure 元信息类型 + handler 类型推导 + zod 校验
 *
 * 作为第2层的一部分（与 ServerBinding/ClientBinding 端口、各具体绑定同层）：
 *   - ProcedureMeta 描述一个 RPC 过程的 schema（input/output/chunk + stream mode）
 *   - _HandlerForProc 从 meta 推导 handler 签名（收 { input, meta, stream? }）
 *   - _validateInput 做 zod 校验（ZodError → INVALID_ARGUMENT）
 * ServerBinding 用这些类型实现强类型注册（on(meta, handler)）；第3层（index.ts）import 本文件。
 */

import { z } from 'zod';
import type { StreamHandle } from './types';
import { toRpcError } from './error';

/** 从 ProcedureMeta 的类型参数推导 handler 签名 */
type HandlerFor<TIn, TOut, TChIn, TChOut, TMode> =
  TMode extends 'unary'   ? (opts: { input: TIn }) => TOut | Promise<TOut> :
  TMode extends 'server'  ? (opts: { input: TIn }) => AsyncGenerator<TOut> :
  TMode extends 'client'  ? (opts: { input: TIn; stream: StreamHandle<TChIn> }) => TOut | Promise<TOut> :
  TMode extends 'bidi'    ? (opts: { input: TIn; stream: StreamHandle<TChIn> }) => AsyncGenerator<TChOut> :
  never;

/** 从 ProcedureMeta 类型参数推导 handler 签名（供 on() / onForward 使用） */
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
  /** 命令描述（父命令与叶子命令统一） */
  desc?: string;
  /** 单行简介 = desc 首行（命令列表/父命令列表里展示）。_makeMeta 创建时从 desc 提取。 */
  title?: string;
  /**
   * 父命令的子命令容器（可选）。有 children = 父命令（可下钻子命令，无 call），
   * 无 children = 叶子命令（可执行）。二者统一为 ProcedureMeta，desc 字段一致。
   */
  children?: _Router;
  /**
   * 方法全名（相对路径，如 'math.add'）。由 router() 包裹时遍历回写（父命令 group 与叶子都有）；
   * router() 回写完整全名（如 'diy.app.task.create'）。
   * 裸对象（未经 router()）无此字段。
   */
  readonly name?: string;
}

/** @internal */
export type _AnyProcedureMeta = ProcedureMeta<any, any, any, any, any>;

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
