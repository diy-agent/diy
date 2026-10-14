// define.ts — 工作流定义 DSL（`defineWorkflow`）
//
// 依据 ##311 §一/§三/§五 与 ##166 §14.4 字段表：
//   - 泳道 ≡ 节点，1:1（无 `lanes` 段；`name` 只是节点自带的泳道显示名，原 `band`）；
//   - 打回不新建节点（`edges[].kind = 'bounce'` 只影响画线颜色与事件标注，**不改结构**）；
//   - 定义用 TS、参数用数据：`guard` / `hint` 是声明，`params` 是数据（L2，用户可调值）。
//
// **唯一保留的护栏**：`edges[].from / to` 只能取节点 id 的字面量联合 —— 打错字或「回退到泳道」
// 在**编译期**即报错（`defineWorkflow` 用 `const` 元组泛型把 `nodes[].id` 推成字面量联合，见
// `DefineInput`）。运行期再兜一层：悬空边 / 重号 / 入口不唯一一律抛 `FlowError`。

import { FlowError } from './errors';

/** 谁能在这里动作并宣布推进（##166 §14.4） */
export const ACTORS = ['agent', 'system', 'human'] as const;
export type Actor = (typeof ACTORS)[number];

/** 边种类：`next` 推进 / `bounce` 打回（只影响画线与标注，不改结构） */
export const EDGE_KINDS = ['next', 'bounce'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** 引擎侧通用渲染器全集（##166 §14.7：行业只写 `render` 插件做「形状翻译」，不写页面） */
export const RENDERERS = ['doc', 'diff', 'table', 'timeline', 'video', 'badge', 'kline', 'heatmap', 'equity'] as const;
export type Renderer = (typeof RENDERERS)[number];

/**
 * 节点产物的展示链 `{ raw, renderer, plugin }`（##166 §14.7）：
 * `raw` 是节点产出的原始数据（行业知道），`plugin` 是把 raw 翻译成引擎渲染器的 `render`
 * 插件名（需写代码处；无需插件则为 `null`），`renderer` 是引擎侧固定渲染器。
 */
export interface Art {
    readonly raw: string;
    readonly renderer: Renderer;
    readonly plugin?: string | null;
    readonly note?: string;
}

/** 参数（L2，用户可调值）的可枚举类型全集 —— 与 ##311 §二 一致 */
export const PARAM_TYPES = ['string', 'number', 'boolean', 'enum', 'list'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export interface ParamDef {
    readonly name: string;
    readonly type: ParamType;
    readonly label?: string;
    /** `type === 'enum'` 时的候选值（必填、非空） */
    readonly values?: readonly string[];
}

/** 一个泳道节点（泳道 ≡ 节点，1:1） */
export interface NodeDef<Id extends string = string> {
    /** 节点标识 = 泳道标识（1:1）；边只能引用它 */
    readonly id: Id;
    /** 泳道显示名（原 `band`，纯渲染分带标题） */
    readonly name: string;
    /** 谁能在这里动作并宣布推进 */
    readonly actor: Actor;
    /** 推进判据，**可为数组（与：全部满足）**；`prompt:` 不可观测 → actor 宣布，`pred:`/`action:` → 系统求值 */
    readonly guard: readonly string[];
    /** 提示词本体（用户说的「泳道条件集合」）；对 agent 是文本，对系统不可验证 */
    readonly hint: string;
    /** 本节点产物的展示链；无结构化产物则省略 */
    readonly art?: Art;
    /** 本节点可调参数（L2） */
    readonly params?: readonly ParamDef[];
}

/** 一条转移边（两端只能指向节点 id，禁止指向泳道） */
export interface EdgeDef<Id extends string = string> {
    readonly from: Id;
    readonly to: Id;
    /** 何时走这条边（同样分可观测 / 不可观测；本任务不求值，归 ##315） */
    readonly when?: string;
    readonly kind: EdgeKind;
}

/**
 * `defineWorkflow` 的入参。`N` 是 `nodes` 的**元组类型**（由 `const` 泛型推断），
 * `N[number]['id']` 即全部节点 id 的字面量联合 —— `edges[].from / to` 与 `entry` 只能取它。
 */
export interface DefineInput<N extends readonly NodeDef[] = readonly NodeDef[]> {
    /** 工作流标识（缺省空串） */
    readonly id?: string;
    /** 工作流显示名（缺省空串） */
    readonly name?: string;
    /** 入口节点；缺省由「没有任何边指向的节点」自动推断（必须唯一） */
    readonly entry?: N[number]['id'];
    readonly nodes: N;
    readonly edges: readonly EdgeDef<N[number]['id']>[];
}

/** 规范化后的工作流定义（键序固定、字段封闭、入口已确定） */
export interface WorkflowDef<Id extends string = string> {
    readonly id: string;
    readonly name: string;
    readonly entry: Id;
    readonly nodes: readonly NodeDef<Id>[];
    readonly edges: readonly EdgeDef<Id>[];
}

/**
 * 定义一个工作流。
 *
 * 类型护栏：`N` 从 `nodes` 推成**元组**，`N[number]['id']` 是节点 id 的字面量联合，
 * `edges[].from / to` 只能取该联合 —— 打错字 / 指到不存在的泳道**编译期报错**。
 *
 * ```ts
 * const wf = defineWorkflow({
 *     nodes: [
 *         { id: 'review', name: 'Review', actor: 'agent', guard: ['prompt:review_done'], hint: '…' },
 *         { id: 'implement', name: '开发', actor: 'agent', guard: ['prompt:dev_done'], hint: '…' },
 *     ],
 *     edges: [{ from: 'review', to: 'implment', kind: 'next' }], // ✗ 编译期报错（应为 implement）
 * });
 * ```
 */
export function defineWorkflow<const N extends readonly NodeDef[]>(def: DefineInput<N>): WorkflowDef<N[number]['id']> {
    return parseWorkflow(def, 'workflow') as WorkflowDef<N[number]['id']>;
}

const CODE = 'invalid-def' as const;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function takeString(value: unknown, path: string, allowEmpty = false): string {
    if (typeof value !== 'string') throw new FlowError(CODE, '应为字符串', path);
    if (!allowEmpty && value === '') throw new FlowError(CODE, '不能是空串', path);
    return value;
}

function rejectUnknown(obj: Record<string, unknown>, known: readonly string[], path: string): void {
    for (const key of Object.keys(obj)) {
        if (!known.includes(key)) {
            throw new FlowError(CODE, `未知字段 ${JSON.stringify(key)}（形状封闭）`, `${path}.${key}`);
        }
    }
}

function parseGuard(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) throw new FlowError(CODE, 'guard 应为字符串数组', path);
    const out = value.map((item, i) => takeString(item, `${path}[${i}]`));
    const seen = new Set<string>();
    out.forEach((item, i) => {
        if (seen.has(item)) throw new FlowError(CODE, `guard 重复 ${JSON.stringify(item)}`, `${path}[${i}]`);
        seen.add(item);
    });
    return out;
}

function parseArt(value: unknown, path: string): Art {
    if (!isObject(value)) throw new FlowError(CODE, 'art 应为对象', path);
    rejectUnknown(value, ['raw', 'renderer', 'plugin', 'note'], path);
    const renderer = value.renderer;
    if (typeof renderer !== 'string' || !(RENDERERS as readonly string[]).includes(renderer)) {
        throw new FlowError(CODE, `未知 renderer ${JSON.stringify(renderer)}（合法：${RENDERERS.join(' | ')}）`, `${path}.renderer`);
    }
    const art: { raw: string; renderer: Renderer; plugin?: string | null; note?: string } = {
        raw: takeString(value.raw, `${path}.raw`, true),
        renderer: renderer as Renderer,
    };
    if (value.plugin !== undefined) art.plugin = value.plugin === null ? null : takeString(value.plugin, `${path}.plugin`);
    if (value.note !== undefined) art.note = takeString(value.note, `${path}.note`, true);
    return art;
}

function parseParams(value: unknown, path: string): ParamDef[] {
    if (!Array.isArray(value)) throw new FlowError(CODE, 'params 应为数组', path);
    return value.map((item, i) => {
        const p = `${path}[${i}]`;
        if (!isObject(item)) throw new FlowError(CODE, '参数应为对象', p);
        rejectUnknown(item, ['name', 'type', 'label', 'values'], p);
        const type = item.type;
        if (typeof type !== 'string' || !(PARAM_TYPES as readonly string[]).includes(type)) {
            throw new FlowError(CODE, `未知参数类型 ${JSON.stringify(type)}（合法：${PARAM_TYPES.join(' | ')}）`, `${p}.type`);
        }
        const def: { name: string; type: ParamType; label?: string; values?: readonly string[] } = {
            name: takeString(item.name, `${p}.name`),
            type: type as ParamType,
        };
        if (item.label !== undefined) def.label = takeString(item.label, `${p}.label`, true);
        if (type === 'enum') {
            if (!Array.isArray(item.values) || item.values.length === 0) {
                throw new FlowError(CODE, 'enum 参数必须给出非空 values', `${p}.values`);
            }
            def.values = item.values.map((v, j) => takeString(v, `${p}.values[${j}]`));
        } else if (item.values !== undefined) {
            throw new FlowError(CODE, '仅 enum 参数可带 values', `${p}.values`);
        }
        return def;
    });
}

function parseNode<Id extends string>(value: unknown, path: string): NodeDef<Id> {
    if (!isObject(value)) throw new FlowError(CODE, '节点应为对象', path);
    rejectUnknown(value, ['id', 'name', 'actor', 'guard', 'hint', 'art', 'params'], path);
    const actor = value.actor;
    if (typeof actor !== 'string' || !(ACTORS as readonly string[]).includes(actor)) {
        throw new FlowError(CODE, `未知 actor ${JSON.stringify(actor)}（合法：${ACTORS.join(' | ')}）`, `${path}.actor`);
    }
    const node: {
        id: Id;
        name: string;
        actor: Actor;
        guard: string[];
        hint: string;
        art?: Art;
        params?: readonly ParamDef[];
    } = {
        id: takeString(value.id, `${path}.id`) as Id,
        name: takeString(value.name, `${path}.name`, true),
        actor: actor as Actor,
        guard: parseGuard(value.guard, `${path}.guard`),
        hint: takeString(value.hint, `${path}.hint`, true),
    };
    if (value.art !== undefined && value.art !== null) node.art = parseArt(value.art, `${path}.art`);
    if (value.params !== undefined) node.params = parseParams(value.params, `${path}.params`);
    return node;
}

function parseEdge<Id extends string>(value: unknown, path: string): EdgeDef<Id> {
    if (!isObject(value)) throw new FlowError(CODE, '边应为对象', path);
    rejectUnknown(value, ['from', 'to', 'when', 'kind'], path);
    const kind = value.kind;
    if (typeof kind !== 'string' || !(EDGE_KINDS as readonly string[]).includes(kind)) {
        throw new FlowError(CODE, `未知边种类 ${JSON.stringify(kind)}（合法：${EDGE_KINDS.join(' | ')}）`, `${path}.kind`);
    }
    const edge: { from: Id; to: Id; when?: string; kind: EdgeKind } = {
        from: takeString(value.from, `${path}.from`) as Id,
        to: takeString(value.to, `${path}.to`) as Id,
        kind: kind as EdgeKind,
    };
    if (value.when !== undefined) edge.when = takeString(value.when, `${path}.when`, true);
    return edge;
}

/**
 * 校验并规范化工作流定义（键序固定），非法一律抛 `FlowError`（带点路径）：
 * 节点重号 / 悬空边 / 同 (from,to) 重边 / 入口缺失或不唯一。
 */
export function parseWorkflow<Id extends string = string>(value: unknown, path = 'workflow'): WorkflowDef<Id> {
    if (!isObject(value)) throw new FlowError(CODE, '工作流定义应为对象', path);
    rejectUnknown(value, ['id', 'name', 'entry', 'nodes', 'edges'], path);
    if (!Array.isArray(value.nodes)) throw new FlowError(CODE, 'nodes 应为数组', `${path}.nodes`);
    if (!Array.isArray(value.edges)) throw new FlowError(CODE, 'edges 应为数组', `${path}.edges`);

    const nodes = value.nodes.map((n, i) => parseNode<Id>(n, `${path}.nodes[${i}]`));
    if (nodes.length === 0) throw new FlowError(CODE, 'nodes 不能为空', `${path}.nodes`);

    const ids = new Set<string>();
    nodes.forEach((n, i) => {
        if (ids.has(n.id)) throw new FlowError('duplicate-node', `节点 id 重复 ${JSON.stringify(n.id)}`, `${path}.nodes[${i}].id`);
        ids.add(n.id);
    });

    const edges = value.edges.map((e, i) => parseEdge<Id>(e, `${path}.edges[${i}]`));
    const pairs = new Set<string>();
    edges.forEach((e, i) => {
        if (!ids.has(e.from)) {
            throw new FlowError('dangling-edge', `边起点 ${JSON.stringify(e.from)} 不是节点 id（禁止指向泳道）`, `${path}.edges[${i}].from`);
        }
        if (!ids.has(e.to)) {
            throw new FlowError('dangling-edge', `边终点 ${JSON.stringify(e.to)} 不是节点 id（禁止指向泳道）`, `${path}.edges[${i}].to`);
        }
        const key = `${e.from}\u0000${e.to}`;
        if (pairs.has(key)) {
            throw new FlowError('duplicate-edge', `同一条 (${e.from} → ${e.to}) 出现多条边（无 guard 求值无法确定走哪条）`, `${path}.edges[${i}]`);
        }
        pairs.add(key);
    });

    let entry: Id;
    if (value.entry !== undefined) {
        const e = takeString(value.entry, `${path}.entry`) as Id;
        if (!ids.has(e)) throw new FlowError('dangling-edge', `入口 ${JSON.stringify(e)} 不是节点 id`, `${path}.entry`);
        entry = e;
    } else {
        const targets = new Set(edges.map((e) => e.to as string));
        const roots = nodes.filter((n) => !targets.has(n.id));
        if (roots.length === 0) throw new FlowError('no-entry', '找不到入口（没有任何边指向的节点）', `${path}.nodes`);
        if (roots.length > 1) {
            throw new FlowError('multiple-entry', `入口不唯一：${roots.map((n) => n.id).join(' / ')}（请显式给 entry）`, `${path}.nodes`);
        }
        entry = roots[0].id;
    }

    return {
        id: value.id === undefined ? '' : takeString(value.id, `${path}.id`, true),
        name: value.name === undefined ? '' : takeString(value.name, `${path}.name`, true),
        entry,
        nodes,
        edges,
    };
}

/** 非抛出版校验（给 UI / 反序列化前的猜测试探用） */
export function isWorkflow(value: unknown): value is WorkflowDef {
    try {
        parseWorkflow(value);
        return true;
    } catch {
        return false;
    }
}

/** 按 id 取节点（不存在返回 undefined） */
export function findNode<Id extends string>(def: WorkflowDef<Id>, id: string): NodeDef<Id> | undefined {
    return def.nodes.find((n) => n.id === id);
}
