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
 * 生成一个模块的 .d.ts（**具名子接口** + client / server 两组）。
 *
 * 为什么出子接口而不是内联（2026-11-05，参照「层级接口讨论总结」）：
 *   · 内联的 `input: { pageId: string; method: string; args?: unknown }` 一旦类型不匹配，
 *     报错会把整坨铺在屏幕上；具名后只显示 `InvokeInput`。
 *   · `PageClient` 能被单独 import —— 只用 page 的消费方不必拖进 view 的类型。
 *   · 生成物里每个子接口也有 JSDoc，IDE 里点过去是一整个类型。
 *
 * 命名约定：
 *   `page.list` → 接口 `PageClient` / `PageServer`，入参 `PageListInput`，出参 `PageListOutput`
 *   顶层方法（无命名空间）→ 直接挂在 `XxxClient` / `XxxServer` 上，入参 `XxxListInput`
 */
export function renderServiceTypes(
    typeName: string,
    api: _Router,
    options: RenderOptions = {},
): string {
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
    const out: string[] = [];
    out.push('// ⚠️ 自动生成 —— 别手改（scripts/gen-service-types.ts）');
    out.push(`// 源：${typeName}Api`);
    out.push("import type { RpcCallOptions } from '@diy-agent/rpc';");
    out.push('');

    // ── ① 入参 / 出参具名类型（所有命名空间 + 顶层） ──
    const inputTypes: string[] = [];
    const outputTypes: string[] = [];
    const emitIoTypes = (methods: FlatMethod[], nameOf: (leaf: string) => string): void => {
        for (const m of methods) {
            const inputName = nameOf(m.path);
            // 空 input 不生成类型（用 `Record<string, never>` 更直白，也免得生成一堆空接口）
            if (!isVacuousInput(m.inputSchema)) {
                inputTypes.push(`/** \`${m.path}\` 的入参 */\nexport interface ${inputName} ${zodToTs(m.inputSchema)}`);
            }
            const outputName = inputName.replace(/Input$/, 'Output');
            outputTypes.push(`/** \`${m.path}\` 的出参 */\nexport type ${outputName} = ${zodToTs(m.outputSchema)};`);
        }
    };
    for (const n of namespaces) emitIoTypes(n.methods, n.inputName);
    if (topLevel.length > 0) emitIoTypes(topLevel, (leaf) => `${typeName}${pascal(leaf)}Input`);

    if (inputTypes.length > 0) {
        out.push(inputTypes.join('\n\n'));
        out.push('');
    }
    if (outputTypes.length > 0) {
        out.push(outputTypes.join('\n'));
        out.push('');
    }

    // ── ② 子接口（每个命名空间一组 client / server） ──
    const renderSubInterface = (n: NamespaceTypes, side: 'client' | 'server'): string => {
        const ifaceName = side === 'client' ? n.clientName : n.serverName;
        const body = n.methods
            .map((m) => {
                const inputRef = isVacuousInput(m.inputSchema) ? 'Record<string, never>' : n.inputName(m.path);
                return renderMethodSignature(m, side, inputRef, n.inputName(m.path).replace(/Input$/, 'Output'));
            })
            .join('\n');
        return `/** \`${n.ns}\` 的${side === 'client' ? '客户端' : '服务端'}形状 */\nexport interface ${ifaceName} {\n${body}\n}`;
    };
    for (const n of namespaces) {
        out.push(renderSubInterface(n, 'client'));
        out.push('');
        out.push(renderSubInterface(n, 'server'));
        out.push('');
    }

    // ── ③ 聚合接口（只是引用子接口，不再内联） ──
    const renderAggregate = (side: 'client' | 'server'): string => {
        const ifaceName = `${typeName}${side === 'client' ? 'Client' : 'Server'}`;
        const members: string[] = [];
        if (topLevel.length > 0) {
            members.push(
                topLevel
                    .map((m) => {
                        const base = `${typeName}${pascal(m.path)}`;
                        const inputRef = isVacuousInput(m.inputSchema) ? 'Record<string, never>' : `${base}Input`;
                        return renderMethodSignature(m, side, inputRef, `${base}Output`);
                    })
                    .join('\n'),
            );
        }
        for (const n of namespaces) {
            members.push(`    ${methodKey(n.ns)}: ${side === 'client' ? n.clientName : n.serverName};`);
        }
        return `/** ${typeName} 的**${side === 'client' ? '客户端' : '服务端'}**形状（聚合） */\nexport interface ${ifaceName} {\n${members.join('\n\n')}\n}`;
    };
    out.push(renderAggregate('client'));
    out.push('');
    out.push(renderAggregate('server'));
    out.push('');

    return out.join('\n');
}

/** `input: {}` / 缺省 input 视为「没有入参」—— 用 `Record<string, never>` 表达 */
function isVacuousInput(schema: z.ZodType | undefined): boolean {
    if (schema === undefined) return true;
    const anySchema = schema as unknown as { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown> };
    const d = (anySchema._zod?.def ?? anySchema.def ?? {}) as Record<string, unknown>;
    const type = d['type'];
    if (type !== 'object') return false;
    const shape = d['shape'] as Record<string, unknown> | undefined;
    return shape !== undefined && Object.keys(shape).length === 0;
}
