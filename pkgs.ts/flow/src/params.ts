// params.ts — 参数层（L2）：用户可调的**值**，不可改的**形**
//
// 依据 ##311 §二/§三.5、##166 §13.1 与本任务 body（##316）：
//
//   · 判据同 §13.1（**引擎能枚举的 → 配置；引擎查不到的 → 插件**）：类型全集只收「引擎画得出
//     一个控件」的五种 —— `string | number | boolean | enum | list`。引擎画不出的（嵌套对象 /
//     任意 JSON）**不收**：没有表单渲染方案的类型放进来，UI 只能退化成「手写 JSON」，
//     等于把校验责任又推回用户（§二「UI 通用：按 schema 自动渲染」的前提）。
//   · **声明用 TS、值用 JSON**（§三）：节点定义里写 `params`（含 `default`），那是 L1（代码 / 发版）；
//     实例值是**纯 JSON**（可落库、可被 UI 表单改），那是 L2（改值 / 即时生效）。两条东西，不混。
//   · **用户只能改值、不能改形**：参数不得增删节点 / 边（拓扑变更 = 换一条工作流）。
//     「本次跳过某步」= 用参数让 `guard` / 边上的 `when` 短路，**不是**删节点（保住单指针 + 1:1 泳道）。
//   · 全限定名 = `<节点 id>.<局部名>` 的点路径，值也是**按节点分组**的同构嵌套：
//     `ctx.params.review.maxBounces` 就是 `review` 节点上那个 `maxBounces`。
//     ⇒ 局部名不许含 `.`（点号是节点限定符），声明了参数的节点 id 也不许含 `.`（同一理由）。
//   · **单一真源 + 单向导出**（§三.5）：唯一真源是每项的 `default`；`{ schema, defaults }` 快照
//     供 UI 自动生成表单 / 供文档渲染，反向解析只做校验与对齐 —— **不搞双向同步**（改快照不改回代码）。
//
// 本模块只回答「有哪些参数 / 什么类型 / 缺省多少 / 这个值合不合法」：
// 控件长什么样归 ##320，值从哪来（落库 / 表单 / CLI）归 ##319。

import type { NodeDef } from './define.js';
import { FlowError, type FlowErrorCode } from './errors.js';
import { isObject, rejectUnknown } from './validate.js';

