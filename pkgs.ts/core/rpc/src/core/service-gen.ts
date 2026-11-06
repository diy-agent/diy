/**
 * service-gen.ts — 从 api 树**生成**两端的类型声明（2026-11-05）
 *
 * 为什么要有它：`TypedClient<T>` 的形状是 Proxy 下钻，IDE 里点进去看到的是一堆
 * `_Router` 条件类型，不是「add(a, b): number」这种人话。生成的 .d.ts 把树**摊平**成
 * 接口，读代码、看报错都直接。
 *
 * 为什么不用纯类型推导：`{ a: z.number() }` → `(a: number)` 需要「对象转参数列表」，
 * TS 做不到保留键名（只能得到位置元组），且条件类型一复杂 IDE 就卡。
 *
 * 用法（生成脚本侧）：
 * ```ts
 * const dts = renderServiceTypes('DiyWorkbench', workbenchApi);
 * writeFileSync('src/api.generated.d.ts', dts);
 * ```
 *
 * 运行时零成本：本文件只在构建期跑，产物是 .d.ts（无 JS）。
 */

import { z } from 'zod';
import { _flattenRouter } from './_tree.js';
import type { _Router } from './meta.js';

/** 一个生成出来方法的元信息（从 ProcedureMeta 里摘出来） */
interface FlatMethod {
    path: string;
    inputSchema?: z.ZodType;
    outputSchema?: z.ZodType;
    desc?: string;
    mode: string;
}

/** zod schema → TS 类型文本（只覆盖实践中会出现的构造） */
export function zodToTs(schema: z.ZodType | undefined): string {
    if (schema === undefined) return 'unknown';
    const def = schema as unknown as { _zod?: { def?: { type?: string } }; def?: { type?: string } };
    const type = def._zod?.def?.type ?? def.def?.type;

    // zod v4 的公开形状：用 description / 内部 def 判
    const anySchema = schema as unknown as {
        _zod?: { def?: Record<string, unknown> };
        def?: Record<string, unknown>;
    };
    const d = (anySchema._zod?.def ?? anySchema.def ?? {}) as Record<string, unknown>;

    switch (type) {
        case 'string':
            return 'string';
        case 'number':
        case 'int':
        case 'float':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'null':
            return 'null';
        case 'undefined':
            return 'undefined';
        case 'any':
            return 'unknown';
        case 'unknown':
            return 'unknown';
        case 'literal': {
            const values = d['values'] as unknown[] | undefined;
            if (Array.isArray(values)) return values.map((v) => JSON.stringify(v)).join(' | ');
            return 'unknown';
        }
        case 'enum': {
            const entries = d['entries'] as Record<string, unknown> | undefined;
            if (entries) {
                return Object.values(entries).map((v) => JSON.stringify(v)).join(' | ');
            }
            return 'string';
        }
        case 'array': {
            const inner = d['element'] as z.ZodType | undefined;
            const t = zodToTs(inner);
            // 有歧义时加括号（`(A | B)[]` 而不是 `A | B[]`）
            return t.includes('|') ? `(${t})[]` : `${t}[]`;
        }
        case 'object': {
            const shape = d['shape'] as Record<string, z.ZodType> | undefined;
            if (!shape) return 'Record<string, unknown>';
            const keys = Object.entries(shape).map(([k, v]) => {
                const optional = isOptional(v);
                const safe = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
                return `${safe}${optional ? '?' : ''}: ${zodToTs(v)}`;
            });
            return keys.length === 0 ? 'Record<string, never>' : `{ ${keys.join('; ')} }`;
        }
        case 'optional': {
            const inner = d['innerType'] as z.ZodType | undefined;
            return zodToTs(inner);
        }
        case 'nullable': {
            const inner = d['innerType'] as z.ZodType | undefined;
            return `${zodToTs(inner)} | null`;
        }
        case 'default':
        case 'prefault': {
            const inner = d['innerType'] as z.ZodType | undefined;
            return zodToTs(inner);
        }
        case 'union': {
            const options = d['options'] as z.ZodType[] | undefined;
            if (!Array.isArray(options)) return 'unknown';
            return options.map(zodToTs).join(' | ');
        }
        case 'record': {
            const value = d['valueType'] as z.ZodType | undefined;
            const key = d['keyType'] as z.ZodType | undefined;
            return `Record<${zodToTs(key)}, ${zodToTs(value)}>`;
        }
        default:
            // 认不出的构造保守给 unknown —— 生成物宁可宽也不要错（错了会让调用方误以为有类型）
            return 'unknown';
    }
}

