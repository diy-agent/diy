/**
 * rpc/index.ts — 第3层 RPC：声明式 Procedure 定义
 *
 * 角色：在第2层 Client/Server 之上提供类型安全的声明式 API。
 *       应用程序代码只应该使用这层（rpc.unary / router / createHandler / createClient）。
 *
 * 四种工厂函数：rpc.unary / rpc.serverStream / rpc.clientStream / rpc.bidiStream
 * 每个接受配置对象，返回 ProcedureDef。
 */

import { z } from 'zod';
import type { Server } from '../transport/server';
import type { Client, CallOptions } from '../transport/client';
import type { StreamHandle } from '../transport/types';
import { RpcError } from '../transport/types';

// ═══════════════════════════════════════════════════
//  Procedure 类型
// ═══════════════════════════════════════════════════

type ProcedureMode = 'unary' | 'server' | 'client' | 'bidi';

export interface ProcedureCliMeta {
  description?: string;
}

export interface ProcedureDef<
  TInput = unknown,
  TOutput = unknown,
  TChunkIn = never,
  TChunkOut = never,
  TMode extends ProcedureMode = 'unary',
> {
  _type: 'procedure';
  _input: TInput;
  _output: TOutput;
  _chunkIn: TChunkIn;
  _chunkOut: TChunkOut;
  _streamMode: TMode;
  inputSchema?: z.ZodType<TInput>;
  chunkInSchema?: z.ZodType<TChunkIn>;
  chunkOutSchema?: z.ZodType<TChunkOut>;
  summary?: string;
  description?: string;
  cliDesc?: ProcedureCliMeta;
  call: (opts: { input: TInput; ctx: unknown; meta: unknown }) => unknown;
}

type AnyProcedure = ProcedureDef<any, any, any, any, any>;
export type { AnyProcedure };
export interface Router { [key: string]: AnyProcedure | Router; }

// ═══════════════════════════════════════════════════
//  Unary
// ═══════════════════════════════════════════════════

export interface UnaryConfig<TInput, TOutput> {
  summary?: string;
  description?: string;
  input: Record<string, z.ZodTypeAny>;
  call: (opts: { input: TInput; ctx?: unknown; meta?: unknown }) => TOutput | Promise<TOutput>;
}

function unary<TInput extends Record<string, any>, TOutput>(
  config: UnaryConfig<TInput, TOutput>,
): ProcedureDef<TInput, TOutput, never, never, 'unary'> {
  const schema = z.object(config.input);

  return {
    _type: 'procedure',
    _input: undefined as never,
    _output: undefined as never,
    _chunkIn: undefined as never,
    _chunkOut: undefined as never,
    _streamMode: 'unary',
    inputSchema: schema as z.ZodType<TInput>,
    summary: config.summary,
    description: config.description,
    call: (opts) => config.call({ input: opts.input, ctx: opts.ctx, meta: opts.meta }),
  };
}

// ═══════════════════════════════════════════════════
//  Server-Stream
// ═══════════════════════════════════════════════════

export interface ServerStreamConfig<TInput, TOutput> {
  summary?: string;
  description?: string;
  input: Record<string, z.ZodTypeAny>;
  call: (opts: { input: TInput; ctx?: unknown; meta?: unknown }) => AsyncGenerator<TOutput>;
}

function serverStream<TInput extends Record<string, any>, TOutput>(
  config: ServerStreamConfig<TInput, TOutput>,
): ProcedureDef<TInput, TOutput, never, TOutput, 'server'> {
  const schema = z.object(config.input);

  return {
    _type: 'procedure',
    _input: undefined as never,
    _output: undefined as never,
    _chunkIn: undefined as never,
    _chunkOut: undefined as never,
    _streamMode: 'server',
    inputSchema: schema as z.ZodType<TInput>,
    summary: config.summary,
    description: config.description,
    call: (opts) => config.call({ input: opts.input, ctx: opts.ctx, meta: opts.meta }),
  };
}

// ═══════════════════════════════════════════════════
//  Client-Stream
// ═══════════════════════════════════════════════════

export interface ClientStreamConfig<TInput, TChunk, TOutput> {
  summary?: string;
  description?: string;
  input: Record<string, z.ZodTypeAny>;
  chunk: z.ZodType<TChunk>;
  call: (opts: { input: TInput; stream: StreamHandle<TChunk>; ctx?: unknown; meta?: unknown }) => TOutput | Promise<TOutput>;
}

function clientStream<TInput extends Record<string, any>, TChunk, TOutput>(
  config: ClientStreamConfig<TInput, TChunk, TOutput>,
): ProcedureDef<TInput, TOutput, TChunk, never, 'client'> {
  const schema = z.object(config.input);

  return {
    _type: 'procedure',
    _input: undefined as never,
    _output: undefined as never,
    _chunkIn: undefined as never,
    _chunkOut: undefined as never,
    _streamMode: 'client',
    inputSchema: schema as z.ZodType<TInput>,
    chunkInSchema: config.chunk,
    summary: config.summary,
    description: config.description,
    call: (opts: any) => config.call({ input: opts.input, stream: opts.stream, ctx: opts.ctx, meta: opts.meta }),
  };
}

// ═══════════════════════════════════════════════════
//  Bidi-Stream
// ═══════════════════════════════════════════════════

