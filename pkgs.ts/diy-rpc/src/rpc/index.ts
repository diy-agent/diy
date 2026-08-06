/**
 * rpc/index.ts — 第3层 RPC：声明式 Procedure 定义
 *
 * 两种定义形态，由两个静态工厂类提供：
 *   1. RpcSchema — 纯定义（不含 call），对应 ProcedureMeta
 *   2. RpcImpl   — 完整定义（含 call），对应 ProcedureDef
 *
 * 角色：在第2层 Client/Server 之上提供类型安全的声明式 API。
 *       应用程序代码只应该使用这层。
 */

import { z } from 'zod';
import type { CallOptions } from './raw-client';
import type { StreamHandle } from '../transport/types';
import { toRpcError } from './error';
import type { RawClient, RawServer } from './raw';
import type { RpcBackend } from './gateway';

// ═══════════════════════════════════════════════════
//  类型基础
// ═══════════════════════════════════════════════════

type ProcedureMode = 'unary' | 'server' | 'client' | 'bidi';

export interface ProcedureCliMeta {
  description?: string;
}

/** Handler 绑定：meta 对象 + 其原始 handler */
export interface HandlerBinding {
  meta: AnyProcedureMeta;
  handler: (params: unknown, stream?: unknown) => unknown;
}

/** 从 ProcedureMeta 的类型参数推导 handler 签名 */
type HandlerFor<TIn, TOut, TChIn, TChOut, TMode> =
  TMode extends 'unary'   ? (opts: { input: TIn }) => TOut | Promise<TOut> :
  TMode extends 'server'  ? (opts: { input: TIn }) => AsyncGenerator<TOut> :
  TMode extends 'client'  ? (opts: { input: TIn; stream: StreamHandle<TChIn> }) => TOut | Promise<TOut> :
  TMode extends 'bidi'    ? (opts: { input: TIn; stream: StreamHandle<TChIn> }) => AsyncGenerator<TChOut> :
  never;

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
  cliDesc?: ProcedureCliMeta;

  /** 绑定 handler，返回绑定对供 createMetaHandler 消费 */
  on(handler: HandlerFor<TIn, TOut, TChIn, TChOut, TMode>): HandlerBinding;
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

export type AnyProcedureMeta = ProcedureMeta<any, any, any, any, any>;
export type AnyProcedureDef = ProcedureDef<any, any, any, any, any>;
/** @deprecated 用 AnyProcedureMeta */
export type AnyProcedure = AnyProcedureDef;
export interface Router { [key: string]: AnyProcedureMeta | Router; }

// ═══════════════════════════════════════════════════
//  RpcSchema 配置类型（纯定义，无 call）
// ═══════════════════════════════════════════════════

export interface RpcSchemaUnaryConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput> {
  summary?: string;
  description?: string;
  input: TSchema;
  output: z.ZodType<TOutput>;
}

export interface RpcSchemaServerStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput> {
  summary?: string;
  description?: string;
  input: TSchema;
  output: z.ZodType<TOutput>;
}

export interface RpcSchemaClientStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput> {
  summary?: string;
  description?: string;
  input: TSchema;
  chunkIn: z.ZodType<TChunk>;
  output: z.ZodType<TOutput>;
}

export interface RpcSchemaBidiStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut> {
  summary?: string;
  description?: string;
  input: TSchema;
  chunkIn: z.ZodType<TChunkIn>;
  chunkOut: z.ZodType<TChunkOut>;
}

// ═══════════════════════════════════════════════════
//  RpcImpl 配置类型（含 call）
// ═══════════════════════════════════════════════════

export interface RpcImplUnaryConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput>
  extends RpcSchemaUnaryConfig<TSchema, TOutput> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; meta?: unknown }) => TOutput | Promise<TOutput>;
}

export interface RpcImplServerStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput>
  extends RpcSchemaServerStreamConfig<TSchema, TOutput> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; meta?: unknown }) => AsyncGenerator<TOutput>;
}

