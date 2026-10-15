// serialize.ts — 领域状态的 JSON 序列化 / 反序列化（##333 交付 C）
//
// **为什么必须有它**：##333 的判据是「领域状态一等、可独立落盘」。而「可落盘」的前提是
// 「**读回可信**」—— 此前 `FlowState` 只能靠结构化类型假装（`as FlowState`），包内零校验入口，
// 盘上那份东西是不是 FlowState 全凭运气（owner 探针事实 4）。本文件补上这个入口。
//
// 契约与 `@diy/talk` 的 `serialize.ts` **同形**（读侧可信、写侧严格）：
// - **写**：先 `parseFlowState` 校验并规范化（键序固定、字段封闭）⇒ 落盘文本稳定、diff 友好；
//   写侧同样严格（未知字段报错）—— 绝不静默抹掉调用方传进来的数据。
// - **读**：同样走 `parseFlowState` ⇒ 读进来的一律可信；非法输入抛 `FlowError`（不静默丢弃）。
//   读侧要前向兼容（新版本加的字段）显式传 `{ allowUnknown: true }`（同 talk：**只放行、不保留**）。
//
// 落地格式（缩进多行 vs 紧凑单行 jsonl）由宿主决定（同 talk）：`flowStateToJson` 缺省缩进多行；
// 传 `{ compact: true }` 输出紧凑单行，供 ##319 拼 jsonl（每行一条记录）。
// **落盘位置 / 文件布局不归本包**（归 ##319）。
//
// 校验不止「形状」：`position` 与 `path` 的**一致性**、每节点 `seq` 的**单调性**都在这里兜住 ——
// 一份「形状对、语义自相矛盾」的状态比一份形状错的状态更危险（它会被当成真源继续推）。
//
// ⚠️ **`at` 不要求单调**（立场，非疏漏）：折线的**次序**由 `path` 数组本身承载（`path[i]` 就是第 i 次驻留），
// `at` 只是那次驻留的**信息**。故 `at` 倒流（后一条比前一条早）**照收** —— 它可能来自时钟回拨 / 宿主补录，
// 那是宿主的事实；拿它排序才是错的（会把次序判歪）。**读盘的人：要次序看数组下标，别信 `at`。**
//
// ⚠️ **`params` 只兜「纯 JSON 性」，不兜「值语义」**（立场，非疏漏）：类型 / enum / 上下界归 ##316 的
// `resolveParams(paramsOf(def), 值)` —— 它在 `createRuntime` 跑一次，而**读回路径不经过它**
// （`parseFlowState` 只吃状态、不吃 `def`，没法校验）。故盘上的 `params` 可能是**脏**的；但它进不了运行态：
// 第二次 `createRuntime` 仍会用 `resolveParams` 拒掉（`requireParamsMatch` 只比相等、不比合法性）。
// 要连值一起核：`resolveParams(paramsOf(def), state.params)`。

import { parseRef, type FlowState, type Visit } from './container';
import { EDGE_KINDS, type EdgeKind } from './define';
import { FlowError } from './errors';
import { isIsoString, isObject, rejectUnknown } from './validate';

/** 序列化选项：`compact` 输出紧凑单行（jsonl 用），缺省缩进多行 */
export interface SerializeOptions {
    readonly compact?: boolean;
}

/**
 * 解析选项。`allowUnknown`：放行未知字段（**仅供读侧前向兼容**，缺省严格）。
 *
 * ⚠️ 契约（同 `@diy/talk`）：`allowUnknown` 是**只读检查闸** —— 它只让解析「不报错」，
 * **不保留**未知字段（返回的仍是「只含已知字段」的规范化对象）。故用它读进来的对象**不得**
 * 再经 `flowStateToJson` 写回落盘：写侧严格，且未知字段已不在返回值里 —— 读-改-写一次就把新字段抹了。
 */
export interface ParseOptions {
    readonly allowUnknown?: boolean;
}

const CODE = 'invalid-state' as const;
const STATE_KEYS = ['position', 'path', 'params', 'done'] as const;
const VISIT_KEYS = ['node', 'seq', 'kind', 'at', 'ref'] as const;

/** JSON 值的嵌套深度上限：参数值是「节点 → 局部名 → 标量/标量列表」，两层足够；越深即视为非法 */
const MAX_JSON_DEPTH = 8;