function isOptional(schema: z.ZodType): boolean {
    const t = (schema as unknown as { _zod?: { def?: { type?: string } }; def?: { type?: string } })
        ._zod?.def?.type ?? (schema as unknown as { def?: { type?: string } }).def?.type;
    return t === 'optional' || t === 'default' || t === 'prefault';
}

export interface RenderOptions {
    /** 方法描述首行是否搬进 JSDoc（默认 true） */
    readonly includeDesc?: boolean;
    /**
     * **命名策略**（2026-11-06 用户定：先简单后复杂，默认全内联）。
     *
     * · `none`（默认）—— 不生成任何具名 IO 类型、不生成子接口，聚合接口内联全部方法。
     *   好处：文件最短、读代码一屏看全、不用跳转。
     *   代价：类型不匹配时报错会把整坨对象铺在屏幕上（字段多时难读）。
     *
     * · `all` —— IO 类型 + 子接口全具名（2026-11-05 的第一版）。
     *   好处：报错只说 `PageInvokeInput`；`PageClient` 可单独 import。
     *   代价：生成物多十几个 export，标量也具名（`SysPingOutput = string` 是纯噪音）。
     *
     * · `auto` —— 标量内联、对象具名（按主流做法：协议层 input 具名，一次性结果内联）。
     *
     * 为什么做成选项而不是写死：三种都能工作，选哪个是**口味**不是**能力**。
     * 默认取最简的一档，需要时一行配置切回来。
     */
    readonly naming?: 'none' | 'all' | 'auto';
}

/** 把扁平路径分组：`page.list` / `page.invoke` → 命名空间 `page` 下的两个叶子 */
function groupByNamespace(flat: FlatMethod[]): Map<string, FlatMethod[]> {
    const out = new Map<string, FlatMethod[]>();
    for (const m of flat) {
        const segs = m.path.split('.');
        const ns = segs.length > 1 ? segs.slice(0, -1).join('.') : '';
        const leaf = segs[segs.length - 1] ?? m.path;
        const list = out.get(ns) ?? [];
        list.push({ ...m, path: leaf });
        out.set(ns, list);
    }
    return out;
}