/** 参数类型全集 —— **引擎能画出一个控件**的才算（##311 §二 / ##166 §13.1） */
export const PARAM_TYPES = ['string', 'number', 'boolean', 'enum', 'list'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/** 纯 JSON 标量（`list` 的元素也只能是这个 —— 参数**不支持嵌套**） */
export type ParamScalar = string | number | boolean;
/** 一个参数的值：标量，或**标量列表**（`list` 只装标量；空表合法） */
export type ParamValue = ParamScalar | readonly ParamScalar[];
/** 实例值 / 缺省值全集：`{ 节点 id: { 局部名: 值 } }`（与声明同构的嵌套） */
export type ParamValues = Readonly<Record<string, Readonly<Record<string, ParamValue>>>>;

/** 一条参数声明（写在节点定义里，L1 代码） */
export interface ParamDef {
    /** 节点内**局部名**（不含 `.` —— 点号是节点限定符，全限定名 = `节点 id.局部名`） */
    readonly name: string;
    readonly type: ParamType;
    /** UI 显示名（缺省回退 `name`） */
    readonly label?: string;
    /** 缺省值（**必填**：一个值都不填也要能跑，`ctx.params` 因此恒为全量） */
    readonly default: ParamValue;
    /** `enum` 的候选值（`enum` 必填、非空；其余类型带上即报错） */
    readonly enum?: readonly string[];
    /** 仅 `number`：闭区间下界 */
    readonly min?: number;
    /** 仅 `number`：闭区间上界 */
    readonly max?: number;
    /** 仅 `number`：单位（UI 后缀，如 `次` / `%`） */
    readonly unit?: string;
}

/** 一条**全限定**的参数声明（引擎 / UI / 文档按它渲染） */
export interface ParamEntry {
    /** 所属节点 id（UI 按它分组） */
    readonly node: string;
    readonly name: string;
    /** 全限定点路径 `节点 id.局部名`（对应实例值的 `values[node][name]`） */
    readonly path: string;
    readonly type: ParamType;
    /** 已回退的显示名（`label ?? name`） */
    readonly label: string;
    readonly default: ParamValue;
    readonly enum?: readonly string[];
    readonly min?: number;
    readonly max?: number;
    readonly unit?: string;
}

/**
 * 参数层声明 `params: { schema, defaults }`。
 *
 * `schema` 是**唯一真源**；`defaults` 是它与实例值同构的**派生视图**（解析快照时核对二者一致
 * —— 不许把 `defaults` 当第二真源）。
 */
export interface ParamsSchema {
    readonly schema: readonly ParamEntry[];
    readonly defaults: ParamValues;
}

/** 一条参数声明的约束字段（解析出来、已按类型裁剪过） */
interface Constraints {
    readonly enum?: readonly string[];
    readonly min?: number;
    readonly max?: number;
    readonly unit?: string;
}

const DEF_KEYS = ['name', 'type', 'label', 'default', 'enum', 'min', 'max', 'unit'] as const;
const ENTRY_KEYS = ['node', 'name', 'path', 'type', 'label', 'default', 'enum', 'min', 'max', 'unit'] as const;
const SCHEMA_KEYS = ['schema', 'defaults'] as const;

function takeString(value: unknown, path: string, code: FlowErrorCode, allowEmpty = false): string {
    if (typeof value !== 'string') throw new FlowError(code, '应为字符串', path);
    if (!allowEmpty && value === '') throw new FlowError(code, '不能是空串', path);
    return value;
}

function takeNumber(value: unknown, path: string, code: FlowErrorCode): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new FlowError(
            code,
            `应为有限数字（实得 ${JSON.stringify(value)}）—— NaN / Infinity 不是纯 JSON，落不了库`,
            path,
        );
    }
    return value;
}

function takeType(value: unknown, path: string, code: FlowErrorCode): ParamType {
    if (typeof value !== 'string' || !(PARAM_TYPES as readonly string[]).includes(value)) {
        throw new FlowError(code, `未知参数类型 ${JSON.stringify(value)}（合法：${PARAM_TYPES.join(' | ')}）`, path);
    }
    return value as ParamType;
}

/**
 * 按类型读约束字段 —— **形状封闭**：某个类型用不上的约束写上来即报错。
 *
 * 为什么不让它静默忽略：`{ type: 'string', enum: ['a'] }` 若被放过，作者以为「限定了候选」，
 * 实际枚举约束**一个字节都没生效** —— 与「未注册插件不降级」同型（见 registry.ts 头注）。
 */
function readConstraints(
    type: ParamType,
    value: Record<string, unknown>,
    path: string,
    code: FlowErrorCode,
): Constraints {
    const out: { enum?: readonly string[]; min?: number; max?: number; unit?: string } = {};
    if (type === 'enum') {
        const options = value.enum;
        if (!Array.isArray(options) || options.length === 0) {
            throw new FlowError(code, 'enum 参数必须给出非空 enum（候选值全集）', `${path}.enum`);
        }
        const seen = new Set<string>();
        out.enum = options.map((item, i) => {
            const text = takeString(item, `${path}.enum[${i}]`, code);
            if (seen.has(text))
                throw new FlowError(code, `enum 候选值重复 ${JSON.stringify(text)}`, `${path}.enum[${i}]`);
            seen.add(text);
            return text;
        });
        for (const key of ['min', 'max', 'unit'] as const) {
            if (value[key] !== undefined)
                throw new FlowError(code, `min / max / unit 只对 number 有意义（本项 type = enum）`, `${path}.${key}`);
        }
        return out;
    }
    if (value.enum !== undefined) throw new FlowError(code, 'enum 只对 type = enum 有意义', `${path}.enum`);
    if (type === 'number') {
        if (value.min !== undefined) out.min = takeNumber(value.min, `${path}.min`, code);
        if (value.max !== undefined) out.max = takeNumber(value.max, `${path}.max`, code);
        if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
            throw new FlowError(code, `下界 ${out.min} 大于上界 ${out.max}（这条约束永远不成立）`, `${path}.min`);
        }
        if (value.unit !== undefined) out.unit = takeString(value.unit, `${path}.unit`, code);
        return out;
    }
    for (const key of ['min', 'max', 'unit'] as const) {
        if (value[key] !== undefined)
            throw new FlowError(code, `min / max / unit 只对 number 有意义（本项 type = ${type}）`, `${path}.${key}`);
    }
    return out;
}