/**
 * 是不是可落盘的 JSON 值（标量 / 数组 / 普通对象，且**有限深**）。
 *
 * 深度上限顺带挡住**环形结构**（`const a = {}; a.self = a` —— 递归会爆栈，JSON.stringify 会抛）。
 * 这里不校验「参数值的**语义**」（类型 / enum / 上下界）—— 那归 ##316 的 `resolveParams`；
 * 本函数只保证「写下去能读回来」（`undefined` / 函数 / `NaN` / `Date` 之类会静默变成 `null` 或丢掉）。
 */
function isJsonValue(value: unknown, depth = 0): boolean {
    if (depth > MAX_JSON_DEPTH) return false;
    if (value === null) return true;
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return true;
    if (type === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
    if (isObject(value)) return Object.values(value).every((item) => isJsonValue(item, depth + 1));
    return false;
}

/** 深拷贝成纯 JSON（普通对象 / 数组），并冻结 —— 读回来的东西与调用方的对象再无瓜葛 */
function freezeJson(value: unknown): unknown {
    if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
    if (isObject(value)) {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) out[key] = freezeJson(item);
        return Object.freeze(out);
    }
    return value;
}

/**
 * 校验并规范化 L2 实例参数值（##333 交付 G）。
 *
 * **值语义归 ##316**（`resolveParams(paramsOf(def), 值)` 是唯一入口，本包不重写校验）；快照这一层只保证
 * 「是纯 JSON 对象、可落盘、可读回」：形状 `{ 节点 id: { 局部名: 值 } }` 是**声明了参数**时的形状，
 * 而工作流**没声明参数**时它就是宿主原样透传的袋（##316 `rule.param-bag-when-undeclared`）——
 * 故这里不假定内层形状，只要求整袋是有限深的纯 JSON。
 */
function parseParams(value: unknown, path: string): Readonly<Record<string, unknown>> | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isObject(value)) throw new FlowError(CODE, 'params 应为对象（{ 节点 id: { 局部名: 值 } }）', path);
    if (!isJsonValue(value)) {
        throw new FlowError(CODE, 'params 必须是纯 JSON（标量 / 标量列表 / 有限深对象：不接受 undefined / 函数 / NaN / Infinity / 环形结构）', path);
    }
    return freezeJson(value) as Readonly<Record<string, unknown>>;
}

function takeObject(value: unknown, path: string): Record<string, unknown> {
    if (!isObject(value)) throw new FlowError(CODE, '应为对象', path);
    return value;
}

function takeString(value: unknown, path: string): string {
    if (typeof value !== 'string' || value === '') throw new FlowError(CODE, '应为非空字符串', path);
    return value;
}

function parseVisit<Id extends string>(value: unknown, path: string, options: ParseOptions): Visit<Id> {
    const obj = takeObject(value, path);
    if (!options.allowUnknown) rejectUnknown(obj, VISIT_KEYS, path, CODE);

    const node = takeString(obj.node, `${path}.node`) as Id;
    const seq = obj.seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
        throw new FlowError(CODE, `seq 应为 >= 1 的整数（该节点第几次驻留），实得 ${JSON.stringify(seq)}`, `${path}.seq`);
    }
    const kind = obj.kind;
    if (typeof kind !== 'string' || !(EDGE_KINDS as readonly string[]).includes(kind)) {
        throw new FlowError(CODE, `未知边种类 ${JSON.stringify(kind)}（合法：${EDGE_KINDS.join(' | ')}）`, `${path}.kind`);
    }
    if (!isIsoString(obj.at)) {
        throw new FlowError(CODE, `at 应为 ISO-8601 时刻（如 2026-10-13T00:00:00.000Z），实得 ${JSON.stringify(obj.at)}`, `${path}.at`);
    }
    const ref = parseRef(obj.ref, `${path}.ref`, CODE);
    return ref === undefined
        ? { node, seq, kind: kind as EdgeKind, at: obj.at }
        : { node, seq, kind: kind as EdgeKind, at: obj.at, ref };
}

/**
 * 校验并规范化领域状态（**读回可信的唯一入口**）；非法一律抛 `FlowError`（带点路径）。
 *
 * 除了形状（`position` / `path` / `params` / `done` / 每条 Visit 的字段），还兜住**语义自洽**：
 * - `position === null` **当且仅当** `path` 为空（单指针容器：位置就是折线末端）；
 * - `position === path.at(-1).node`（位置与折线末端必须一致 —— 不一致的状态会悄悄把工作流推歪）；
 * - 每个节点的 `seq` 按折线序恰为 `1, 2, 3…`（`seq` 的定义就是「该节点第几次驻留」）；
 * - `done === true` ⇒ **已经进入过**（`position !== null`）—— 「跑完」不能凭空发生。
 *
 * **不校验边的存在性**：那要 `WorkflowDef`，本函数只吃状态（同 talk 的 `parse*` 只吃自己那份数据）。
 * **也不校验 `params` 的值语义**（类型 / enum / 上下界）—— 那是 ##316 `resolveParams(paramsOf(def), 值)`
 * 的活；本函数只保证它是可落盘的纯 JSON。故**盘上的 `params` 可能脏**，但脏值进不了运行态（`createRuntime`
 * 是唯一闸门）。要连值一起核：`resolveParams(paramsOf(def), state.params)`。
 */
