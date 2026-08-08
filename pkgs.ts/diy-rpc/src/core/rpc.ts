/**
 * rpc/index.ts — 第3层 RPC：声明式 Procedure 定义 + 服务端/客户端入口
 *
 * 第2层（meta.ts + raw.ts + tree.ts + raw 绑定）提供 meta 类型、router 树工具
 * 与强类型端口；本文件在其上提供：
 *   - RpcSchema / RpcImpl 定义工厂（两种形态）
 *   - router 组合工具（回写 meta.name）
 *   - RpcServer / RpcGateway / RpcForward 服务端入口（以 meta 注册进 raw）
 *   - createTypedClient 客户端入口
 *
 * 依赖方向：index(第3层) → meta/tree/raw(第2层) → transport(第1层)，无循环、分层不倒置。
 */

import { z } from 'zod';
import type { StreamHandle } from './types';
import type { RawServer } from './raw';
import type { _RpcBackend } from './gateway';
import { _flattenRouter, _buildRouteTree, _routeLeaves } from './tree';
import {
  type _HandlerForProc, type ProcedureMeta, type ProcedureDef,
  type _AnyProcedureMeta, type _AnyProcedureDef, type _Router,
} from './meta';

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
  // 遍历整树回写方法全名（相对路径）到每个 meta.name，供 raw 绑定 onXxx(meta, handler) 直接使用。
  for (const { path, def: meta } of _routeLeaves(_buildRouteTree(def))) {
    (meta as { name?: string }).name = path;
  }
  return def;
}

// ═══════════════════════════════════════════════════
//  RpcServer — 第3层服务端统一入口
// ═══════════════════════════════════════════════════

type HandlerFn = (opts: { input: unknown; meta: unknown; stream?: unknown }) => unknown;

/** 按 def 的 stream mode 注册到 raw（handler 收 { input, meta, stream? }） */
function _registerMode(raw: RawServer, def: _AnyProcedureMeta, handler: HandlerFn): void {
  const mode = def._streamMode;
  if (mode === 'unary') {
    raw.onUnary(def, handler as any);
  } else if (mode === 'server') {
    raw.onServerStream(def, handler as any);
  } else if (mode === 'client') {
    raw.onClientStream(def, handler as any);
  } else if (mode === 'bidi') {
    raw.onBidiStream(def, handler as any);
  }
}

/**
 * 第3层 RPC 服务端。
 *
 * 传输无关的纯 handler 注册表：
 *   - 构造时不绑定 transport（只收 router + 可选 scope 前缀），并把完整方法名回写进 meta.name
 *   - 含 call 的 procedure（RpcImpl）构造时自动注册
 *   - 不含 call 的（RpcSchema）通过 .on() 绑定 handler
 *   - registerInto(raw) 把本注册表挂到某个 RawServer（以 meta 强类型注册）
 */
/** @internal */
export class RpcServer implements _RpcBackend {
  readonly scope: string;
  private _raws: RawServer[] = [];
  private _metaToMethod = new Map<_AnyProcedureMeta, string>();
  private _handlers = new Map<_AnyProcedureMeta, HandlerFn>();

  constructor(opts: { router: _Router; scope?: string }) {
    this.scope = opts.scope ?? '';

    // 建立 meta → method 映射（scope 前缀拼到完整方法名前），并把完整名回写进 meta.name
    const flat = _flattenRouter(opts.router);
    for (const [name, def] of Object.entries(flat)) {
      const method = this.scope ? `${this.scope}.${name}` : name;
      this._metaToMethod.set(def, method);
      (def as { name?: string }).name = method;
    }

    // 含 call 的 procedure 自动注册
    this._autoRegister();
  }

  /**
   * 绑定 handler 到某个 procedure。
   * 同时适用于 RpcSchema（必须调）和 RpcImpl（可选覆盖）。
   */
  on<T extends _AnyProcedureMeta>(
    proc: T,
    handler: _HandlerForProc<T>,
  ): void {
    const method = this._metaToMethod.get(proc);
    if (!method) {
      throw new Error(
        `[RpcServer] Procedure not found in router — ` +
        `did you pass the correct meta object?`,
      );
    }
    this._handlers.set(proc, handler as any);
    for (const raw of this._raws) this._registerInto(raw, proc, handler as any);
  }

  /**
   * 把本注册表挂到给定 RawServer。
   * RpcGateway.register(backend) 会调用它，把本 server 所有方法（全名）
   * 注册到来源 transport 的 RawServer 上。
   */
  registerInto(raw: RawServer): void {
    this._raws.push(raw);
    for (const [def, handler] of this._handlers) {
      this._registerInto(raw, def, handler);
    }
    // 含 call 但未显式 on 的也要挂载
    for (const def of this._metaToMethod.keys()) {
      if (this._handlers.has(def)) continue;
      const callFn = (def as unknown as _AnyProcedureDef).call;
      if (typeof callFn === 'function') {
        this._registerInto(raw, def, callFn as HandlerFn);
      }
    }
  }

  /** 销毁：清理所有挂载的 RawServer 监听和流 */
  destroy(): void {
    for (const raw of this._raws) raw.destroy();
    this._raws = [];
    this._metaToMethod.clear();
    this._handlers.clear();
  }

  // ── 内部 ──────────────────────────────────────

  private _autoRegister(): void {
    for (const def of this._metaToMethod.keys()) {
      const callFn = (def as unknown as _AnyProcedureDef).call;
      if (typeof callFn === 'function') {
        this._handlers.set(def, callFn as HandlerFn);
      }
    }
  }

  private _registerInto(raw: RawServer, def: _AnyProcedureMeta, handler: HandlerFn): void {
    _registerMode(raw, def, handler);
  }
}

// ═══════════════════════════════════════════════════
//  Client 工厂（typed）与网关/转发
// ═══════════════════════════════════════════════════

export { createTypedClient } from './typed-client';
export type { TypedClient } from './typed-client';
export { RpcGateway } from './gateway';
/** @internal */
export type { _RpcBackend } from './gateway';
export { RpcForward } from './forward';
/** @internal */
export type { _RpcForwardOptions } from './forward';
