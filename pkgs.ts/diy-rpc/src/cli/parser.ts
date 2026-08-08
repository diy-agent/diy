import { z } from 'zod';
import type { _AnyProcedureMeta } from '../core/meta';
import { _getCliOptionMeta, _getCliArgMeta } from '../core/cli-meta';

// ═══════════════════════════════════════════════════
//  Schema 反射工具（CLI 专用）
// ═══════════════════════════════════════════════════

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s: any = schema;
  for (;;) {
    if (s instanceof z.ZodDefault) s = s._def.innerType;
    else if (s instanceof z.ZodOptional) s = s._def.innerType;
    else break;
  }
  return s;
}

function inferTypeName(schema: z.ZodTypeAny): string {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodString) return 'string';
  if (inner instanceof z.ZodNumber) return 'number';
  if (inner instanceof z.ZodBoolean) return 'boolean';
  if (inner instanceof z.ZodArray) return `${inferTypeName((inner as any).element ?? (inner as any)._def.type)}[]`;
  if (inner instanceof z.ZodEnum) return ((inner as any)._def as any).values?.join('|') ?? 'enum';
  return 'value';
}

function inferDefault(schema: z.ZodTypeAny): unknown | undefined {
  if (schema instanceof z.ZodDefault) {
    const dv = (schema as any)._def.defaultValue;
    return typeof dv === 'function' ? dv() : dv;
  }
  return undefined;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodOptional) return true;
  if (schema instanceof z.ZodDefault) return true;
  return false;
}

export class CliParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliParseError';
  }
}

export interface ParsedInput {
  input: Record<string, unknown>;
  helpRequested: boolean;
}

/** @internal */
export function parseArgv(def: _AnyProcedureMeta, argv: string[]): ParsedInput {
  const schema = def.inputSchema;
  if (!(schema instanceof z.ZodObject)) {
    throw new CliParseError('Procedure has no input schema');
  }

  const shape = (schema as any).shape as Record<string, z.ZodTypeAny>;

  if (argv.some(a => a === '--help' || a === '-h')) {
    return { input: {}, helpRequested: true };
  }

  // 收集 arg 和 option 信息
  const optionNames = new Map<string, string>();  // --name → fieldKey
  const shortAliases = new Map<string, string>(); // -x → fieldKey
  const argOrder: string[] = [];                   // 位置参数顺序

  for (const [key, field] of Object.entries(shape)) {
    const optMeta = _getCliOptionMeta(field);
    const argMeta = _getCliArgMeta(field);
    if (optMeta) {
      optionNames.set(key, key);
      if (optMeta.short) shortAliases.set(optMeta.short, key);
    }
    if (argMeta) {
      argOrder.push(key);
    }
  }

  // 默认 boolean = false
  const input: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    if (unwrap(field) instanceof z.ZodBoolean) {
      input[key] = false;
    }
  }

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let key: string | undefined;
    let value: string | undefined;

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        key = optionNames.get(arg.slice(2, eqIdx));
        value = arg.slice(eqIdx + 1);
      } else {
        key = optionNames.get(arg.slice(2));
        if (key && unwrap(shape[key]) instanceof z.ZodBoolean) {
          input[key] = true;
          continue;
        }
        value = argv[++i];
      }
    } else if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      key = shortAliases.get(arg.slice(1));
      if (key && unwrap(shape[key]) instanceof z.ZodBoolean) {
        input[key] = true;
        continue;
      }
      value = argv[++i];
    } else {
      positional.push(arg);
      continue;
    }

    if (key === undefined) {
      throw new CliParseError(`Unknown option: ${arg}`);
    }
    input[key] = value;
  }

  // 按顺序映射位置参数
  for (let i = 0; i < argOrder.length && i < positional.length; i++) {
    input[argOrder[i]] = positional[i];
  }

  // 预转数字
  for (const [key, val] of Object.entries(input)) {
    if (typeof val !== 'string') continue;
    const field = shape[key];
    if (!field) continue;
    if (unwrap(field) instanceof z.ZodNumber) {
      input[key] = Number(val);
    }
  }

  try {
    const validated = schema.parse(input);
    return { input: validated, helpRequested: false };
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      const msgs = err.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new CliParseError(`Validation errors:\n${msgs}`);
    }
    throw err;
  }
}

/** @internal */
export function generateHelp(def: _AnyProcedureMeta, cmdName: string, description?: string): string {
  const schema = def.inputSchema;
  if (!(schema instanceof z.ZodObject)) return '';

  const shape = (schema as any).shape as Record<string, z.ZodTypeAny>;
  const lines: string[] = [];

  if (description) lines.push(description, '');

  // 位置参数
  const args: [string, ReturnType<typeof _getCliArgMeta>][] =
    Object.entries(shape).map(([k, f]) => [k, _getCliArgMeta(f)] as any)
      .filter(([, m]) => m);

  if (args.length > 0) {
    lines.push('Arguments:');
    for (const [key, meta] of args) {
      const typeName = inferTypeName(shape[key]);
      const ph = meta!.placeholder ?? typeName;
      const opt = isOptional(shape[key]) ? `[${ph}]` : `<${ph}>`;
      const help = meta!.desc ? `  ${meta!.desc}` : '';
      lines.push(`  ${opt}${help}`);
    }
    lines.push('');
  }

  // 命名选项
  const opts: [string, ReturnType<typeof _getCliOptionMeta>][] =
    Object.entries(shape).map(([k, f]) => [k, _getCliOptionMeta(f)] as any)
      .filter(([, m]) => m);

  if (opts.length > 0) {
    lines.push('Options:');
    for (const [key, meta] of opts) {
      const field = shape[key];
      const alias = meta!.short ? `-${meta!.short}, ` : '    ';
      const long = key.length > 1 ? `--${key}` : `-${key}`;
      const typeName = inferTypeName(field);
      const ph = meta!.placeholder ?? typeName;
      const isBool = unwrap(field) instanceof z.ZodBoolean;
      const argDisplay = isBool ? '' : ` ${ph}`;
      const defVal = inferDefault(field);
      const defStr = defVal !== undefined ? ` (default: ${JSON.stringify(defVal)})` : '';
      const req = !isOptional(field) && defVal === undefined ? '  [required]' : '';
      const help = meta!.desc ? `  ${meta!.desc}` : '';
      lines.push(`  ${alias}${long}${argDisplay}${req}${defStr}${help}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
