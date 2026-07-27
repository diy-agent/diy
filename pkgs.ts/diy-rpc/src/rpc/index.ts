/**
 * rpc/index.ts — 第3层 RPC：声明式 Procedure 定义
 *
 * 两种定义形态：
 *   1. 元信息形式（半完成态）— defineUnary / defineServerStream / ...
 *      只定义 API 外观（inputSchema、outputSchema、streamMode），不含 call
 *   2. 完整形式 — unary / serverStream / clientStream / bidiStream
 *      schemas + 内置 call 实现
 *
 * 角色：在第2层 Client/Server 之上提供类型安全的声明式 API。
 *       应用程序代码只应该使用这层。
 */

import { z } from 'zod';
import type { Server } from '../transport/server';
import type { Client, CallOptions } from '../transport/client';
import type { StreamHandle } from '../transport/types';
import { RpcError } from '../transport/types';

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

/** 从 schema 记录推导输入类型（{ a: z.number() } → { a: number }） */
// (故意保留类型名但 IDE 显示的是内联展开) - 实际计算靠 z.output<T[K]>

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

  /** 绑定 handler，返回绑定对供 createHandler 消费 */
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
//  Meta 配置类型（无 call）— 用 schema 类型推导输入类型
// ═══════════════════════════════════════════════════

export interface DefineUnaryConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput> {
  summary?: string;
  description?: string;
  input: TSchema;
  output: z.ZodType<TOutput>;
}

export interface DefineServerStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput> {
  summary?: string;
  description?: string;
  input: TSchema;
  output: z.ZodType<TOutput>;
}

export interface DefineClientStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput> {
  summary?: string;
  description?: string;
  input: TSchema;
  chunkIn: z.ZodType<TChunk>;
  output: z.ZodType<TOutput>;
}

export interface DefineBidiStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut> {
  summary?: string;
  description?: string;
  input: TSchema;
  chunkIn: z.ZodType<TChunkIn>;
  chunkOut: z.ZodType<TChunkOut>;
}

// ═══════════════════════════════════════════════════
//  完整配置类型（含 call）
// ═══════════════════════════════════════════════════

export interface UnaryConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput>
  extends DefineUnaryConfig<TSchema, TOutput> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; meta?: unknown }) => TOutput | Promise<TOutput>;
}

export interface ServerStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput>
  extends DefineServerStreamConfig<TSchema, TOutput> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; meta?: unknown }) => AsyncGenerator<TOutput>;
}

export interface ClientStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput>
  extends DefineClientStreamConfig<TSchema, TChunk, TOutput> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; stream: StreamHandle<TChunk>; meta?: unknown }) => TOutput | Promise<TOutput>;
}

export interface BidiStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut>
  extends DefineBidiStreamConfig<TSchema, TChunkIn, TChunkOut> {
  call: (opts: { input: { [K in keyof TSchema]: z.output<TSchema[K]> }; stream: StreamHandle<TChunkIn>; meta?: unknown }) => AsyncGenerator<TChunkOut>;
}

// ═══════════════════════════════════════════════════
//  Meta 工厂函数
// ═══════════════════════════════════════════════════

function defineUnary<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
  config: DefineUnaryConfig<TSchema, TOutput>,
): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, never, 'unary'> {
  return _makeMeta(config, 'unary', z.object(config.input), config.output);
}

function defineServerStream<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
  config: DefineServerStreamConfig<TSchema, TOutput>,
): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, TOutput, 'server'> {
  return _makeMeta(config, 'server', z.object(config.input), config.output);
}

function defineClientStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput>(
  config: DefineClientStreamConfig<TSchema, TChunk, TOutput>,
): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, TChunk, never, 'client'> {
  return _makeMeta(config, 'client', z.object(config.input), config.output, config.chunkIn);
}

function defineBidiStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut>(
  config: DefineBidiStreamConfig<TSchema, TChunkIn, TChunkOut>,
): ProcedureMeta<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TChunkOut, TChunkIn, TChunkOut, 'bidi'> {
  return _makeMeta(config, 'bidi', z.object(config.input), undefined, config.chunkIn, config.chunkOut);
}

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
//  Impl 工厂函数（含 call，保持向后兼容 + 新增 output）
// ═══════════════════════════════════════════════════

function unary<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
  config: UnaryConfig<TSchema, TOutput>,
): ProcedureDef<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, never, 'unary'> {
  const meta = _makeMeta(config, 'unary', z.object(config.input), config.output);
  meta.call = (opts: any) => config.call({ input: opts.input, meta: opts.meta });
  return meta;
}

function serverStream<const TSchema extends Record<string, z.ZodTypeAny>, TOutput>(
  config: ServerStreamConfig<TSchema, TOutput>,
): ProcedureDef<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, never, TOutput, 'server'> {
  const meta = _makeMeta(config, 'server', z.object(config.input), config.output);
  meta.call = (opts: any) => config.call({ input: opts.input, meta: opts.meta });
  return meta;
}

function clientStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput>(
  config: ClientStreamConfig<TSchema, TChunk, TOutput>,
): ProcedureDef<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TOutput, TChunk, never, 'client'> {
  const meta = _makeMeta(config, 'client', z.object(config.input), config.output, config.chunkIn);
  meta.call = (opts: any) => config.call({ input: opts.input, stream: opts.stream, meta: opts.meta });
  return meta;
}

function bidiStream<const TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut>(
  config: BidiStreamConfig<TSchema, TChunkIn, TChunkOut>,
): ProcedureDef<{ [K in keyof TSchema]: z.output<TSchema[K]> }, TChunkOut, TChunkIn, TChunkOut, 'bidi'> {
  const meta = _makeMeta(config, 'bidi', z.object(config.input), undefined, config.chunkIn, config.chunkOut);
  meta.call = (opts: any) => config.call({ input: opts.input, stream: opts.stream, meta: opts.meta });
  return meta;
}

// ═══════════════════════════════════════════════════
//  rpc 命名空间导出
// ═══════════════════════════════════════════════════

export const rpc = {
  // meta 工厂
  defineUnary,
  defineServerStream,
  defineClientStream,
  defineBidiStream,
  // impl 工厂
  unary,
  serverStream,
  clientStream,
  bidiStream,
};

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

/** 内部共享：遍历 router 树 + 注册 handler 到 transport */
function _registerRouter(opts: {
  router: Router;
  transport: Server;
  handlers: Map<AnyProcedureMeta, (params: unknown, stream?: unknown) => unknown>;
}) {
  const { transport: tx } = opts;
  const flat = flattenRouter(opts.router);

  for (const [name, def] of Object.entries(flat)) {
    const mode = def._streamMode;
    const handler = opts.handlers.get(def) ?? (def as any).call;
    if (!handler) {
      throw new Error(`[createHandler] No handler for procedure "${name}" — provide via .on() or use rpc.unary with call`);
    }

    if (mode === 'unary') {
      tx.onUnary(name, ((raw: unknown) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = def.inputSchema ? def.inputSchema.parse(input) : input;
        return handler({ input: validated, meta: meta ?? {} });
      }) as any);
    } else if (mode === 'server') {
      tx.onServerStream(name, ((raw: unknown) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = def.inputSchema ? def.inputSchema.parse(input) : input;
        return handler({ input: validated, meta: meta ?? {} });
      }) as any);
    } else if (mode === 'client') {
      tx.onClientStream(name, ((raw: unknown, chunks: StreamHandle<any>) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = def.inputSchema ? def.inputSchema.parse(input) : input;
        const validatedChunks = def.chunkInSchema ? (chunks as any) : chunks;
        return handler({ input: validated, meta: meta ?? {}, stream: validatedChunks });
      }) as any);
    } else if (mode === 'bidi') {
      tx.onBidiStream(name, ((raw: unknown, incoming: StreamHandle<any>) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = def.inputSchema ? def.inputSchema.parse(input) : input;
        const validatedChunks = def.chunkInSchema ? (incoming as any) : incoming;
        return handler({ input: validated, meta: meta ?? {}, stream: validatedChunks });
      }) as any);
    }
  }
}

/**
 * 注册完整定义（含 call）的 router。
 * 所有 procedure 必须通过 rpc.unary/serverStream/... 提供 inline call。
 */
export function createHandler(opts: {
  router: Router;
  transport: Server;
}) {
  _registerRouter({
    router: opts.router,
    transport: opts.transport,
    handlers: new Map(),
  });
}

/**
 * 注册元信息 router（半完成态），需要先通过 .on() 绑定 handler。
 * handlers 由 defineUnary/... 返回的 meta 对象的 .on() 方法产生。
 */
export function createMetaHandler(opts: {
  router: Router;
  transport: Server;
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
  transport: Client,
  router: TRouter,
): ClientRouter<TRouter> {
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
        return (input: any, options?: CallOptions) => transport.serverStream(name, { input, meta: {} }, options);
      }
      if (m === 'client') {
        return (input: any, chunks: any, options?: CallOptions) =>
          transport.clientStream(name, { input, meta: {} },
            typeof chunks === 'function' ? chunks() : chunks, options);
      }
      if (m === 'bidi') {
        return (input: any, chunks: any, options?: CallOptions) =>
          transport.bidiStream(name, { input, meta: {} },
            typeof chunks === 'function' ? chunks() : chunks, options);
      }
      if (m) {
        return (input: any, options?: CallOptions) => transport.invoke(name, { input, meta: {} }, options);
      }

      return buildProxy(name);
    },
  });

  return buildProxy('') as ClientRouter<TRouter>;
}