/**
 * 值校验 —— **同一个函数**给两处用：声明期的 `default`（定义错误）与运行期的实例值（`invalid-param`）。
 *
 * 两处若各写一套，迟早分叉成「缺省值能过、用户填同样的值却报错」这种最难查的错。
 */
function checkValue(
    type: ParamType,
    constraints: Constraints,
    value: unknown,
    path: string,
    code: FlowErrorCode,
): ParamValue {
    switch (type) {
        case 'string':
            return takeString(value, path, code, true);
        case 'number': {
            const n = takeNumber(value, path, code);
            if (constraints.min !== undefined && n < constraints.min) {
                throw new FlowError(code, `小于下界 ${constraints.min}（实得 ${n}）`, path);
            }
            if (constraints.max !== undefined && n > constraints.max) {
                throw new FlowError(code, `大于上界 ${constraints.max}（实得 ${n}）`, path);
            }
            return n;
        }
        case 'boolean':
            if (typeof value !== 'boolean')
                throw new FlowError(code, `应为布尔（实得 ${JSON.stringify(value)}）`, path);
            return value;
        case 'enum': {
            const options = constraints.enum ?? [];
            if (typeof value !== 'string')
                throw new FlowError(code, `应为字符串（候选：${options.join(' | ')}）`, path);
            if (!options.includes(value))
                throw new FlowError(code, `不在候选中：${JSON.stringify(value)}（合法：${options.join(' | ')}）`, path);
            return value;
        }
        case 'list': {
            if (!Array.isArray(value)) throw new FlowError(code, '应为数组（list 只装标量，不嵌套）', path);
            return Object.freeze(
                value.map((item, i) => {
                    if (typeof item === 'string' || typeof item === 'boolean') return item;
                    if (typeof item === 'number') return takeNumber(item, `${path}[${i}]`, code);
                    throw new FlowError(
                        code,
                        `list 只装标量（string | number | boolean），不接受 ${Array.isArray(item) ? '数组' : item === null ? 'null' : typeof item}`,
                        `${path}[${i}]`,
                    );
                }),
            );
        }
    }
}

/** 解析一条参数声明（`path` 指向它自己） */
function parseParamDef(value: unknown, path: string, code: FlowErrorCode): ParamDef {
    if (!isObject(value)) throw new FlowError(code, '参数声明应为对象', path);
    rejectUnknown(value, DEF_KEYS, path, code);
    const name = takeString(value.name, `${path}.name`, code);
    if (name.includes('.')) {
        throw new FlowError(
            code,
            `参数名不得含 '.'（点号是节点限定符，全限定名 = 节点 id.局部名）：${JSON.stringify(name)}`,
            `${path}.name`,
        );
    }
    const type = takeType(value.type, `${path}.type`, code);
    if (!Object.prototype.hasOwnProperty.call(value, 'default')) {
        throw new FlowError(code, '参数必须给出 default（一个值都不填也要能跑）', `${path}.default`);
    }
    const constraints = readConstraints(type, value, path, code);
    const def: {
        name: string;
        type: ParamType;
        label?: string;
        default: ParamValue;
        enum?: readonly string[];
        min?: number;
        max?: number;
        unit?: string;
    } = {
        name,
        type,
        default: checkValue(type, constraints, value.default, `${path}.default`, code),
    };
    if (value.label !== undefined) def.label = takeString(value.label, `${path}.label`, code, true);
    if (constraints.enum !== undefined) def.enum = constraints.enum;
    if (constraints.min !== undefined) def.min = constraints.min;
    if (constraints.max !== undefined) def.max = constraints.max;
    if (constraints.unit !== undefined) def.unit = constraints.unit;
    return def;
}