export interface RpcImplClientStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput>
  extends RpcSchemaClientStreamConfig<TSchema, TChunk, TOutput> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; stream: StreamHandle<TChunk>; meta?: unknown }) => TOutput | Promise<TOutput>;
}

export interface RpcImplBidiStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut>
  extends RpcSchemaBidiStreamConfig<TSchema, TChunkIn, TChunkOut> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; stream: StreamHandle<TChunkIn>; meta?: unknown }) => AsyncGenerator<TChunkOut>;
}

// ═══════════════════════════════════════════════════
//  RpcSchema — 纯定义工厂（返回 ProcedureMeta，无 call）
// ═══════════════════════════════════════════════════

export class RpcSchema {
  static unary<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
    config: RpcSchemaUnaryConfig<TSchema, TOutput>,
  ): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, never, 'unary'> {
    return _makeMeta(config, 'unary', z.object(config.input), config.output);
  }

  static serverStream<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
    config: RpcSchemaServerStreamConfig<TSchema, TOutput>,
  ): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, TOutput, 'server'> {
    return _makeMeta(config, 'server', z.object(config.input), config.output);
  }

  static clientStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput>(
    config: RpcSchemaClientStreamConfig<TSchema, TChunk, TOutput>,
  ): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, TChunk, never, 'client'> {
    return _makeMeta(config, 'client', z.object(config.input), config.output, config.chunkIn);
  }

  static bidiStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut>(
    config: RpcSchemaBidiStreamConfig<TSchema, TChunkIn, TChunkOut>,
  ): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TChunkOut, TChunkIn, TChunkOut, 'bidi'> {
    return _makeMeta(config, 'bidi', z.object(config.input), undefined, config.chunkIn, config.chunkOut);
  }
}

// ═══════════════════════════════════════════════════
//  RpcImpl — 完整定义工厂（返回 ProcedureDef，含 call）
// ═══════════════════════════════════════════════════

export class RpcImpl {
  static unary<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
    config: RpcImplUnaryConfig<TSchema, TOutput>,
  ): ProcedureDef<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, never, 'unary'> {
    const meta = _makeMeta(config, 'unary', z.object(config.input), config.output);
    meta.call = (opts: any) => config.call({ input: opts.input, meta: opts.meta });
    return meta;
  }

  static serverStream<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
    config: RpcImplServerStreamConfig<TSchema, TOutput>,
  ): ProcedureDef<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, TOutput, 'server'> {
    const meta = _makeMeta(config, 'server', z.object(config.input), config.output);
    meta.call = (opts: any) => config.call({ input: opts.input, meta: opts.meta });
    return meta;
  }

  static clientStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput>(
    config: RpcImplClientStreamConfig<TSchema, TChunk, TOutput>,
  ): ProcedureDef<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, TChunk, never, 'client'> {
    const meta = _makeMeta(config, 'client', z.object(config.input), config.output, config.chunkIn);
    meta.call = (opts: any) => config.call({ input: opts.input, stream: opts.stream, meta: opts.meta });
    return meta;
  }

  static bidiStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut>(
    config: RpcImplBidiStreamConfig<TSchema, TChunkIn, TChunkOut>,
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
    on(handler: any) {
      return { meta: this, handler };
    },
  };
  return meta;
}

// ═══════════════════════════════════════════════════
//  Router 工具
// ═══════════════════════════════════════════════════

export function isProcedure(v: unknown): v is AnyProcedureMeta {
  return typeof v === 'object' && v !== null && (v as AnyProcedureMeta)._type === 'procedure';
}

export type ProcNode = {
  kind: 'proc';
  name: string;
  path: string;
  def: AnyProcedureMeta;
  parent: RouterNode | null;
};

export type RouterNode = {
  kind: 'router';
  name: string;
  path: string;
  children: RouteNode[];
  parent: RouterNode | null;
};

export type RouteNode = ProcNode | RouterNode;

const ROOT_NAME = '';

