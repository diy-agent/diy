import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import type { _AnyProcedureMeta } from '../core/meta.js';
import { _getCliOptionMeta, _getCliArgMeta } from '../core/_cli-meta.js';

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

export interface ParseArgvOptions {
  /**
   * 解析路径参数（`resolvePath` 标记）用的基准目录。
   * 缺省 `process.cwd()` —— 但**入口脚本常先 cd 到应用目录**（diy.sh / bin/diy 都这样），
   * 那时进程 cwd 已不是用户敲命令的目录，必须由入口显式传入真实调用者 cwd。
   */
  cwd?: string;
}

/**
 * camelCase 字段名 → kebab-case 选项名（`byAgent` → `by-agent`）。
 *
 * 为什么需要：选项名默认取 schema 字段名（TS 侧是 camelCase），但 CLI 惯例是 kebab —
 * 让用户去猜"这个选项是大写还是小写、有没有连字符"是不必要的认知负担。故**两种写法都接受**，
 * help 里统一显示 kebab。已有的下划线命名（`change_type`）不受影响（只转大写字母）。
 */
function kebabOf(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** @internal */
export function parseArgv(def: _AnyProcedureMeta, argv: string[], opts: ParseArgvOptions = {}): ParsedInput {
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
      // kebab 别名：`--by-agent` 与 `--byAgent` 等价（见 kebabOf）
      const kebab = kebabOf(key);
      if (kebab !== key) optionNames.set(kebab, key);
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

  // 预转数字 + JSON 数组 + boolean
  for (const [key, val] of Object.entries(input)) {
    if (typeof val !== 'string') continue;
    const field = shape[key];
    if (!field) continue;
    if (unwrap(field) instanceof z.ZodNumber) {
      input[key] = Number(val);
    } else if (unwrap(field) instanceof z.ZodBoolean) {
      input[key] = val === 'true' || val === '1';
    } else if (unwrap(field) instanceof z.ZodArray) {
      try { input[key] = JSON.parse(val); } catch { /* 保留原字符串，让 zod 报错 */ }
    } else if (_getCliOptionMeta(field)?.inlineText) {
      // 「必须是内联文本」的选项（`_CliOptionMeta.inlineText`，##338）：形如单行文件路径的值一律拒绝，
      // 并在报错里给出正确写法。解析期在这里做（不是 handler）—— handler 跑在 app 进程，
      // cwd 不是用户敲命令的目录，相对路径的存在性判不出来。
      const meta = _getCliOptionMeta(field)!;
      const hit = pathLikeValue(val, opts.cwd ?? process.cwd());
      if (hit) throw new CliParseError(inlineTextError(`--${kebabOf(key)}`, val, hit, meta.inlineText!));
    } else if (_getCliOptionMeta(field)?.readFile || _getCliArgMeta(field)?.readFile) {
      // 值来自文件：`-` = stdin，其余按调用方 cwd 解析成绝对路径后读。
      // 为什么在 parser 里读（而不是 handler）：handler 跑在 app 进程 —— 它的 stdin 不是用户的
      // stdin、cwd 不是用户敲命令的目录。在调用方进程读，两件事都天然正确。
      // 同步读：parser 是同步函数（CliApp.parse 一路同步），而 readFileSync(0) 读管道/重定向
      // 是同步的。stdin 是 TTY 且没重定向时会阻塞等 EOF（shell 里的 `-` 本来就是这个语义）。
      input[key] = readTextArg(val, opts.cwd ?? process.cwd());
    } else if (_getCliOptionMeta(field)?.resolvePath || _getCliArgMeta(field)?.resolvePath) {
      // 路径参数解析成绝对路径，基准是**调用方**（敲命令的那个 shell）的 cwd。
      //
      // 为什么必须在这里做：命令的 handler 跑在 app 进程（Electron main）里，
      // 它的 cwd 是应用目录，不是用户敲命令的目录。不解析的话 `cd /tmp && diy tool read a.txt`
      // 会去应用目录找文件（实测踩过）。在 parser 里解析，基准天然就是正确的那个。
      // cli/ 不在 rpc 的浏览器检查范围内，故可用 node:path。
      input[key] = resolvePath(opts.cwd ?? process.cwd(), val);
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

/**
 * 「必须是内联文本」的选项（`inlineText`）收到的值，是否形如**单行文件路径**（##338）。
 * 命中返回 `{ abs, exists }`（供报错文案用），否则 null。
 *
 * 判据两步，缺一不可：
 *   ① **整体是一个 token**（去掉首尾空白后不含任何空白/换行）—— 多行正文天然不是路径，放行；
 *   ② **形态像路径**（`/` `./` `../` `~/` 或盘符开头）**或** 按调用方 cwd 解析后**确实是存在的文件**
 *      （覆盖 `--body AGENTS.md` 这种"裸文件名"写法 —— 实测三例里路径都是整值，故整值判据不漏）。
 *
 * 宁可拒绝也不静默：误判的代价是调用方改写成 `--body-text`（一次显式表达），
 * 而漏判的代价是**原正文被路径串顶掉**（##290 / ##294 / ##87 的现场）。
 */
export function pathLikeValue(raw: string, cwd: string): { abs: string; exists: boolean } | null {
  const v = raw.trim();
  if (v === '' || /\s/.test(v)) return null; // 含空白 = 不是单个路径 token
  // `~` 只有 shell 会展开，argv 里到的是字面 `~/x` —— 存在性检查要自己展开（报错文案里不编造绝对路径）
  const expanded = v.startsWith('~/') ? resolvePath(homedir(), v.slice(2)) : v;
  const abs = resolvePath(cwd, expanded);
  let exists = false;
  try {
    exists = statSync(abs).isFile();
  } catch {
    exists = false; // 不存在 / 无权限 / 是个目录 —— 都不算"存在的文件"
  }
  const pathShaped = /^(\/|\.\.?\/|~\/|[A-Za-z]:[\\/])/.test(v);
  if (!pathShaped && !exists) return null;
  return { abs, exists };
}

/** `inlineText` 命中时的报错文案：说清"错在哪 + 该怎么写"（##338） */
function inlineTextError(opt: string, raw: string, hit: { abs: string; exists: boolean }, names: { fileOpt: string; textOpt: string }): string {
  const where = hit.exists ? `该文件确实存在：${hit.abs}` : `该路径不存在：${raw}`;
  return [
    `${opt} 只收**内联正文**，但收到的值形如文件路径 —— ${where}`,
    `  收到: ${raw}`,
    `  旧行为会把路径串当正文静默存下，**原正文就此丢失**（##290 / ##294 / ##87 三例现场）。`,
    `  想传文件: ${names.fileOpt} <路径>      （等价写法: ${opt} "$(cat <路径>)"）`,
    `  确为内联正文: ${names.textOpt} <文本>   （显式表达，不做路径护栏）`,
  ].join('\n');
}

/**
 * 读「值来自文件」的参数（`readFile` 标记）：`-` = stdin，其余按 cwd 解析成绝对路径。
 * 读不出来直接报错（**不吞**）——静默给个空串会让调用方以为"追加了个空段落"，比报错更难查。
 */
function readTextArg(raw: string, cwd: string): string {
  const stdin = raw === '-';
  const target = stdin ? 'stdin' : resolvePath(cwd, raw);
  try {
    return readFileSync(stdin ? 0 : target, 'utf-8');
  } catch (e) {
    throw new CliParseError(`读取 ${target} 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 位置参数 usage 片段：按 schema 声明顺序输出 `<url>` / `[name]`（可选带方括号）。
 * 无位置参数返回空串。供 CliApp 拼 `Usage: <cmd> [options] <arg>...`。
 */
export function fmtUsageArgs(def: _AnyProcedureMeta): string {
  const schema = def.inputSchema;
  if (!(schema instanceof z.ZodObject)) return '';
  const shape = (schema as any).shape as Record<string, z.ZodTypeAny>;
  const parts: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    const argMeta = _getCliArgMeta(field);
    if (!argMeta) continue;
    const ph = argMeta.placeholder ?? key;
    parts.push(isOptional(field) ? `[${ph}]` : `<${ph}>`);
  }
  return parts.join(' ');
}

/** @internal */
export function generateHelp(def: _AnyProcedureMeta, cmdName: string, description?: string): string {
  const schema = def.inputSchema;
  if (!(schema instanceof z.ZodObject)) return '';

  const shape = (schema as any).shape as Record<string, z.ZodTypeAny>;
  const lines: string[] = [];

  // 命令描述：显式传入 > meta.desc（父命令描述由 showHelp 传入，叶子用 def.desc）
  const cmdDesc = description ?? def.desc ?? '';
  if (cmdDesc) lines.push(cmdDesc, '');

  // 位置参数 — 占位符默认用字段名（语义），可选加类型后缀
  const args: [string, ReturnType<typeof _getCliArgMeta>][] =
    Object.entries(shape).map(([k, f]) => [k, _getCliArgMeta(f)] as any)
      .filter(([, m]) => m);

  if (args.length > 0) {
    lines.push('Arguments:');
    _emitAligned(lines, args.map(([key, meta]) => {
      const typeName = inferTypeName(shape[key]);
      const ph = meta!.placeholder ?? key;
      const opt = isOptional(shape[key]) ? `[${ph}]` : `<${ph}>`;
      const typeHint = typeName !== 'value' && typeName !== ph ? ` (${typeName})` : '';
      return [`${opt}${typeHint}`, meta!.desc ?? ''];
    }));
    lines.push('');
  }

  // 命名选项
  const opts: [string, ReturnType<typeof _getCliOptionMeta>][] =
    Object.entries(shape).map(([k, f]) => [k, _getCliOptionMeta(f)] as any)
      .filter(([, m]) => m);

  if (opts.length > 0) {
    lines.push('Options:');
    _emitAligned(lines, opts.map(([key, meta]) => {
      const field = shape[key];
      const alias = meta!.short ? `-${meta!.short}, ` : '    ';
      const long = key.length > 1 ? `--${kebabOf(key)}` : `-${key}`;
      const ph = meta!.placeholder ?? key;
      const isBool = unwrap(field) instanceof z.ZodBoolean;
      const argDisplay = isBool ? '' : ` ${ph}`;
      const defVal = inferDefault(field);
      const defStr = defVal !== undefined ? `(default: ${JSON.stringify(defVal)})` : '';
      const req = !isOptional(field) && defVal === undefined ? '[required]' : '';
      const right = [req, defStr, meta!.desc ?? ''].filter(Boolean).join(' ');
      return [`${alias}${long}${argDisplay}`, right];
    }));
    lines.push('');
  }

  return lines.join('\n');
}

/** 对齐输出：每行左侧列 padEnd 到最宽，右侧列统一起于第 w+2 列。 */
function _emitAligned(lines: string[], rows: [string, string][]): void {
  const w = rows.reduce((m, [c]) => Math.max(m, c.length), 0);
  for (const [c, r] of rows) {
    lines.push(r ? `  ${c.padEnd(w)}  ${r}` : `  ${c}`);
  }
}