export function parseFlowState<Id extends string = string>(value: unknown, path = 'flowState', options: ParseOptions = {}): FlowState<Id> {
    const obj = takeObject(value, path);
    if (!options.allowUnknown) rejectUnknown(obj, STATE_KEYS, path, CODE);

    if (!('position' in obj)) throw new FlowError(CODE, '缺少 position（`null` = 尚未进入工作流）', `${path}.position`);
    if (!Array.isArray(obj.path)) throw new FlowError(CODE, 'path 应为数组（折线）', `${path}.path`);
    const visits = obj.path.map((item, i) => parseVisit<Id>(item, `${path}.path[${i}]`, options));

    const rawPosition = obj.position;
    const position = rawPosition === null ? null : (takeString(rawPosition, `${path}.position`) as Id);
    if (position === null && visits.length > 0) {
        throw new FlowError(CODE, `position 为 null（未进入）却有 ${visits.length} 条折线 —— 单指针容器的位置就是折线末端`, `${path}.position`);
    }
    if (position !== null && visits.length === 0) {
        throw new FlowError(CODE, `position = ${JSON.stringify(position)} 却没有折线 —— 位置只能由驻留产生`, `${path}.position`);
    }
    if (position !== null && visits[visits.length - 1].node !== position) {
        throw new FlowError(CODE, `position = ${JSON.stringify(position)} 与折线末端 ${JSON.stringify(visits[visits.length - 1].node)} 不一致`, `${path}.position`);
    }

    const counts = new Map<string, number>();
    visits.forEach((visit, i) => {
        const next = (counts.get(visit.node) ?? 0) + 1;
        if (visit.seq !== next) {
            throw new FlowError(CODE, `节点 ${JSON.stringify(visit.node)} 的 seq 应为 ${next}（第几次驻留），实得 ${visit.seq}`, `${path}.path[${i}].seq`);
        }
        counts.set(visit.node, next);
    });

    const params = parseParams(obj.params, `${path}.params`);

    const done = obj.done;
    if (done !== undefined && typeof done !== 'boolean') {
        throw new FlowError(CODE, `done 应为 boolean（缺省 = 未跑完），实得 ${JSON.stringify(done)}`, `${path}.done`);
    }
    // 自洽：「跑完」的前提是**先进入过**（`done` 由 `step` 在某个节点上求值发现，位置为空时压根没得跑）
    if (done === true && position === null) {
        throw new FlowError(CODE, 'done = true 却从未进入工作流（position 为 null / 折线为空）—— 「跑完」的前提是先进入', `${path}.done`);
    }
    const state: { position: Id | null; path: readonly Visit<Id>[]; params?: Readonly<Record<string, unknown>>; done?: boolean } = { position, path: visits };
    if (params !== undefined) state.params = params;
    if (done !== undefined) state.done = done;
    return state;
}

/** 非抛出版校验（给 UI / 宿主读盘前的猜测试探用） */
export function isFlowState(value: unknown): value is FlowState {
    try {
        parseFlowState(value);
        return true;
    } catch {
        return false;
    }
}

function stringify(value: unknown, compact = false): string {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

/** 领域状态 → JSON 文本（先校验规范化 ⇒ 键序固定、字段封闭，落盘即稳定文本） */
export function flowStateToJson<Id extends string>(state: FlowState<Id>, options: SerializeOptions = {}): string {
    return stringify(parseFlowState(state, 'flowState'), options.compact);
}

/** JSON 文本 → 领域状态（读回可信：非法 JSON / 非法状态一律抛 `FlowError`） */
export function flowStateFromJson<Id extends string = string>(json: string, options: ParseOptions = {}): FlowState<Id> {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch (e) {
        throw new FlowError('invalid-json', e instanceof Error ? e.message : String(e), 'flowState');
    }
    return parseFlowState<Id>(raw, 'flowState', options);
}