/** 方法名 → 合法的 TS 标识符（含点 / 短横的名字加引号） */
function methodKey(name: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

/** `page.list` → `PageList`（用于生成具名类型） */
function pascal(path: string): string {
    return path
        .split(/[.\-/]/)
        .filter((s) => s !== '')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join('');
}

/** 一个命名空间的具名类型三件套：Input / Output / Client|Server */
interface NamespaceTypes {
    /** 命名空间名（'' = 顶层，退化成纯方法不加子接口） */
    ns: string;
    inputName: (leaf: string) => string;
    clientName: string;
    serverName: string;
    methods: FlatMethod[];
}

function renderMethodSignature(
    m: FlatMethod,
    side: 'client' | 'server',
    inputTypeRef: string,
    outputTypeRef?: string,
): string {
    const output = outputTypeRef ?? zodToTs(m.outputSchema);
    const desc = m.desc ? `    /** ${m.desc.replace(/\*\//g, '*\\/')} */\n` : '';
    if (side === 'client') {
        // 客户端：`options` 可选（取消 / 超时）；返回一定是 Promise
        return `${desc}    ${methodKey(m.path)}(input: ${inputTypeRef}, options?: RpcCallOptions): Promise<${output}>;`;
    }
    // 服务端：多一个 signal；允许同步返回（不改现有 handler 契约）
    return `${desc}    ${methodKey(m.path)}(opts: { input: ${inputTypeRef}; signal: AbortSignal }): ${output} | Promise<${output}>;`;
}

/**
 * 生成一个模块的 .d.ts（client / server 两组）。
 *
 * `naming` 决定具名程度（默认 `none` = 全内联，见 RenderOptions）。
 */
export function renderServiceTypes(
    typeName: string,
    api: _Router,
    options: RenderOptions = {},
): string {
    const naming = options.naming ?? 'none';
    const flatten = _flattenRouter(api);
    const flat: FlatMethod[] = Object.entries(flatten).map(([path, meta]) => ({
        path,
        ...(meta.inputSchema === undefined ? {} : { inputSchema: meta.inputSchema }),
        ...(meta.outputSchema === undefined ? {} : { outputSchema: meta.outputSchema }),
        ...(meta.desc === undefined || options.includeDesc === false ? {} : { desc: meta.desc }),
        mode: meta._streamMode === undefined ? 'unary' : meta._streamMode,
    }));

    const groups = groupByNamespace(flat);
    const namespaces: NamespaceTypes[] = [];
    for (const [ns, methods] of groups) {
        if (ns === '') continue;
        const prefix = pascal(ns);
        namespaces.push({
            ns,
            methods,
            inputName: (leaf) => `${prefix}${pascal(leaf)}Input`,
            clientName: `${prefix}Client`,
            serverName: `${prefix}Server`,
        });
    }

    const topLevel = groups.get('') ?? [];

    /** 某个方法要不要具名（按 naming 策略 + 形状） */
    const shouldNameInput = (m: FlatMethod): boolean => {
        if (naming === 'none') return false;
        if (naming === 'all') return !isVacuousInput(m.inputSchema);
        // auto：对象形状才具名（协议层的 request message）
        return zodTypeOf(m.inputSchema) === 'object' && !isVacuousInput(m.inputSchema);
    };
    const shouldNameOutput = (m: FlatMethod): boolean => {
        if (naming === 'none') return false;
        if (naming === 'all') return true;
        // auto：对象 / 对象数组 / 复杂联合才具名；标量与简单数组内联
        const t = zodTypeOf(m.outputSchema);
        if (t === 'object') return true;
        if (t === 'array') return zodTypeOf(zodElementOf(m.outputSchema)) === 'object';
        if (t === 'union') return true;
        return false;
    };

    /** 某个方法的入参 / 出参在签名里怎么写 */
    const inputRefOf = (m: FlatMethod, nameOf: (leaf: string) => string): string => {
        if (isVacuousInput(m.inputSchema)) return 'Record<string, never>';
        return shouldNameInput(m) ? nameOf(m.path) : zodToTs(m.inputSchema);
    };
    const outputRefOf = (m: FlatMethod, nameOf: (leaf: string) => string): string => {
        if (!shouldNameOutput(m)) return zodToTs(m.outputSchema);
        return nameOf(m.path).replace(/Input$/, 'Output');
    };

    const out: string[] = [];
    out.push('// ⚠️ 自动生成 —— 别手改（scripts/gen-service-types.ts）');
    out.push(`// 源：${typeName}Api`);
    if (naming !== 'none') out.push("import type { RpcCallOptions } from '@diy-agent/rpc';");
    else out.push("import type { RpcCallOptions } from '@diy-agent/rpc';");
    out.push('');
    out.push('// ⚠️ 模块名 / 方法路径是**跨进程契约**：改名 = 老客户端全挂（同 protobuf 的字段号）。');
    out.push('');

    // ── ① IO 具名类型（仅 naming !== 'none'）──
    if (naming !== 'none') {
        const inputTypes: string[] = [];
        const outputTypes: string[] = [];
        const emitIo = (methods: FlatMethod[], nameOf: (leaf: string) => string): void => {
            for (const m of methods) {
                if (shouldNameInput(m)) {
                    inputTypes.push(`/** \`${m.path}\` 的入参 */\nexport interface ${nameOf(m.path)} ${zodToTs(m.inputSchema)}`);
                }
                if (shouldNameOutput(m)) {
                    const outName = nameOf(m.path).replace(/Input$/, 'Output');
                    outputTypes.push(`/** \`${m.path}\` 的出参 */\nexport type ${outName} = ${zodToTs(m.outputSchema)};`);
                }
            }
        };
        for (const n of namespaces) emitIo(n.methods, n.inputName);
        if (topLevel.length > 0) emitIo(topLevel, (leaf) => `${typeName}${pascal(leaf)}Input`);
        if (inputTypes.length > 0) {
            out.push(inputTypes.join('\n\n'));
            out.push('');
        }
        if (outputTypes.length > 0) {
            out.push(outputTypes.join('\n'));
            out.push('');
        }
    }

    // ── ② 子接口（仅 naming === 'all' 出；否则所有权方法直接进聚合接口）──
    if (naming === 'all') {
        for (const n of namespaces) {
            for (const side of ['client', 'server'] as const) {
                const ifaceName = side === 'client' ? n.clientName : n.serverName;
                const body = n.methods
                    .map((m) => renderMethodSignature(m, side, inputRefOf(m, n.inputName), outputRefOf(m, n.inputName)))
                    .join('\n');
                out.push(`/** \`${n.ns}\` 的${side === 'client' ? '客户端' : '服务端'}形状 */\nexport interface ${ifaceName} {\n${body}\n}`);
                out.push('');
            }
        }
    }

    // ── ③ 聚合接口 ──
    const renderAggregate = (side: 'client' | 'server'): string => {
        const ifaceName = `${typeName}${side === 'client' ? 'Client' : 'Server'}`;
        const members: string[] = [];
        const topNameOf = (leaf: string): string => `${typeName}${pascal(leaf)}Input`;
        if (topLevel.length > 0) {
            members.push(
                topLevel
                    .map((m) => renderMethodSignature(m, side, inputRefOf(m, topNameOf), outputRefOf(m, topNameOf)))
                    .join('\n'),
            );
        }
        for (const n of namespaces) {
            if (naming === 'all') {
                members.push(`    ${methodKey(n.ns)}: ${side === 'client' ? n.clientName : n.serverName};`);
            } else {
                // none / auto：直接内联这个命名空间的方法
                const body = n.methods
                    .map((m) => renderMethodSignature(m, side, inputRefOf(m, n.inputName), outputRefOf(m, n.inputName)).replace(/^ {4}/gm, '        '))
                    .join('\n');
                members.push(`    ${methodKey(n.ns)}: {\n${body}\n    };`);
            }
        }
        return `/** ${typeName} 的**${side === 'client' ? '客户端' : '服务端'}**形状 */\nexport interface ${ifaceName} {\n${members.join('\n\n')}\n}`;
    };
    out.push(renderAggregate('client'));
    out.push('');
    out.push(renderAggregate('server'));
    out.push('');

    return out.join('\n');
}

/** 取一个 zod schema 的「类型名」（供判据用；认不出返回 undefined） */
function zodTypeOf(schema: z.ZodType | undefined): string | undefined {
    if (schema === undefined) return undefined;
    const anySchema = schema as unknown as { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown> };
    const d = (anySchema._zod?.def ?? anySchema.def ?? {}) as Record<string, unknown>;
    const t = d['type'];
    return typeof t === 'string' ? t : undefined;
}

/** 数组元素的 schema（非数组返回 undefined） */
function zodElementOf(schema: z.ZodType | undefined): z.ZodType | undefined {
    if (schema === undefined) return undefined;
    const anySchema = schema as unknown as { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown> };
    const d = (anySchema._zod?.def ?? anySchema.def ?? {}) as Record<string, unknown>;
    return d['element'] as z.ZodType | undefined;
}

/** `input: {}` / 缺省 input 视为「没有入参」—— 用 `Record<string, never>` 表达 */
function isVacuousInput(schema: z.ZodType | undefined): boolean {
    if (schema === undefined) return true;
    if (zodTypeOf(schema) !== 'object') return false;
    const anySchema = schema as unknown as { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown> };
    const d = (anySchema._zod?.def ?? anySchema.def ?? {}) as Record<string, unknown>;
    const shape = d['shape'] as Record<string, unknown> | undefined;
    return shape !== undefined && Object.keys(shape).length === 0;
}