export function buildRouteTree(
  router: Router,
  parent: RouterNode | null = null,
  prefix = '',
): RouterNode {
  const name = prefix ? (prefix.split('.').pop() ?? ROOT_NAME) : ROOT_NAME;
  const path = prefix;

  const children: RouteNode[] = [];
  for (const [key, val] of Object.entries(router)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (isProcedure(val)) {
      children.push({ kind: 'proc', name: key, path: childPath, def: val, parent: null as any });
    } else {
      children.push(buildRouteTree(val as Router, null as any, childPath));
    }
  }

  const node: RouterNode = { kind: 'router', name, path, children, parent };
  for (const c of children) (c as { parent: RouterNode }).parent = node;
  return node;
}

export function routeLeaves(root: RouterNode): ProcNode[] {
  const out: ProcNode[] = [];
  for (const c of root.children) {
    if (c.kind === 'proc') out.push(c);
    else out.push(...routeLeaves(c));
  }
  return out;
}

export function routeResolve(
  root: RouterNode,
  args: string[],
): ProcNode | RouterNode | null {
  if (args.length === 0) return root;
  const key = args[0]!;
  const child = root.children.find((c) => c.name === key);
  if (!child) return null;
  if (child.kind === 'proc') return child;
  if (args.length === 1) return child;
  return routeResolve(child, args.slice(1));
}

export function routeWalk(
  root: RouterNode,
  visitor: (node: RouteNode) => void,
): void {
  for (const c of root.children) {
    visitor(c);
    if (c.kind === 'router') routeWalk(c, visitor);
  }
}

export function router<T extends Router>(def: T): T {
  return def;
}

/** 拍平嵌套 router 为 method→AnyProcedureMeta 映射 */
export function flattenRouter(r: Router): Record<string, AnyProcedureMeta> {
  const result: Record<string, AnyProcedureMeta> = {};
  for (const { path, def } of routeLeaves(buildRouteTree(r))) {
    result[path] = def;
  }
  return result;
}

// ═══════════════════════════════════════════════════
//  createHandler / createMetaHandler
// ═══════════════════════════════════════════════════

/** 校验 input：zod parse 失败 → INVALID_ARGUMENT（非 INTERNAL） */
function validateInput(def: AnyProcedureMeta, input: unknown): unknown {
  if (!def.inputSchema) return input;
  try {
    return def.inputSchema.parse(input);
  } catch (e) {
    throw toRpcError(e); // ZodError → INVALID_ARGUMENT
  }
}

/** 内部共享：遍历 router 树 + 注册 handler 到 transport */
function _registerRouter(opts: {
  router: Router;
  transport: RawServer;
  handlers: Map<AnyProcedureMeta, (params: unknown, stream?: unknown) => unknown>;
}) {
  const { transport: tx } = opts;
  const flat = flattenRouter(opts.router);

  for (const [name, def] of Object.entries(flat)) {
    const mode = def._streamMode;
    const handler = opts.handlers.get(def) ?? (def as any).call;
    if (!handler) {
      throw new Error(`[createHandler] No handler for procedure "${name}" — provide via .on() or use RpcImpl with call`);
    }

    if (mode === 'unary') {
      tx.onUnary(name, ((raw: unknown) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = validateInput(def, input);
        return handler({ input: validated, meta: meta ?? {} });
      }) as any);
    } else if (mode === 'server') {
      tx.onServerStream(name, ((raw: unknown) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = validateInput(def, input);
        return handler({ input: validated, meta: meta ?? {} });
      }) as any);
    } else if (mode === 'client') {
      tx.onClientStream(name, ((raw: unknown, chunks: StreamHandle<any>) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = validateInput(def, input);
        const validatedChunks = def.chunkInSchema ? (chunks as any) : chunks;
        return handler({ input: validated, meta: meta ?? {}, stream: validatedChunks });
      }) as any);
    } else if (mode === 'bidi') {
      tx.onBidiStream(name, ((raw: unknown, incoming: StreamHandle<any>) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = validateInput(def, input);
        const validatedChunks = def.chunkInSchema ? (incoming as any) : incoming;
        return handler({ input: validated, meta: meta ?? {}, stream: validatedChunks });
      }) as any);
    }
  }
}

