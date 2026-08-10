import { z } from 'zod';

// ═══════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════

/** @internal */
export interface _CliOptionMeta {
  short?: string;
  desc?: string;
  placeholder?: string;
}

/** @internal */
export interface _CliArgMeta {
  desc?: string;
  placeholder?: string;
}

/** @internal */
export interface _ProcedureCliMeta {
  description?: string;
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

/** @internal */
export function _hasCliMeta(schema: object): boolean {
  return !!(_getRegistry(_optionRegistry, schema) || _getRegistry(_argRegistry, schema));
}