/**
 * 解析一组参数声明（节点定义里的 `params`）。
 *
 * `code` 由调用方定：定义期（`defineWorkflow`）沿用 `invalid-def`；解析序列化快照用 `invalid-param`。
 */
export function parseParamDefs(value: unknown, path: string, code: FlowErrorCode = 'invalid-def'): readonly ParamDef[] {
    if (!Array.isArray(value)) throw new FlowError(code, 'params 应为声明数组', path);
    const defs = value.map((item, i) => parseParamDef(item, `${path}[${i}]`, code));
    const seen = new Set<string>();
    defs.forEach((def, i) => {
        if (seen.has(def.name))
            throw new FlowError(
                code,
                `参数名重复 ${JSON.stringify(def.name)}（同一节点内不许重名）`,
                `${path}[${i}].name`,
            );
        seen.add(def.name);
    });
    return defs;
}

/** 从工作流定义收集参数层声明：全限定 + 按节点序 / 声明序 + 派生 `defaults` */
export function paramsOf(def: { readonly nodes: readonly NodeDef[] }): ParamsSchema {
    const schema: ParamEntry[] = [];
    const defaults: Record<string, Record<string, ParamValue>> = {};
    def.nodes.forEach((node, i) => {
        const defs = node.params ?? [];
        if (defs.length === 0) return;
        if (node.id.includes('.')) {
            // 与 `parseWorkflow` 同一不变量、同一错误形态（`nodes[<i>].id`）—— 两条入口不许各报各的。
            throw new FlowError(
                'invalid-def',
                `节点 id 含 '.' 却又声明了参数：点号是参数路径的限定符（${JSON.stringify(node.id)}）`,
                `nodes[${i}].id`,
            );
        }
        const bag: Record<string, ParamValue> = {};
        for (const param of defs) {
            const entry: ParamEntry = {
                node: node.id,
                name: param.name,
                path: `${node.id}.${param.name}`,
                type: param.type,
                label: param.label ?? param.name,
                default: param.default,
                ...(param.enum === undefined ? {} : { enum: param.enum }),
                ...(param.min === undefined ? {} : { min: param.min }),
                ...(param.max === undefined ? {} : { max: param.max }),
                ...(param.unit === undefined ? {} : { unit: param.unit }),
            };
            schema.push(Object.freeze(entry));
            bag[param.name] = param.default;
        }
        defaults[node.id] = Object.freeze(bag);
    });
    return Object.freeze({ schema: Object.freeze(schema), defaults: Object.freeze(defaults) });
}

/**
 * 实例值校验 + 默认合并（纯函数）。
 *
 * 缺省来自 `schema`，实例值只覆盖它**给了**的那些 ⇒ 一个值都不填时结果就是 `defaults`（工作流照跑）。
 * 返回与声明同构的嵌套 `{ 节点 id: { 局部名: 值 } }`（整体与每个袋子都**冻结** —— 交给插件的就是这个）。
 */