/**
 * 注册完整定义（含 call）的 router。
 * 所有 procedure 必须通过 RpcImpl.unary/serverStream/... 提供 inline call。
 */
export function createHandler(opts: {
  router: Router;
  transport: RawServer;
}) {
  _registerRouter({
    router: opts.router,
    transport: opts.transport,
    handlers: new Map(),
  });
}

/**
 * 注册元信息 router（半完成态），需要先通过 .on() 绑定 handler。
 * handlers 由 RpcSchema.unary/... 返回的 meta 对象的 .on() 方法产生。
 */
export function createMetaHandler(opts: {
  router: Router;
  transport: RawServer;
  handlers: HandlerBinding[];
}) {
  const handlerMap = new Map<AnyProcedureMeta, (params: unknown, stream?: unknown) => unknown>();
  for (const b of opts.handlers) {
    handlerMap.set(b.meta, b.handler);
  }
  _registerRouter({
    router: opts.router,
    transport: opts.transport,
    handlers: handlerMap,
  });
}

// ═══════════════════════════════════════════════════
//  RpcServer — 第3层服务端统一入口
// ═══════════════════════════════════════════════════

/** 从 ProcedureMeta 类型参数推导 handler 签名 */
type HandlerForProc<T> =
  T extends ProcedureMeta<infer TIn, infer TOut, infer TChIn, infer TChOut, infer TMode>
    ? HandlerFor<TIn, TOut, TChIn, TChOut, TMode>
    : never;

/**
 * 第3层 RPC 服务端。
 *
 * 传输无关的纯 handler 注册表：
 *   - 构造时不绑定 transport（只收 router + 可选 scope 前缀）
 *   - 含 call 的 procedure（RpcImpl）构造时自动注册
 *   - 不含 call 的（RpcSchema）通过 .on() 绑定 handler
 *   - registerInto(raw) 把本注册表挂到某个 RawServer（供 RpcGateway 使用）
 *
 * 替代手动组合 new RawServer() + createHandler()/createMetaHandler()。
 */
export class RpcServer implements RpcBackend {
  readonly scope: string;
  private _raws: RawServer[] = [];
  private _metaToMethod = new Map<AnyProcedureMeta, string>();
  private _handlers = new Map<AnyProcedureMeta, (params: unknown, stream?: unknown) => unknown>();

  constructor(opts: { router: Router; scope?: string }) {
    this.scope = opts.scope ?? '';

    // 建立 meta → method 映射（scope 前缀拼到完整方法名前）
    const flat = flattenRouter(opts.router);
    for (const [name, def] of Object.entries(flat)) {
      this._metaToMethod.set(def, this.scope ? `${this.scope}.${name}` : name);
    }

    // 含 call 的 procedure 自动注册
    this._autoRegister();
  }

  /**
   * 绑定 handler 到某个 procedure。
   * 同时适用于 RpcSchema（必须调）和 RpcImpl（可选覆盖）。
   */
  on<T extends AnyProcedureMeta>(
    proc: T,
    handler: HandlerForProc<T>,
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
      const callFn = (def as unknown as AnyProcedureDef).call;
      if (typeof callFn === 'function') {
        this._registerInto(raw, def, callFn as any);
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
      const callFn = (def as unknown as AnyProcedureDef).call;
      if (typeof callFn === 'function') {
        this._handlers.set(def, callFn as unknown as (params: unknown, stream?: unknown) => unknown);
      }
    }
  }

