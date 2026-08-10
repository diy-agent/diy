/**
 * rpc/index.ts — 第3层 RPC：声明式 Procedure 定义 + 服务端/客户端入口
 *
 * 第2层（meta.ts + server-binding.ts + tree.ts + ServerBinding 绑定）提供 meta 类型、router 树工具
 * 与强类型端口；本文件在其上提供：
 *   - RpcSchema / RpcImpl 定义工厂（两种形态）
 *   - router 组合工具（回写 meta.name）
 *   - ServerBinding 注册入口（onXxx / register / registerRouter / onForward）
 *   - createTypedClient 客户端入口
 *
 * 依赖方向：index(第3层) → meta/tree/server-binding(第2层) → transport(第1层)，无循环、分层不倒置。
 */

import { z } from 'zod';
import type { StreamHandle } from './types';
import { _buildRouteTree, _routeLeaves } from './_tree';
import { type ProcedureMeta, type ProcedureDef, type _Router } from './meta';

// ═══════════════════════════════════════════════════
//  RpcSchema 配置类型（纯定义，无 call）
// ═══════════════════════════════════════════════════

/** @internal */
export interface _RpcSchemaUnaryConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput> {
  summary?: string;
  description?: string;
  input: TSchema;
  output: z.ZodType<TOutput>;
}

/** @internal */
export interface _RpcSchemaServerStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput> {
  summary?: string;
  description?: string;
  input: TSchema;
  output: z.ZodType<TOutput>;
}

/** @internal */
export interface _RpcSchemaClientStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput> {
  summary?: string;
  description?: string;
  input: TSchema;
  chunkIn: z.ZodType<TChunk>;
  output: z.ZodType<TOutput>;
}

/** @internal */
export interface _RpcSchemaBidiStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut> {
  summary?: string;
  description?: string;
  input: TSchema;
  chunkIn: z.ZodType<TChunkIn>;
  chunkOut: z.ZodType<TChunkOut>;
}

// ═══════════════════════════════════════════════════
//  RpcImpl 配置类型（含 call）
// ═══════════════════════════════════════════════════

/** @internal */
export interface _RpcImplUnaryConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput>
  extends _RpcSchemaUnaryConfig<TSchema, TOutput> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; meta?: unknown }) => TOutput | Promise<TOutput>;
}

/** @internal */
export interface _RpcImplServerStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput>
  extends _RpcSchemaServerStreamConfig<TSchema, TOutput> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; meta?: unknown }) => AsyncGenerator<TOutput>;
}

/** @internal */
export interface _RpcImplClientStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput>
  extends _RpcSchemaClientStreamConfig<TSchema, TChunk, TOutput> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; stream: StreamHandle<TChunk>; meta?: unknown }) => TOutput | Promise<TOutput>;
}

/** @internal */
export interface _RpcImplBidiStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut>
  extends _RpcSchemaBidiStreamConfig<TSchema, TChunkIn, TChunkOut> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; stream: StreamHandle<TChunkIn>; meta?: unknown }) => AsyncGenerator<TChunkOut>;
}

// ═══════════════════════════════════════════════════
//  RpcSchema — 纯定义工厂（返回 ProcedureMeta，无 call）
// ═══════════════════════════════════════════════════

export class RpcSchema {
  static unary<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
    config: _RpcSchemaUnaryConfig<TSchema, TOutput>,
  ): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, never, 'unary'> {
    return _makeMeta(config, 'unary', z.object(config.input), config.output);
  }

  static serverStream<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
    config: _RpcSchemaServerStreamConfig<TSchema, TOutput>,
  ): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, TOutput, 'server'> {
    return _makeMeta(config, 'server', z.object(config.input), config.output);
  }

  static clientStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput>(
    config: _RpcSchemaClientStreamConfig<TSchema, TChunk, TOutput>,
  ): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, TChunk, never, 'client'> {
    return _makeMeta(config, 'client', z.object(config.input), config.output, config.chunkIn);
  }

  static bidiStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut>(
    config: _RpcSchemaBidiStreamConfig<TSchema, TChunkIn, TChunkOut>,
  ): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TChunkOut, TChunkIn, TChunkOut, 'bidi'> {
    return _makeMeta(config, 'bidi', z.object(config.input), undefined, config.chunkIn, config.chunkOut);
  }
}

// ═══════════════════════════════════════════════════
//  RpcImpl — 完整定义工厂（返回 ProcedureDef，含 call）
// ═══════════════════════════════════════════════════

export class RpcImpl {
  static unary<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
    config: _RpcImplUnaryConfig<TSchema, TOutput>,
  ): ProcedureDef<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, never, 'unary'> {
    const meta = _makeMeta(config, 'unary', z.object(config.input), config.output);
    meta.call = (opts: any) => config.call({ input: opts.input, meta: opts.meta });
    return meta;
  }

  static serverStream<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
    config: _RpcImplServerStreamConfig<TSchema, TOutput>,
  ): ProcedureDef<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, TOutput, 'server'> {
    const meta = _makeMeta(config, 'server', z.object(config.input), config.output);
    meta.call = (opts: any) => config.call({ input: opts.input, meta: opts.meta });
    return meta;
  }

  static clientStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput>(
    config: _RpcImplClientStreamConfig<TSchema, TChunk, TOutput>,
  ): ProcedureDef<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, TChunk, never, 'client'> {
    const meta = _makeMeta(config, 'client', z.object(config.input), config.output, config.chunkIn);
    meta.call = (opts: any) => config.call({ input: opts.input, stream: opts.stream, meta: opts.meta });
    return meta;
  }

  static bidiStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut>(
    config: _RpcImplBidiStreamConfig<TSchema, TChunkIn, TChunkOut>,
  ): ProcedureDef<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TChunkOut, TChunkIn, TChunkOut, 'bidi'> {
    const meta = _makeMeta(config, 'bidi', z.object(config.input), undefined, config.chunkIn, config.chunkOut);
    meta.call = (opts: any) => config.call({ input: opts.input, stream: opts.stream, meta: opts.meta });
    return meta;
  }
}

// ═══════════════════════════════════════════════════
//  内部工厂底层
// ═══════════════════════════════════════════════════

function _makeMeta(
  config: { summary?: string; description?: string },
  streamMode: string,
  inputSchema: z.ZodTypeAny,
  outputSchema?: z.ZodTypeAny,
  chunkInSchema?: z.ZodTypeAny,
  chunkOutSchema?: z.ZodTypeAny,
): any {
  const meta: any = {
    _type: 'procedure',
    _input: undefined,
    _output: undefined,
    _chunkIn: undefined,
    _chunkOut: undefined,
    _streamMode: streamMode,
    inputSchema,
    outputSchema,
    chunkInSchema,
    chunkOutSchema,
    summary: config.summary,
    description: config.description,
    cliDesc: undefined,
  };
  return meta;
}

// ═══════════════════════════════════════════════════
//  _Router 组合工具
// ═══════════════════════════════════════════════════

/** @internal */
export function router<T extends _Router>(def: T): T {
  // 遍历整树回写方法全名（相对路径）到每个 meta.name，供 ServerBinding onXxx(meta, handler) 直接使用。
  for (const { path, def: meta } of _routeLeaves(_buildRouteTree(def))) {
    (meta as { name?: string }).name = path;
  }
  return def;
}

// ═══════════════════════════════════════════════════
//  Client 工厂（typed）与转发
// ═══════════════════════════════════════════════════

export { createTypedClient } from './typed-client';
export type { TypedClient } from './typed-client';