export function resolveParams(schema: ParamsSchema, values?: unknown): ParamValues {
    if (values !== undefined && !isObject(values)) {
        throw new FlowError('invalid-param', 'params 实例值应为对象（{ 节点 id: { 局部名: 值 } }）', 'values');
    }
    const byNode = new Map<string, ParamEntry[]>();
    for (const entry of schema.schema) {
        const list = byNode.get(entry.node);
        if (list) list.push(entry);
        else byNode.set(entry.node, [entry]);
    }

    if (values) {
        for (const node of Object.keys(values)) {
            const entries = byNode.get(node);
            if (!entries) {
                const known = byNode.size === 0 ? '（无）' : [...byNode.keys()].join(', ');
                throw new FlowError(
                    'unknown-param',
                    `未知参数节点 ${JSON.stringify(node)}（声明了参数的节点：${known}）`,
                    `values.${node}`,
                );
            }
            const bag = values[node];
            if (!isObject(bag))
                throw new FlowError('invalid-param', `节点 ${JSON.stringify(node)} 的参数值应为对象`, `values.${node}`);
            for (const name of Object.keys(bag)) {
                if (!entries.some((entry) => entry.name === name)) {
                    throw new FlowError(
                        'unknown-param',
                        `未知参数 ${JSON.stringify(`${node}.${name}`)}（${node} 已声明：${entries.map((e) => e.name).join(', ')}）`,
                        `values.${node}.${name}`,
                    );
                }
            }
        }
    }

    const out: Record<string, Record<string, ParamValue>> = {};
    for (const [node, entries] of byNode) {
        const bag: Record<string, unknown> = (values?.[node] as Record<string, unknown>) ?? {};
        const filled: Record<string, ParamValue> = {};
        for (const entry of entries) {
            const given = Object.prototype.hasOwnProperty.call(bag, entry.name);
            filled[entry.name] = given
                ? checkValue(entry.type, entry, bag[entry.name], `values.${node}.${entry.name}`, 'invalid-param')
                : entry.default;
        }
        out[node] = Object.freeze(filled);
    }
    return Object.freeze(out);
}

/** 解析一条**已全限定**的快照条目（`paramsOf` 导出的形状） */
function parseParamEntry(value: unknown, path: string): ParamEntry {
    if (!isObject(value)) throw new FlowError('invalid-param', 'schema 条目应为对象', path);
    rejectUnknown(value, ENTRY_KEYS, path, 'invalid-param');
    const node = takeString(value.node, `${path}.node`, 'invalid-param');
    // 定义期禁的三条，快照期一条不少（快照是读回的唯一入口，不变量不许分叉）：
    // ① 节点 id 不含 `.`　② 局部名不含 `.`　③ 同一 path 只出现一次（③ 在 parseParamsSchema 收尾）。
    if (node.includes('.')) {
        throw new FlowError(
            'invalid-param',
            `节点 id 不得含 '.'（点号是参数路径的限定符）：${JSON.stringify(node)}`,
            `${path}.node`,
        );
    }
    const name = takeString(value.name, `${path}.name`, 'invalid-param');
    if (name.includes('.')) {
        throw new FlowError(
            'invalid-param',
            `参数名不得含 '.'（点号是节点限定符，全限定名 = 节点 id.局部名）：${JSON.stringify(name)}`,
            `${path}.name`,
        );
    }
    const full = `${node}.${name}`;
    if (value.path !== full) {
        throw new FlowError(
            'invalid-param',
            `path 应为 ${JSON.stringify(full)}（= node + '.' + name）`,
            `${path}.path`,
        );
    }
    const type = takeType(value.type, `${path}.type`, 'invalid-param');
    const constraints = readConstraints(type, value, path, 'invalid-param');
    const entry: {
        node: string;
        name: string;
        path: string;
        type: ParamType;
        label: string;
        default: ParamValue;
        enum?: readonly string[];
        min?: number;
        max?: number;
        unit?: string;
    } = {
        node,
        name,
        path: full,
        type,
        label: takeString(value.label, `${path}.label`, 'invalid-param', true),
        default: checkValue(type, constraints, value.default, `${path}.default`, 'invalid-param'),
    };
    if (constraints.enum !== undefined) entry.enum = constraints.enum;
    if (constraints.min !== undefined) entry.min = constraints.min;
    if (constraints.max !== undefined) entry.max = constraints.max;
    if (constraints.unit !== undefined) entry.unit = constraints.unit;
    return Object.freeze(entry) as ParamEntry;
}

