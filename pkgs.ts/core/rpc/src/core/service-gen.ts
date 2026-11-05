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

/** 把扁平路径分组：`page.list` / `page.invoke` → 命名空间 `page` */
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

function renderMethod(m: FlatMethod, side: 'client' | 'server'): string {
    const input = zodToTs(m.inputSchema);
    const output = zodToTs(m.outputSchema);
    const desc = m.desc ? `    /** ${m.desc.replace(/\*\//g, '*\\/')} */\n` : '';
    if (side === 'client') {
        // 客户端：一定是 Promise；input 是单个对象参数
        return `${desc}    ${methodKey(m.path)}(input: ${input}, options?: RpcCallOptions): Promise<${output}>;`;
    }
    // 服务端：允许同步返回；多一个 ctx（signal 在里）
    return `${desc}    ${methodKey(m.path)}(opts: { input: ${input}; signal: AbortSignal }): ${output} | Promise<${output}>;`;
}

/** 把一组方法（同命名空间）渲染成接口体 */
function renderBody(methods: FlatMethod[], side: 'client' | 'server'): string {
    return methods.map((m) => renderMethod(m, side)).join('\n');
}

export interface RenderOptions {
    /** 方法描述首行是否搬进 JSDoc（默认 true） */
    readonly includeDesc?: boolean;
}

/**
 * 生成一个模块的 .d.ts（client + server 两组接口）。
 *
 * 返回**完整的文件内容**（含 import 头），直接 `writeFileSync` 即可。
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

    const renderSide = (side: 'client' | 'server', ifaceName: string): string => {
        const members: string[] = [];
        const topLevel = groups.get('') ?? [];
        if (topLevel.length > 0) members.push(renderBody(topLevel, side));
        for (const [ns, methods] of groups) {
            if (ns === '') continue;
            members.push(`    ${methodKey(ns)}: {\n${renderBody(methods, side)}\n    };`);
        }
        return `export interface ${ifaceName} {\n${members.join('\n\n')}\n}`;
    };

    return `// ⚠️ 自动生成 —— 别手改（scripts/gen-service-types.ts）
// 源：api 树 ${typeName}Api
import type { RpcCallOptions } from '@diy-agent/rpc';

/** ${typeName} 的**客户端**形状（\`service.use(client)\` 的返回值） */
${renderSide('client', typeName + 'Client')}

/** ${typeName} 的**服务端**形状（\`service.bind(server, handlers)\` 的第二参数） */
${renderSide('server', typeName + 'Server')}
`;
}
