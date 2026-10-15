import { z } from 'zod';

// ═══════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════

/** @internal */
export interface _CliOptionMeta {
  short?: string;
  desc?: string;
  placeholder?: string;
  /** 值是路径：解析成绝对路径（基准 = 调用方进程的 cwd）。实现见 cli/_parser.ts */
  resolvePath?: boolean;
  /**
   * 值是**文件路径**（`-` = stdin）：由**调用方进程**读出文件内容当值（相对路径按调用方 cwd 解析）。
   * 用途是"内容太大不适合当命令行参数"（ARG_MAX 上限）或"内容本来就在文件/管道里"。
   * 实现见 cli/_parser.ts：在 parser 里读，因为 handler 跑在 app 进程，它的 stdin/cwd 都不是调用方的。
   * 注意：`-` 读 stdin 只在**调用方进程**里成立 —— 入口把 CLI 转发到 app 进程执行时
   * （如 diy 的 /cli 端点），入口脚本必须绕开转发（否则读到的是 app 的 fd 0）。
   */
  readFile?: boolean;
}

/** @internal */
export interface _CliArgMeta {
  desc?: string;
  placeholder?: string;
  /** 值是路径：解析成绝对路径（基准 = 调用方进程的 cwd）。实现见 cli/_parser.ts */
  resolvePath?: boolean;
  /** 值是文件路径（`-` = stdin）：内容当值。见 _CliOptionMeta.readFile */
  readFile?: boolean;
}

// ═══════════════════════════════════════════════════
//  WeakMap Registry
// ═══════════════════════════════════════════════════

const _optionRegistry = new WeakMap<object, _CliOptionMeta>();
const _argRegistry = new WeakMap<object, _CliArgMeta>();

function _unwrap(schema: object): object {
  let s: any = schema;
  for (;;) {
    const next = s._def?.innerType as object | undefined;
    if (!next || next === s) break;
    s = next;
  }
  return s;
}

function _getRegistry<T>(registry: WeakMap<object, T>, schema: object): T | undefined {
  return registry.get(_unwrap(schema));
}

// ═══════════════════════════════════════════════════
//  Module augmentation
// ═══════════════════════════════════════════════════

declare module 'zod' {
  interface ZodType {
    cliOption(cfg: _CliOptionMeta): this;
    cliArg(cfg: _CliArgMeta): this;
  }
}

z.ZodType.prototype.cliOption = function (this: z.ZodType, cfg: _CliOptionMeta) {
  _optionRegistry.set(_unwrap(this), cfg);
  return this;
};

z.ZodType.prototype.cliArg = function (this: z.ZodType, cfg: _CliArgMeta) {
  _argRegistry.set(_unwrap(this), cfg);
  return this;
};

// ═══════════════════════════════════════════════════
//  Query helpers
// ═══════════════════════════════════════════════════

/** @internal */
export function _getCliOptionMeta(schema: object): _CliOptionMeta | undefined {
  return _getRegistry(_optionRegistry, schema);
}

/** @internal */
export function _getCliArgMeta(schema: object): _CliArgMeta | undefined {
  return _getRegistry(_argRegistry, schema);
}