/** 同一形状的嵌套值比较（只比标量 / 标量列表，故不必引深比较库） */
function sameValues(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]);
    }
    if (isObject(a) && isObject(b)) {
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValues(a[key], b[key]));
    }
    return a === b;
}

/** 从全限定声明派生 `defaults`（唯一真源是每项的 `default`） */
function deriveDefaults(schema: readonly ParamEntry[]): Record<string, Record<string, ParamValue>> {
    const out: Record<string, Record<string, ParamValue>> = {};
    for (const entry of schema) {
        if (!out[entry.node]) out[entry.node] = {};
        out[entry.node][entry.name] = entry.default;
    }
    for (const node of Object.keys(out)) out[node] = Object.freeze(out[node]);
    return out;
}

/**
 * 解析一份序列化快照 `{ schema, defaults }`（`JSON.stringify(paramsOf(def))` 的形状）。
 *
 * 用途是**单向导出**的反向校验（§三.5）：UI / 文档拿到的是快照，改它**不会**改回代码；
 * 这里只做形状封闭 + 类型规则 + `defaults` 与 `schema` 对齐（快照被改坏即报，别静默当第二真源）。
 */
export function parseParamsSchema(value: unknown, path = 'params'): ParamsSchema {
    if (!isObject(value)) throw new FlowError('invalid-param', '参数快照应为对象（{ schema, defaults }）', path);
    rejectUnknown(value, SCHEMA_KEYS, path, 'invalid-param');
    if (!Array.isArray(value.schema)) throw new FlowError('invalid-param', 'schema 应为数组', `${path}.schema`);
    const schema = value.schema.map((item, i) => parseParamEntry(item, `${path}.schema[${i}]`));
    // 一条 path 只能出现一次：重复会让下游（UI 按 path 拆键、宿主按 path 拆值袋）拿到两个同键条目。
    const paths = new Set<string>();
    schema.forEach((entry, i) => {
        if (paths.has(entry.path)) {
            throw new FlowError(
                'invalid-param',
                `参数 path 重复 ${JSON.stringify(entry.path)}（快照里一条 path 只能出现一次）`,
                `${path}.schema[${i}].path`,
            );
        }
        paths.add(entry.path);
    });
    const defaults = deriveDefaults(schema);
    if (!isObject(value.defaults) || !sameValues(value.defaults, defaults)) {
        throw new FlowError(
            'invalid-param',
            'defaults 与 schema 不一致（defaults 只是派生视图，唯一真源是每项的 default）',
            `${path}.defaults`,
        );
    }
    return Object.freeze({ schema: Object.freeze(schema), defaults: Object.freeze(defaults) });
}

/** 插值选项 */
export interface InterpolateOptions {
    /** 当前节点 id：裸名 `${局部名}` 在该节点的参数里找；`${节点 id.局部名}` 恒可全限定 */
    readonly node?: string;
    /** 出错定位的点路径（缺省 `hint`） */
    readonly path?: string;
}

/** 把一个参数值写成提示词里的一段文本（`list` 用 `, ` 连接） */
function formatParamValue(value: ParamValue): string {
    return Array.isArray(value)
        ? (value as readonly ParamScalar[]).map((item) => String(item)).join(', ')
        : String(value);
}

/** 解析一个占位符引用 → 参数值（**找不到即报**，绝不插空串） */
function lookupParam(
    ref: string,
    params: Readonly<Record<string, unknown>>,
    node: string | undefined,
    path: string,
): ParamValue {
    if (ref === '') throw new FlowError('invalid-param', '插值为空：${}', path);
    const at = ref.indexOf('.');
    const qualified = at > 0;
    const owner = qualified ? ref.slice(0, at) : node;
    const name = qualified ? ref.slice(at + 1) : ref;
    if (owner === undefined) {
        throw new FlowError(
            'unknown-param',
            `插值 \${${ref}} 是裸名，但没给当前节点 —— 请写成全限定名「节点 id.局部名」`,
            path,
        );
    }
    const bag = params[owner];
    const value = isObject(bag) ? bag[name] : undefined;
    if (value === undefined) {
        throw new FlowError(
            'unknown-param',
            `插值 \${${ref}} 找不到参数（${owner}.${name}）—— 参数只能来自节点定义里的 params`,
            path,
        );
    }
    // 已声明的参数到不了这里（形状已校验）；未声明参数的「自由袋」里可能是任意 JSON
    // ⇒ 插不进提示词的形状当场报，别渲染成 `[object Object]` 混进提示词里。
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (isParamList(value)) return value;
    throw new FlowError('invalid-param', `插值 \${${ref}} 取到的不是标量 / 标量列表：${JSON.stringify(value)}`, path);
}