  private _registerInto(raw: RawServer, def: AnyProcedureMeta, handler: (params: unknown, stream?: unknown) => unknown): void {
    const name = this._metaToMethod.get(def)!;
    const mode = def._streamMode;

    if (mode === 'unary') {
      raw.onUnary(name, ((rawParams: unknown) => {
        const { input, meta } = (rawParams ?? {}) as any;
        const validated = validateInput(def, input);
        return handler({ input: validated, meta: meta ?? {} });
      }) as any);
    } else if (mode === 'server') {
      raw.onServerStream(name, ((rawParams: unknown) => {
        const { input, meta } = (rawParams ?? {}) as any;
        const validated = validateInput(def, input);
        return handler({ input: validated, meta: meta ?? {} });
      }) as any);
    } else if (mode === 'client') {
      raw.onClientStream(name, ((rawParams: unknown, chunks: StreamHandle<any>) => {
        const { input, meta } = (rawParams ?? {}) as any;
        const validated = validateInput(def, input);
        const validatedChunks = def.chunkInSchema ? (chunks as any) : chunks;
        return handler({ input: validated, meta: meta ?? {}, stream: validatedChunks });
      }) as any);
    } else if (mode === 'bidi') {
      raw.onBidiStream(name, ((rawParams: unknown, incoming: StreamHandle<any>) => {
        const { input, meta } = (rawParams ?? {}) as any;
        const validated = validateInput(def, input);
        const validatedChunks = def.chunkInSchema ? (incoming as any) : incoming;
        return handler({ input: validated, meta: meta ?? {}, stream: validatedChunks });
      }) as any);
    }
  }
}

// ═══════════════════════════════════════════════════
//  Client 类型推断
// ═══════════════════════════════════════════════════

export type ClientRouter<TRouter> = {
  [K in keyof TRouter]: TRouter[K] extends ProcedureMeta<
    infer TIn, infer TOut, infer TChIn, infer TChOut, infer TMode
  >
    ? TMode extends 'unary'
      ? (input: TIn, options?: CallOptions) => Promise<TOut>
      : TMode extends 'server'
        ? (input: TIn, options?: CallOptions) => Promise<StreamHandle<TOut>>
        : TMode extends 'client'
          ? (input: TIn, chunks: AsyncIterable<TChIn>, options?: CallOptions) => Promise<TOut>
          : TMode extends 'bidi'
            ? (input: TIn, chunks: AsyncIterable<TChIn>, options?: CallOptions) => Promise<StreamHandle<TChOut>>
            : never
    : TRouter[K] extends Record<string, any>
      ? ClientRouter<TRouter[K]>
      : never;
};

// ═══════════════════════════════════════════════════
//  Client 工厂
// ═══════════════════════════════════════════════════

export function createClient<TRouter>(
  client: RawClient,
  router: TRouter,
): ClientRouter<TRouter> {
  const tx = client;
  const flat = flattenRouter(router as any);
  const modes: Record<string, string> = {};
  for (const [name, def] of Object.entries(flat)) {
    modes[name] = def._streamMode || 'unary';
  }

  const buildProxy = (base: string): any => new Proxy({} as any, {
    get(_, method: string) {
      const name = base ? `${base}.${method}` : method;
      const m = modes[name];

      if (m === 'server') {
        return (input: any, options?: CallOptions) => tx.serverStream(name, { input, meta: {} }, options);
      }
      if (m === 'client') {
        return (input: any, chunks: any, options?: CallOptions) =>
          tx.clientStream(name, { input, meta: {} },
            typeof chunks === 'function' ? chunks() : chunks, options);
      }
      if (m === 'bidi') {
        return (input: any, chunks: any, options?: CallOptions) =>
          tx.bidiStream(name, { input, meta: {} },
            typeof chunks === 'function' ? chunks() : chunks, options);
      }
      if (m) {
        return (input: any, options?: CallOptions) => tx.invoke(name, { input, meta: {} }, options);
      }

      return buildProxy(name);
    },
  });

  return buildProxy('') as ClientRouter<TRouter>;
}

// ═══════════════════════════════════════════════════
//  从 meta 的 zod schema 推导强类型 client
// ═══════════════════════════════════════════════════

export { createTypedClient } from './typed-client';
export type { TypedClient } from './typed-client';
export { RpcGateway } from './gateway';
export type { RpcBackend } from './gateway';
export { RpcForward } from './forward';
export type { RpcForwardOptions } from './forward';
