import { z } from 'zod';

// ═══════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════

export interface CliOptionMeta {
  short?: string;
  desc?: string;
  placeholder?: string;
}

export interface CliArgMeta {
  desc?: string;
  placeholder?: string;
}

export interface ProcedureCliMeta {
  description?: string;
}

// ═══════════════════════════════════════════════════
//  WeakMap Registry
// ═══════════════════════════════════════════════════

const _optionRegistry = new WeakMap<object, CliOptionMeta>();
const _argRegistry = new WeakMap<object, CliArgMeta>();

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
    cliOption(cfg: CliOptionMeta): this;
    cliArg(cfg: CliArgMeta): this;
  }
}

z.ZodType.prototype.cliOption = function (this: z.ZodType, cfg: CliOptionMeta) {
  _optionRegistry.set(_unwrap(this), cfg);
  return this;
};

z.ZodType.prototype.cliArg = function (this: z.ZodType, cfg: CliArgMeta) {
  _argRegistry.set(_unwrap(this), cfg);
  return this;
};

// ═══════════════════════════════════════════════════
//  Query helpers
// ═══════════════════════════════════════════════════

export function getCliOptionMeta(schema: object): CliOptionMeta | undefined {
  return _getRegistry(_optionRegistry, schema);
}

export function getCliArgMeta(schema: object): CliArgMeta | undefined {
  return _getRegistry(_argRegistry, schema);
}

export function hasCliMeta(schema: object): boolean {
  return !!(_getRegistry(_optionRegistry, schema) || _getRegistry(_argRegistry, schema));
}