/** 是不是「标量列表」（`list` 参数的形状：只装标量，空表也算） */
function isParamList(value: unknown): value is readonly ParamScalar[] {
    return (
        Array.isArray(value) &&
        value.every(
            (item: unknown) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
        )
    );
}

/** `hint` 占位符语法（唯一真源）：`${ref}` 引用 + `$$` 转义（见 `interpolate`） */
const PLACEHOLDER = /\$(\$|\{([^{}]*)\})/g;

/**
 * 扫出 `hint` 里的占位符引用（供**定义期静态校验**复用同一套语法，见 `define.ts`）。
 *
 * 只认 `interpolate` 认的那两种：`${ref}`（返回 `ref`）、`$$`（转义，不算引用）。
 * `unclosed` = 模板里还剩没配对的 `${`（`$$` 已消费 ⇒ 不会被误认）。
 */
export function scanPlaceholders(template: string): { refs: string[]; unclosed: boolean } {
    const refs: string[] = [];
    const pattern = new RegExp(PLACEHOLDER.source, 'g');
    let match: RegExpExecArray | null;
    let cursor = 0;
    while ((match = pattern.exec(template)) !== null) {
        cursor = match.index + match[0].length;
        if (match[1] !== '$') refs.push(match[2]);
    }
    return { refs, unclosed: template.slice(cursor).includes('${') };
}

/**
 * `hint` 插值：把 `${参数}` 换成值。
 *
 * 写法（只认这两种，别的不猜）：
 *   `${局部名}`        —— 当前节点（`options.node`）上的参数
 *   `${节点 id.局部名}` —— 全限定，任意节点
 *   `$$`               —— 字面量 `$`（`$${x}` = 原样 `${x}`）
 *
 * **找不到参数即抛 `unknown-param`** —— 提示词里出现 `${typo}` 时静默插成空串，是「工作流悄悄
 * 偏到另一条路径」的同型失败（人看到的提示词缺了一段，而没人知道）。
 */
export function interpolate(
    template: string,
    params: Readonly<Record<string, unknown>>,
    options: InterpolateOptions = {},
): string {
    const path = options.path ?? 'hint';
    if (typeof template !== 'string') throw new FlowError('invalid-param', 'hint 应为字符串', path);
    const placeholder = /\$(\$|\{([^{}]*)\})/g;
    let out = '';
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = placeholder.exec(template)) !== null) {
        out += template.slice(cursor, match.index);
        cursor = match.index + match[0].length;
        if (match[1] === '$') {
            out += '$';
            continue;
        }
        out += formatParamValue(lookupParam(match[2], params, options.node, path));
    }
    const rest = template.slice(cursor);
    if (rest.includes('${')) throw new FlowError('invalid-param', '未闭合的插值 `${`（字面量 `$` 请写 `$$`）', path);
    return out + rest;
}

/** 渲染一个节点的 `hint`（UI / 装配侧要「人看到的提示词」时调它；本包不替谁渲染） */
export function renderHint(
    node: { readonly id: string; readonly hint: string },
    params: Readonly<Record<string, unknown>>,
    path?: string,
): string {
    // 出错定位到具体节点（`nodes.<id>.hint`）—— 包内所有错误都点路径，插值错没道理退化成裸 `hint`。
    return interpolate(node.hint, params, { node: node.id, path: path ?? `nodes.${node.id}.hint` });
}