export interface BidiStreamConfig<TInput, TChunkIn, TChunkOut> {
  summary?: string;
  description?: string;
  input: Record<string, z.ZodTypeAny>;
  chunkIn: z.ZodType<TChunkIn>;
  chunkOut: z.ZodType<TChunkOut>;
  call: (opts: { input: TInput; stream: StreamHandle<TChunkIn>; ctx?: unknown; meta?: unknown }) => AsyncGenerator<TChunkOut>;
}

function bidiStream<TInput extends Record<string, any>, TChunkIn, TChunkOut>(
  config: BidiStreamConfig<TInput, TChunkIn, TChunkOut>,
): ProcedureDef<TInput, TChunkOut, TChunkIn, TChunkOut, 'bidi'> {
  const schema = z.object(config.input);

  return {
    _type: 'procedure',
    _input: undefined as never,
    _output: undefined as never,
    _chunkIn: undefined as never,
    _chunkOut: undefined as never,
    _streamMode: 'bidi',
    inputSchema: schema as z.ZodType<TInput>,
    chunkInSchema: config.chunkIn,
    chunkOutSchema: config.chunkOut,
    summary: config.summary,
    description: config.description,
    call: (opts: any) => config.call({ input: opts.input, stream: opts.stream, ctx: opts.ctx, meta: opts.meta }),
  };
}

// ═══════════════════════════════════════════════════
//  rpc 命名空间导出
// ═══════════════════════════════════════════════════

export const rpc = { unary, serverStream, clientStream, bidiStream };

// ═══════════════════════════════════════════════════
//  Router
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
//  Router → RouteNode 树转换
// ═══════════════════════════════════════════════════

export function isProcedure(v: unknown): v is AnyProcedure {
  return typeof v === 'object' && v !== null && (v as AnyProcedure)._type === 'procedure';
}

export type ProcNode = {
  kind: 'proc';
  name: string;
  path: string;
  def: AnyProcedure;
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

/** 拍平嵌套 router 为 method→ProcedureDef 映射 */
export function flattenRouter(r: Router): Record<string, AnyProcedure> {
  const result: Record<string, AnyProcedure> = {};
  for (const { path, def } of routeLeaves(buildRouteTree(r))) {
    result[path] = def;
  }
  return result;
}

// ═══════════════════════════════════════════════════
//  createHandler
// ═══════════════════════════════════════════════════

export function createHandler<TCtx = {}>(opts: {
  router: Router;
  transport: Server;
  ctx: TCtx | (() => TCtx);
}) {
  const { transport: tx } = opts;
  const getCtx = () => (typeof opts.ctx === 'function' ? (opts.ctx as () => TCtx)() : opts.ctx);
  const flat = flattenRouter(opts.router);

  for (const [name, def] of Object.entries(flat)) {
    const mode = def._streamMode;

    if (mode === 'unary') {
      tx.onUnary(name, ((raw: unknown) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = def.inputSchema ? def.inputSchema.parse(input) : input;
        return def.call({ input: validated, ctx: getCtx(), meta: meta ?? {} });
      }) as any);
    } else if (mode === 'server') {
      tx.onServerStream(name, ((raw: unknown) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = def.inputSchema ? def.inputSchema.parse(input) : input;
        return def.call({ input: validated, ctx: getCtx(), meta: meta ?? {} });
      }) as any);
    } else if (mode === 'client') {
      tx.onClientStream(name, ((raw: unknown, chunks: StreamHandle<any>) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = def.inputSchema ? def.inputSchema.parse(input) : input;
        const validatedChunks = def.chunkInSchema ? (chunks as any) : chunks;
        return (def.call as any)({ input: validated, ctx: getCtx(), meta: meta ?? {}, stream: validatedChunks });
      }) as any);
    } else if (mode === 'bidi') {
      tx.onBidiStream(name, ((raw: unknown, incoming: StreamHandle<any>) => {
        const { input, meta } = (raw ?? {}) as any;
        const validated = def.inputSchema ? def.inputSchema.parse(input) : input;
        const validatedChunks = def.chunkInSchema ? (incoming as any) : incoming;
        return (def.call as any)({ input: validated, ctx: getCtx(), meta: meta ?? {}, stream: validatedChunks });
      }) as any);
    }
  }
}

// ═══════════════════════════════════════════════════
//  Client 类型推断
// ═══════════════════════════════════════════════════

export type ClientRouter<TRouter extends Router> = {
  [K in keyof TRouter]: TRouter[K] extends ProcedureDef<
    infer TIn, infer TOut, infer TChunkIn, infer TChunkOut, infer TMode
  >
    ? TMode extends 'unary'
      ? (input: TIn, options?: CallOptions) => Promise<TOut>
      : TMode extends 'server'
        ? (input: TIn, options?: CallOptions) => Promise<StreamHandle<TOut>>
        : TMode extends 'client'
          ? (input: TIn, chunks: AsyncIterable<TChunkIn>, options?: CallOptions) => Promise<TOut>
          : TMode extends 'bidi'
            ? (input: TIn, chunks: AsyncIterable<TChunkIn>, options?: CallOptions) => Promise<StreamHandle<TChunkOut>>
            : never
    : TRouter[K] extends Router
      ? ClientRouter<TRouter[K]>
      : never;
};

// ═══════════════════════════════════════════════════
//  Client 工厂
// ═══════════════════════════════════════════════════

export function createClient<TRouter extends Router>(
  transport: Client,
  router: TRouter,
): ClientRouter<TRouter> {
  const flat = flattenRouter(router);
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

      // 嵌套 namespace：返回子 proxy
      return buildProxy(name);
    },
  });

  return buildProxy('') as ClientRouter<TRouter>;
}
