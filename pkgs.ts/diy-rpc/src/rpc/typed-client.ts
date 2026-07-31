/**
 * typed-client.ts — 从 meta 的 zod schema 推导强类型 client
 *
 * 与 createClient（ClientRouter 从 router 泛型参数推导）不同，
 * 这里类型完全来自 meta 的 zod schema（z.infer），
 * 且每次调用做 runtime zod input 校验。
 *
 * 依赖：RawClient / flattenRouter（第2层），RpcSchema 定义的 meta（无 call）。
 */

import { z } from 'zod';
import { RawClient, type CallOptions } from './raw-client';
import type { Transport, StreamHandle } from '../transport/types';
import { flattenRouter } from './index';

// ═══════════════════════════════════════════════════
//  类型工具 — 从 meta 的 zod schema 推导
// ═══════════════════════════════════════════════════

// 注意 schema 字段是可选的，用 `?:` + infer 匹配
type ProcInput<T> = T extends { inputSchema?: z.ZodType<infer I> } ? I : never;
type ProcOutput<T> = T extends { outputSchema?: z.ZodType<infer O> } ? O : never;
type ProcChunkIn<T> = T extends { chunkInSchema?: z.ZodType<infer C> } ? C : never;
type ProcChunkOut<T> = T extends { chunkOutSchema?: z.ZodType<infer C> } ? C : never;

/**
 * 从 meta router 树推导强类型 client。
 *
 *  unary   → (input, options?) => Promise<output>
 *  server  → (input, options?) => Promise<StreamHandle<output>>
 *  client  → (input, chunks, options?) => Promise<output>
 *  bidi    → (input, chunks, options?) => Promise<StreamHandle<chunkOut>>
 */
export type TypedClient<T> = {
  [K in keyof T]: T[K] extends { _type: 'procedure'; _streamMode: 'unary' }
    ? (input: ProcInput<T[K]>, options?: CallOptions) => Promise<ProcOutput<T[K]>>
    : T[K] extends { _type: 'procedure'; _streamMode: 'server' }
      ? (input: ProcInput<T[K]>, options?: CallOptions) => Promise<StreamHandle<ProcOutput<T[K]>>>
      : T[K] extends { _type: 'procedure'; _streamMode: 'client' }
        ? (input: ProcInput<T[K]>, chunks: ProcChunks<T[K]>, options?: CallOptions) => Promise<ProcOutput<T[K]>>
        : T[K] extends { _type: 'procedure'; _streamMode: 'bidi' }
          ? (input: ProcInput<T[K]>, chunks: ProcChunks<T[K]>, options?: CallOptions) => Promise<StreamHandle<ProcChunkOut<T[K]>>>
          : T[K] extends Record<string, unknown>
            ? TypedClient<T[K]>
            : never;
};

/** client/bidi stream 的 chunks 参数：AsyncIterable 或返回 AsyncIterable 的函数 */
type ProcChunks<T> = AsyncIterable<ProcChunkIn<T>> | (() => AsyncIterable<ProcChunkIn<T>>);

// ═══════════════════════════════════════════════════
//  运行时工厂
// ═══════════════════════════════════════════════════

function resolveChunks<T>(chunks: AsyncIterable<T> | (() => AsyncIterable<T>)): AsyncIterable<T> {
  return typeof chunks === 'function' ? chunks() : chunks;
}

/**
 * 从 meta（纯 zod 定义，无 call）创建强类型 client。
 *
 * 每次调用先做 zod input 校验，再发到 transport。
 */
export function createTypedClient<const T>(transport: Transport, meta: T): TypedClient<T> {
  const raw = new RawClient(transport);
  const flat = flattenRouter(meta as Parameters<typeof flattenRouter>[0]);
  const modes: Record<string, string> = {};
  const schemas: Record<string, { input?: z.ZodType }> = {};
  for (const [name, def] of Object.entries(flat)) {
    modes[name] = def._streamMode || 'unary';
    schemas[name] = { input: def.inputSchema };
  }

  const validate = (name: string, input: any) => {
    const sc = schemas[name];
    return sc.input ? sc.input.parse(input) : input;
  };

  const buildProxy = (base: string): any => new Proxy({} as any, {
    get(_, method: string) {
      const name = base ? `${base}.${method}` : method;
      const m = modes[name];
      if (!m) return buildProxy(name);

      if (m === 'server') {
        return (input: any, options?: CallOptions) => raw.serverStream(name, { input: validate(name, input), meta: {} }, options);
      }
      if (m === 'client') {
        return (input: any, chunks: any, options?: CallOptions) =>
          raw.clientStream(name, { input: validate(name, input), meta: {} }, resolveChunks(chunks), options);
      }
      if (m === 'bidi') {
        return (input: any, chunks: any, options?: CallOptions) =>
          raw.bidiStream(name, { input: validate(name, input), meta: {} }, resolveChunks(chunks), options);
      }
      return (input: any, options?: CallOptions) => raw.invoke(name, { input: validate(name, input), meta: {} }, options);
    },
  });

  return buildProxy('') as TypedClient<T>;
}
