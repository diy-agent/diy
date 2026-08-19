/**
 * rpc/index.ts — 第3层 RPC：声明式 Procedure 定义 + 服务端/客户端入口
 *
 * 第2层（meta.ts + server-binding.ts + tree.ts + ServerBinding 绑定）提供 meta 类型、router 树工具
 * 与强类型端口；本文件在其上提供：
 *   - RpcSchema 定义工厂（纯定义，handler 由调用方 binding.on 绑定）
 *   - router 组合工具（回写 meta.name）
 *   - ServerBinding 注册入口（on(meta, handler) / onForward）
 *   - createTypedClient 客户端入口
 *
 * 依赖方向：index(第3层) → meta/tree/server-binding(第2层) → transport(第1层)，无循环、分层不倒置。
 */

import { z } from 'zod';
import { type ProcedureMeta, type _Router, type _AnyProcedureMeta } from './meta';

// ═══════════════════════════════════════════════════
//  RpcSchema 配置类型（纯定义，无 call）
// ═══════════════════════════════════════════════════

/** @internal */
export interface _RpcSchemaUnaryConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput> {
  desc?: string;
  input: TSchema;
  output: z.ZodType<TOutput>;
  /** 父命令的子命令容器（可选）。有 children = 父命令 */
  children?: _Router;
}

/** @internal */
export interface _RpcSchemaServerStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TOutput> {
  desc?: string;
  input: TSchema;
  output: z.ZodType<TOutput>;
  children?: _Router;
}

/** @internal */
export interface _RpcSchemaClientStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunk, TOutput> {
  desc?: string;
  input: TSchema;
  chunkIn: z.ZodType<TChunk>;
  output: z.ZodType<TOutput>;
  children?: _Router;
}

/** @internal */
export interface _RpcSchemaBidiStreamConfig<TSchema extends Record<string, z.ZodTypeAny>, TChunkIn, TChunkOut> {
  desc?: string;
  input: TSchema;
  chunkIn: z.ZodType<TChunkIn>;
  chunkOut: z.ZodType<TChunkOut>;
}

/** @internal */
export interface _RpcSchemaGroupConfig {
  /** 父命令描述 */
  desc?: string;
  /** 子命令容器 */
  children: _Router;
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

  /**
   * 纯父命令工厂：只有 desc + children，无 input/output（不可执行，仅承载子命令与描述）。
   * _streamMode 标记为 'group'，buildRouteTree 据此识别为父命令节点。
   */
  static group<const TChildren extends _Router>(
    config: _RpcSchemaGroupConfig & { children: TChildren },
  ): ProcedureMeta<unknown, unknown, never, never, 'group'> & TChildren {
    return _makeMeta(config, 'group');
  }

  /**
   * 组合整棵 router 树并回写方法全名（相对路径）到每个 meta.name，供 ServerBinding onXxx(meta, handler) 使用。
   * 根为纯 router 容器（父命令用 RpcSchema.group 承载 desc），根描述由 CliConfig.desc 承载。
   */
  static router<T extends _Router | _AnyProcedureMeta>(def: T): T {
    // 兼容最外层传入 RpcSchema.group（历史形态：把 children 摊平到 group meta 自身，
    // 保留 apiDef.diy 访问路径，并取其 children 作为根树）。根定义推荐直接用纯 router 对象。
    const isTopGroup = (def as any)?._streamMode === 'group';
    if (isTopGroup) {
      for (const [k, v] of Object.entries((def as any).children)) {
        (def as any)[k] = v;
      }
    }
    const root: _Router = isTopGroup ? (def as any).children : (def as _Router);
    // 遍历整树：① 把父 meta 的 children 摊平到父 meta 自身（保留 app.task.create 访问路径，免 .children. 层）
    // ② 回写方法全名到每个 meta.name（父命令 group 与叶子统一），供 ServerBinding onXxx(meta, handler) 使用。
    _flattenChildren(root);
    _assignNames(root, '');
    return def;
  }
}



// ═══════════════════════════════════════════════════
//  内部工厂底层
// ═══════════════════════════════════════════════════

function _makeMeta(
  config: { desc?: string; children?: _Router },
  streamMode: string,
  inputSchema?: z.ZodTypeAny,
  outputSchema?: z.ZodTypeAny,
  chunkInSchema?: z.ZodTypeAny,
  chunkOutSchema?: z.ZodTypeAny,
): any {
  const desc = config.desc ? dedent(config.desc) : undefined;
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
    desc,
    // 单行简介 = desc 首行（命令列表/父命令列表展示）
    title: (desc ?? '').split('\n')[0]?.trim() ?? '',
    children: config.children,
  };
  return meta;
}

/** 多行模板字符串剥公共缩进：去首行空行与尾随空白，内容行按公共前导空格裁剪。
 *  TS 模板字符串原样保留每行前导空格（源码缩进），为保持树形缩进写多行 desc 时会带出前导空格，
 *  故在 meta 创建时统一 dedent（规范写法：反引号独立成行 + 内容行统一缩进）。 */
function dedent(s: string): string {
  const lines = s.replace(/^\n/, '').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)?.[0].length ?? 0);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join('\n').trimEnd();
}

// ═══════════════════════════════════════════════════
//  _Router 组合工具
// ═══════════════════════════════════════════════════

/** 递归把每个父命令（RpcSchema.group）的 children 摊平到自身（保留 app.task.create 访问路径），
 *  并保留 children 字段供 buildRouteTree 递归（叶/父判定靠 _streamMode==='group'）。 */
function _flattenChildren(node: _Router): void {
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const meta = val as _AnyProcedureMeta;
      if (meta.children && typeof meta.children === 'object') {
        for (const [ck, cv] of Object.entries(meta.children)) {
          (meta as any)[ck] = cv;
        }
        // 不删 children：buildRouteTree 靠 val.children 识别父命令
      }
      // 递归子命令（children 或摊平键里的 meta）
      _flattenChildren(meta as unknown as _Router);
    }
  }
}

/** 递归给整棵 router 树（含父命令 group）的每个 meta 回写方法全名（相对路径）到 name。
 *  父命令与叶子统一具备 name，供 ServerBinding onXxx(meta, handler) 与 CLI 命令树使用。 */
function _assignNames(node: _Router, prefix: string): void {
  for (const [key, val] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const meta = val as _AnyProcedureMeta;
    if (meta && typeof meta === 'object' && (meta as any)._type === 'procedure') {
      (meta as { name?: string }).name = path;
      if (meta._streamMode === 'group' && meta.children) {
        _assignNames(meta.children, path);
      }
    } else if (meta && typeof meta === 'object') {
      // 裸 _Router 容器（无 meta 头）：继续下钻
      _assignNames(meta as unknown as _Router, path);
    }
  }
}

// ═══════════════════════════════════════════════════
//  Client 工厂（typed）与转发
// ═══════════════════════════════════════════════════

export { createTypedClient } from './typed-client';
export type { TypedClient } from './typed-client';
