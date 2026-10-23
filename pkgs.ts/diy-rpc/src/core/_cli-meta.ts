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
  /**
   * 值必须是**内联文本**：形如「单行文件路径」的值 → 解析期直接报错（`CliParseError`），
   * 提示改用 `fileOpt`（传文件）或 `textOpt`（显式文本）。
   *
   * 为什么（##338）：`--body` 的语义是文本，但直觉是"传文件"（`--append-body` 恰恰收 `<file|->`，
   * 两侧不对称），于是 `diy task edit X --body /tmp/x.md` 把**路径当正文静默存下**、原正文丢失 ——
   * 实测三例（##290 / ##294 / ##87）。护栏在**解析期**（调用方进程）做：cwd 是用户敲命令的目录，
   * 相对路径的"存在性"判得准（handler 跑在 app 进程，cwd 不对）。
   */
  inlineText?: { fileOpt: string; textOpt: string };
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

const _cliOptionImpl = function (this: object, cfg: _CliOptionMeta) {
  _optionRegistry.set(_unwrap(this), cfg);
  return this;
};

const _cliArgImpl = function (this: object, cfg: _CliArgMeta) {
  _argRegistry.set(_unwrap(this), cfg);
  return this;
};

function _patchSchemaProto(proto: object | undefined): void {
  if (!proto) return;
  const p = proto as Record<string, unknown>;
  if (typeof p.cliOption !== 'function') p.cliOption = _cliOptionImpl;
  if (typeof p.cliArg !== 'function') p.cliArg = _cliArgImpl;
}

/**
 * **不能只打 `z.ZodType.prototype`**（##5 第 13 轮实测）：zod v4 的 `z.enum()` /
 * `z.literal()` / `z.object()` 返回的实例**不继承** `z.ZodType.prototype` ——
 * 每个工厂自建类（`Object.getPrototypeOf(z.enum([...])) === z.ZodEnum.prototype`，
 * 它的 proto 直接就是 `Object.prototype`）。`z.string()` 之类恰好还能继承，
 * 于是「只打 ZodType」在多数 schema 上看着正常，只在 `.cliArg()` 落到 enum 上时炸：
 * `TypeError: TaskStateSchema.cliArg is not a function` —— **main 加载期崩、实例起不来**。
 * 所以扫一遍 zod 导出的所有 schema 类，各打各的。
 */
for (const v of Object.values(z as unknown as Record<string, unknown>)) {
  if (typeof v !== 'function') continue;
  const ctor = v as unknown as { prototype?: object; name?: string };
  const proto = ctor.prototype;
  if (!proto || (proto as { constructor?: unknown }).constructor !== v) continue;
  if (!String(ctor.name ?? '').startsWith('Zod')) continue;
  _patchSchemaProto(proto);
}
_patchSchemaProto(z.ZodType.prototype);

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
