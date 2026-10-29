// execute.ts — 转移执行器：谁来推、怎么落痕、卡住怎么办
//
// 依据 ##166 §10.3 / §14.3 与 ##101 结论四：
//
//   **可观测 guard（`pred:` / `action:`）** —— 系统求值**并自动转移**。过 → 走 `next` 边；
//   不过 → **有可用 `bounce` 边就打回**，没有就**停在原位**（##101 结论四：「卡住」在**边上**，
//   不在节点上 —— 别把「在等某条件」伪装成节点内的困难）。金融工作流的 `risk` 就是这条：
//   权重不合格 → 系统打回 `select`。
//
//   **不可观测 guard（`prompt:`）** —— 引擎判不了，**只能由 actor 宣布**，**转移本身就是一条 Event**
//   （§10.3：越不可观测越像聊天室）。actor 宣布时仍要把可观测那部分交给系统核一遍
//   （宣布「推进」而 `pred:` 明明不过 = `guard-failed`）；宣布「打回」不主张推进，不设闸门。
//
//   **打回**：不新建节点，只是一次回到目标节点的**位置变更**（##166 §14.2 推论 2 / ##313 的 container）。
//   死循环护栏 = 打回上限（`maxBounces`），超过即 `bounce-limit`。
//
// ── ##333 依赖反转：内核产出**结构化语义**，事件退成审计 ──────────────────────────────
//   `step` / `declare` 的产物是**领域态**（`Transition.state`）+ **结构化语义**（`Transition.move`
//   = `{ kind: 'entry'|'next'|'bounce', from, to }` + `reason`）。内核**不再编人类文本**
//   （旧版的 `进入入口节点「x」` / `系统求值通过（…）→ x` / `打回 x` 全部拆掉）：渲染成什么字
//   是宿主的事（##319 / ##320）。
//   `Event` 也**不再是必产**：`seed.id` 给了才落一条（供 `notify` 与宿主记账），不给就是
//   **纯领域推进**（`transition.event === undefined`）—— 日志是审计/统计材料，可清可丢（##333）。
//   于是 `notify` 只在这条转移**有事件**时才被唤醒（无事件 = 无通知，旁路照旧只记账不作废）。
//
// ── 三条次序铁律（`action:` 是**写外部世界**的槽，次序错了就是对外部世界多动手 / 白动手）──────
//
//   1. **先分类（零副作用），再求值。** `step` 撞上含 `prompt:` 的节点 → 直接 `awaiting-actor`，
//      **一个插件都不调**：否则 `action:` 会在 step 里跑一次、actor 宣布时再跑一次（同一件事做两遍）。
//   2. **先拒单，再求值。** 非法的 `declare`（系统节点 / 冒名 `system` / 边不存在 / 入参形状错 /
//      审计事件形状错）必须在求值**之前**抛错 —— 不能先下了单、再告诉调用方「这次调用不允许」。
//   3. **打回不求值。** 节点 guard 问的是「能不能往前走」；打回不主张推进 → 不问、不跑插件。
//
//   **边上的 `when` 是「边的条件」（§14.4），两侧共用一套语义**：系统选边（`selectEdge`）与 actor
//   宣布（`declare`）都要判它可观测的那一半 —— 同一条边换个方向推也得同一个答案，否则失败形态正是
//   本包最反对的「悄悄偏到另一条路径」。宣布时 `when` 不可观测（`prompt:`）的那半由**宣布者担责**
//   （他宣布走这条边 = 他断言条件成立），与 `guard` 的分水岭一致。
//
//   **组合期交叉校验**（`createRuntime`）：`actor: 'system'` 却带不可观测 guard = **死锁**
//   （系统判不了、actor 又不得宣布）→ 当场 `invalid-def`，不留到运行期静默卡死。
//   另：`pred:` / `action:` / `notify` 的名字组合期就查注册表 ⇒ **装配顺序是「先注册齐、再 createRuntime」**。
//
//   `step` / `declare` 都是**纯函数式的状态机驱动**：给同一个 `state` 再调一次就会再推一次
//   （`id` 由调用方给新值）。故 `action:` 插件**必须幂等**（同一 `ref` 不重复动手），
//   调用方拿到 `done` / `stuck` / `awaiting-actor` 后也不该空转轮询。
//   **例外**：跑完的终态记在领域态里（`FlowState.done`，##333 交付 F）—— 重复 `step` 直接返回
//   `done`，**不再求值、不重跑 `action:`**（##315 review2 §D 的记账）。
//
// 内核**不取时间、不生成 id**：`at` 必填（领域事实，要落盘），`id` 给了才落审计事件。

import { createEvent, nodeAnchor, type Event } from '@diy/talk';
import { advance, parseRef, type AdvanceRequest, type FlowState } from './container.js';
import { findNode, type EdgeDef, type NodeDef, type WorkflowDef } from './define.js';
import { FlowError, type FlowErrorCode } from './errors.js';
import { classifyGuards, evaluateGuards, isObservable, parseGuardRef, selectEdge, unevaluatedGuards, type GuardEvaluation, type GuardRef } from './eval.js';
import { paramsOf, resolveParams } from './params.js';
import { parseReceipt, type PluginContext, type Receipt, type Slot } from './plugins.js';
import type { PluginRegistry } from './registry.js';
import { callPlugin, isIsoString, isObject, rejectUnknown, sameJson } from './validate.js';

/** 去掉 `readonly`（构造请求对象时先摆必填项、再按条件补可选项，比三层三元清楚） */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * 一次转移的入参：**领域输入 + 可选审计**（##333）。
 *
 * - `at`（必填）是**领域事实** —— 本次驻留的时刻，要落盘，所以内核必须拿到（内核不取时间）；
 * - `ref`（可选）是宿主关联标识，落到 `Visit.ref`（内核只透传不解释）；
 * - `id`（可选）是**审计事件 id**：不给 ⇒ **不落事件**（`transition.event === undefined`），
 *   领域照样推进 —— 这就是「日志可清可丢」在 API 上的样子；
 * - `content`（可选）是审计事件正文：**宿主自己渲染**，内核不编人类文本（缺省空串）。
 */
export interface EventSeed {
    readonly id?: string;
    /** ISO-8601 */
    readonly at: string;
    readonly ref?: Readonly<Record<string, string>>;
    readonly content?: string;
}

/** actor 宣布一次转移（不可观测 guard 由宣布者担责，##166 §10.3） */
export interface DeclareRequest<Id extends string = string> extends EventSeed {
    /** 宣布者：agent id / `human`（人是一等参与者）；`system` 是内核保留字，不得冒名 */
    readonly author: string;
    /** 走哪条出边（目标节点）；不存在这条边 → `no-edge`（不许跳步） */
    readonly to: Id;
    /** 宣布语（这条 Event 的正文） */
    readonly content: string;
    readonly causes?: readonly string[];
}

/** 一条通知的失败：转移已落定，通知是旁路 —— 失败只记账，不作废转移 */
export interface NotifyFailure {
    readonly plugin: string;
    readonly error: FlowError;
}

/**
 * 一次转移的**结构化语义**（##333 交付 D）—— 内核给事实，**不给人类文本**。
 *
 * 宿主拿它渲染（UI 文案 / 日志正文 / 审计记录）：`kind = 'entry'` 即「从没进过工作流到进入入口」。
 */
export interface Move<Id extends string = string> {
    readonly kind: 'entry' | 'next' | 'bounce';
    /** 从哪来（`null` = 从「尚未进入」进入入口节点） */
    readonly from: Id | null;
    readonly to: Id;
}

/** 一次成功的转移：新领域态 + 结构化语义 + 可选审计事件 + 用到的 guard 求值 + notify 回执 */
export interface Transition<Id extends string = string> {
    readonly state: FlowState<Id>;
    readonly move: Move<Id>;
    /** 结构化语义的补充：打回 / 未过的原因（`pass` 时为空串） */
    readonly reason: string;
    /** 审计事件：**给了 `seed.id` 才落**（缺省 = 这次转移没有日志，领域态照样前进） */
    readonly event?: Event;
    /** 打回声明时 `evaluated === false`（不设闸门 → 连求值都没做） */
    readonly guard: GuardEvaluation;
    readonly receipts: readonly Receipt[];
    /** 通知失败的插件与原因（**不**影响 `state` / `event` 已落定这一事实） */
    readonly notifyErrors: readonly NotifyFailure[];
}

/** `step` 的结果：走了 / 终态 / 停在原位 / 等 actor 宣布 —— 四种都不是异常，故用判别联合而非抛错 */
export type StepResult<Id extends string = string> =
    | { readonly status: 'moved'; readonly transition: Transition<Id> }
    /** guard 全过且**没有 next 出边**（终态节点）→ 工作流跑完；`state.done` 已置位 */
    | { readonly status: 'done'; readonly state: FlowState<Id> }
    /** guard 未过（或无可用出边）且无法打回 → 停在原位（「卡住」在边上） */
    | { readonly status: 'stuck'; readonly reason: string; readonly guard: GuardEvaluation }
    /** 含不可观测 guard → 系统判不了，等 actor 宣布 */
    | { readonly status: 'awaiting-actor'; readonly pending: readonly GuardRef[] };

/** 当前位置的「现在轮到谁」（只读分类，**不调用插件**，无副作用） */
export interface NodeStatus<Id extends string = string> {
    readonly position: Id | null;
    readonly node: NodeDef<Id> | null;
    /** `entry` = 尚未进入；`system` = 系统自动推；`actor` = 等 actor 宣布 */
    readonly mode: 'system' | 'actor' | 'entry';
    readonly pending: readonly GuardRef[];
    readonly outEdges: readonly EdgeDef<Id>[];
    /** 折线上已有的打回次数 */
    readonly bounces: number;
    /** 工作流是否已跑完（`FlowState.done`；只读事实，不调插件） */
    readonly done: boolean;
}

export interface RuntimeOptions {
    readonly registry: PluginRegistry;
    /**
     * L2 实例值（##316）：形状 `{ 节点 id: { 局部名: 值 } }`，按工作流的参数声明**校验 + 合并缺省**
     * （##315 时只透传；参数层落地后归这里）。工作流没声明任何参数 = 参数层未启用，原样透传。
     *
     * ##333 交付 G：**这份值会随产出的领域态一起走**（写进 `FlowState.params`）—— 状态文件因此自足：
     * 读回时把它交回 `createRuntime`（`params: state.params`）就与原来那次运行**同配置**。
     * 状态里已带参数值时，这里给的必须与它一致（否则 `invalid-param`，见 `requireParamsMatch`）。
     */
    readonly params?: Readonly<Record<string, unknown>>;
    /** 打回上限（死循环护栏）；缺省不限 —— 具体数值属 L2 参数，内核不预设行业策略 */
    readonly maxBounces?: number;
    /** 每次转移后要唤醒的 `notify` 插件名（##166 §13.2 第五槽）；**只在这次转移落了事件时才唤醒** */
    readonly notify?: readonly string[];
}

export interface Runtime<Id extends string = string> {
    readonly def: WorkflowDef<Id>;
    readonly registry: PluginRegistry;
    /**
     * 本次运行用的 L2 实例值（##316：已校验 + 已合并缺省；工作流没声明参数时是宿主透传袋）。
     * ##333 交付 G：它会被写进产出的 `FlowState.params` —— 状态文件里那份才是**一等真源**。
     */
    readonly params: Readonly<Record<string, unknown>>;
    readonly maxBounces: number;
    /** 系统自动推：可观测 guard 全过 → 前进；不过 → 打回（有可用 bounce 边）或停在原位 */
    step(state: FlowState<Id>, seed: EventSeed): StepResult<Id>;
    /** actor 宣布转移：不可观测 guard 由宣布者担责，可观测部分仍由系统核（宣布推进时） */
    declare(state: FlowState<Id>, request: DeclareRequest<Id>): Transition<Id>;
    /** 当前位置的分类（供调度 / UI 判断「现在轮到谁」） */
    status(state: FlowState<Id>): NodeStatus<Id>;
}

/**
 * 边的条件（`when`）在 **actor 宣布**这一侧也要算数（`step` 侧的选边由 `selectEdge` 负责）。
 *
 * `when` 是**边的条件**（##166 §14.4「何时走这条边」），不是「系统选边的消歧技巧」—— 同一条边，
 * 换个人推也得同一个答案；只在系统侧判，失败形态正是本包最反对的「悄悄偏到另一条路径」。
 *
 * 分水岭与 `guard` 一致：`pred:` / `action:` 可观测 → 系统当场核（不过即 `edge-unavailable`，
 * 与系统侧的 `stuck` 对齐）；`prompt:` 不可观测 → 由**宣布者担责**（他宣布走这条边 = 他断言条件成立）。
 */
function requireEdgeAvailable<Id extends string>(def: WorkflowDef<Id>, edge: EdgeDef<Id>, ctx: PluginContext, registry: PluginRegistry): void {
    if (edge.when === undefined || edge.when === '') return;
    const path = `edges[${def.edges.indexOf(edge)}].when`;
    const ref = parseGuardRef(edge.when, path);
    if (!isObservable(ref)) return; // 不可观测 → 宣布者担责，系统判不了
    if (evaluateGuards([edge.when], ctx, registry).pass) return;
    throw new FlowError('edge-unavailable', `这条边的 \`when\`（${edge.when}）此刻不成立：${JSON.stringify(edge.from)} → ${JSON.stringify(edge.to)} 此刻不可用`, path);
}

const SEED_KEYS = ['id', 'at', 'ref', 'content'] as const;
const DECLARE_KEYS = ['id', 'at', 'ref', 'content', 'author', 'to', 'causes'] as const;
const OPTION_KEYS = ['registry', 'params', 'maxBounces', 'notify'] as const;

/** 内核保留的 `author`：「系统自动求值，无人发言」（§14.3 靠它区分「系统推」与「谁宣布推」） */
const SYSTEM_AUTHOR = 'system';

const NO_GUARD: GuardEvaluation = Object.freeze({
    mode: 'system',
    evaluated: true,
    pass: true,
    checks: Object.freeze([]) as readonly never[],
    pending: Object.freeze([]) as readonly never[],
    reason: '',
});

/** 解析后的入参：领域部分（`at` / `ref`）+ 审计部分（`id` / `content`） */
interface ParsedSeed {
    readonly at: string;
    readonly ref?: Readonly<Record<string, string>>;
    readonly id?: string;
    readonly content: string;
}

/**
 * 校验并拆分 `EventSeed`（形状封闭）。
 *
 * 领域部分（`at` / `ref`）与审计部分（`id` / `content`）**都在求值之前**校验完 —— 先拒单后求值
 * （审计字段形状错也不许「先对外部世界动手、再报错」）。
 */
function parseSeed(seed: unknown, keys: readonly string[], path: string, code: FlowErrorCode): ParsedSeed {
    if (!isObject(seed)) throw new FlowError(code, '入参应为对象', path);
    rejectUnknown(seed, keys, path, code);
    if (!isIsoString(seed.at)) {
        throw new FlowError(code, `at 应为 ISO-8601 时刻（如 2026-10-13T00:00:00.000Z），实得 ${JSON.stringify(seed.at)}`, `${path}.at`);
    }
    const ref = parseRef(seed.ref, `${path}.ref`, code);
    if (seed.id !== undefined && (typeof seed.id !== 'string' || seed.id === '')) {
        throw new FlowError(code, `id 应为非空字符串（审计事件 id；不给 = 不落事件），实得 ${JSON.stringify(seed.id)}`, `${path}.id`);
    }
    if (seed.content !== undefined && typeof seed.content !== 'string') {
        throw new FlowError(code, 'content 应为字符串（审计事件正文）', `${path}.content`);
    }
    const parsed: { at: string; ref?: Readonly<Record<string, string>>; id?: string; content: string } = {
        at: seed.at,
        content: typeof seed.content === 'string' ? seed.content : '',
    };
    if (ref !== undefined) parsed.ref = ref;
    if (typeof seed.id === 'string') parsed.id = seed.id;
    return parsed;
}

export function createRuntime<Id extends string = string>(def: WorkflowDef<Id>, options: RuntimeOptions): Runtime<Id> {
    if (!isObject(options)) {
        throw new FlowError('invalid-option', 'options 应为对象（{ registry, params?, maxBounces?, notify? }）', 'options');
    }
    rejectUnknown(options as unknown as Record<string, unknown>, OPTION_KEYS, 'options', 'invalid-option');

    const { registry } = options;
    if (!isObject(registry) || typeof registry.resolve !== 'function' || typeof registry.has !== 'function') {
        throw new FlowError('invalid-option', 'options.registry 必填（插件注册表：createRegistry()）', 'options.registry');
    }
    const maxBounces = options.maxBounces ?? Number.POSITIVE_INFINITY;
    if (typeof maxBounces !== 'number' || Number.isNaN(maxBounces) || maxBounces < 0) {
        throw new FlowError('invalid-option', `maxBounces 应为非负数字（实得 ${JSON.stringify(options.maxBounces)}）`, 'options.maxBounces');
    }
    const notifiers = options.notify ?? [];
    if (!Array.isArray(notifiers) || notifiers.some((name) => typeof name !== 'string')) {
        throw new FlowError('invalid-option', 'notify 应为插件名（字符串）数组', 'options.notify');
    }
    // 参数层（##316）：唯一注入点。声明了参数 ⇒ 校验 + 合并缺省（非法值在这里就大声报，
    // 不留到插件里读到 `undefined` 静默偏路）；没声明 ⇒ 参数层未启用，保持 ##315 的透传口径
    // （形状封闭的前提是「形状已声明」—— 引擎不越权判定自己不认识的键）。
    //
    // ⚠️ 冻结深度的**已知差异**（##316 review1 H-1，本包只记录、不改口径）：声明了参数 ⇒ `resolveParams`
    // 逐项校验并**深冻结**（标量 / 已冻结的 list，没有可变内层）；没声明 ⇒ 只 `Object.freeze({...袋})`
    // 冻**顶层**，内层对象仍是宿主那份、可被插件改。为什么不在透传袋上深冻结 / 深拷贝：
    // 引擎**不知道**袋里是什么（可能是类实例 / 回调 / 宿主自己的活对象）—— 原地深冻结会改到**宿主自己的
    // 对象**（`Object.freeze` 是原地操作），深拷贝则破坏「原样透传」本身。要动它就得先替宿主定「袋里只准
    // 放纯 JSON」，那是 ##316 的口径变更，不归本任务。故：**声明了才受管，没声明就照旧透传**。
    const declared = paramsOf(def);
    const params: Readonly<Record<string, unknown>> =
        declared.schema.length === 0 ? Object.freeze({ ...options.params }) : resolveParams(declared, options.params);
    const hasParams = Object.keys(params).length > 0;

    /**
     * 参数值属**领域状态**（##311 §二 L3 / ##333 交付 G）：本次运行用的那份写进产出的状态。
     *
     * ⚠️ **正路是 `advance` 自己承载**（`AdvanceRequest.params`，##333 review2 P1）—— `commit` 走的是那条路。
     * 这里只服务**不经过 `advance` 的两条 `done` 返回**（`{ ...state, done: true }` 是原地加标记，不是一次
     * 位置变更），让「凡从 runtime 出来的 `state` 一律带本次运行的参数值（有参数时）」这条不变量处处成立。
     */
    const stampParams = (state: FlowState<Id>): FlowState<Id> => (hasParams ? { ...state, params } : state);

    /**
     * 状态里的参数值与本次 `createRuntime` 拿到的那份必须**一致**（键序无关）—— 两个方向都算不一致：
     *
     * - **状态带着另一份值** ⇒ 「读回来的状态」与「现在这份参数」是两次不同的运行配置，静默按谁跑都会
     *   悄悄偏（正是本包最反对的失败形态）；
     * - **状态压根没记值，而本次运行有**（`state.params === undefined` 且本次有参数值）⇒ 这份状态**丢了
     *   自己的运行配置** —— 同样不许静默按「本次这份」跑。**唯一例外是尚未进入**（`position === null`）：
     *   那时还没有「这次运行的配置」可丢，`initialState()` 本来就不带 `params`（全新一次运行的正路）。
     *
     * 这不是「缺省」而是「丢了」：`FlowState.params` 缺省的语义是「工作流没声明参数、宿主也没给袋」，
     * 而这里是「声明了、也给了，只是这份状态里没记」—— 两者后果天差地别，故必须分开。
     * 修法写在消息里（交出原状态文件 / 当作另起一次运行）。
     */
    const requireParamsMatch = (state: FlowState<Id>): void => {
        if (state.params === undefined) {
            if (state.position === null || !hasParams) return;
            throw new FlowError(
                'invalid-param',
                `这份状态里没有参数值，而本次运行有（\`position = ${JSON.stringify(state.position)}\` 已进入工作流）：它丢了自己的运行配置。修法：把原运行那份状态（连同它的 \`params\`）交回 —— 状态文件是一等真源；或当作**另起一次运行**（用 \`initialState()\` 从头进入）`,
                'state.params',
            );
        }
        if (sameJson(state.params, params)) return;
        throw new FlowError(
            'invalid-param',
            '状态里带着另一份 L2 参数值（状态文件是一等真源）：把 `state.params` 交回 createRuntime —— `createRuntime(def, { registry, params: state.params })`；已进入工作流的状态**不允许**清掉 `params` 再跑（那等于换了一次运行配置）',
            'state.params',
        );
    };

    const nodeAt = (id: Id): NodeDef<Id> => {
        const node = findNode(def, id);
        if (!node) throw new FlowError('unknown-node', `工作流里没有节点 ${JSON.stringify(id)}`, 'position');
        return node;
    };
    const outEdges = (from: Id): EdgeDef<Id>[] => def.edges.filter((edge) => edge.from === from);
    const contextOf = (node: NodeDef<Id>, actor: string): PluginContext => ({ workflow: def, node, params, actor });

    // ── 组合期静态扫描：`pred:` / `action:` / `notify` 的名字**静态可枚举** ────────────────────
    // 打错一个字（`pred:ci_grenn`）若只在「走到那一步」才暴露，本次没走到的路径就永远藏着这个错。
    // 组合期零成本（不调插件，只查注册表）⇒ 在这里当场报。
    const requirePlugin = (slot: Slot, name: string, path: string): void => {
        if (registry.has(slot, name)) return;
        const known = registry.names(slot).join(', ');
        throw new FlowError('unknown-plugin', `工作流引用了未注册的插件 ${slot}:${name}（该槽已注册：${known === '' ? '（无）' : known}）`, path);
    };
    const slotOf = (prefix: string): Slot | null => (prefix === 'pred' ? 'guard' : prefix === 'action' ? 'action' : null);

    def.nodes.forEach((node, ni) => {
        node.guard.forEach((raw, gi) => {
            const ref = parseGuardRef(raw, `nodes[${ni}].guard[${gi}]`);
            const slot = slotOf(ref.prefix);
            if (slot) requirePlugin(slot, ref.name, `nodes[${ni}].guard[${gi}]`);
        });
        // 定义矛盾：系统节点却要等一个不可观测的 guard ⇒ **谁也推不动**（`step` 说「等 actor」，
        // `declare` 说「系统节点不得宣布」）。这类矛盾必须在组合期大声报，不留到运行期静默卡死。
        const { pending } = classifyGuards(node.guard, `nodes[${ni}].guard`);
        if (node.actor === 'system' && pending.length > 0) {
            throw new FlowError(
                'invalid-def',
                `节点 ${JSON.stringify(node.id)} 的 actor = system，却带不可观测 guard（${pending.map((ref) => ref.raw).join(', ')}）：系统判不了、actor 又不得宣布 ⇒ 谁也推不动（死锁）`,
                `nodes[${ni}]`,
            );
        }
    });
    def.edges.forEach((edge, ei) => {
        if (edge.when === undefined || edge.when === '') return;
        const ref = parseGuardRef(edge.when, `edges[${ei}].when`);
        const slot = slotOf(ref.prefix);
        if (slot) requirePlugin(slot, ref.name, `edges[${ei}].when`);
    });
    notifiers.forEach((name, i) => requirePlugin('notify', name, `notify[${i}]`));

    /** 通知是**旁路**：失败只记账（`notifyErrors`），绝不把已经落定的转移作废 */
    const fireNotify = (event: Event): { receipts: Receipt[]; notifyErrors: NotifyFailure[] } => {
        const receipts: Receipt[] = [];
        const notifyErrors: NotifyFailure[] = [];
        for (const name of notifiers) {
            try {
                const raw = callPlugin(`notify 插件 ${name}`, `notify:${name}`, () => registry.resolve('notify', name)(event));
                receipts.push(parseReceipt(raw, `notify:${name}`));
            } catch (e) {
                notifyErrors.push({ plugin: name, error: e instanceof FlowError ? e : new FlowError('plugin-threw', String(e), `notify:${name}`, e) });
            }
        }
        return { receipts, notifyErrors };
    };

    /**
     * 落定一次**领域推进**（`advance` + 打回护栏）—— **不动外部世界**；通知在 `landed` 里补。
     *
     * 本次运行的参数值**随请求交给 `advance`**（##333 review2 P1）：这样产出态是**完整真源**
     * （`position` / `path` / `params` 一次成型），不必在 `advance` 之外再补一刀。
     */
    const commit = (state: FlowState<Id>, to: Id, seed: ParsedSeed): FlowState<Id> => {
        const request: Mutable<AdvanceRequest<Id>> = { to, at: seed.at };
        if (seed.ref !== undefined) request.ref = seed.ref;
        if (hasParams) request.params = params;
        const next = advance(def, state, request).state;
        const last = next.path[next.path.length - 1];
        if (last.kind === 'bounce') {
            const used = next.path.filter((visit) => visit.kind === 'bounce').length;
            if (used > maxBounces) {
                throw new FlowError('bounce-limit', `打回已达 ${used} 次，超过上限 ${maxBounces}（死循环护栏）`, 'state.path');
            }
        }
        return next;
    };

    /** 审计事件（纯构造，**无副作用**）：`seed.id` 缺省 ⇒ 这次转移不落日志（##333） */
    const audit = (seed: ParsedSeed, to: Id, author: string, causes?: readonly string[]): Event | undefined =>
        seed.id === undefined
            ? undefined
            : createEvent({ id: seed.id, author, anchor: nodeAnchor(to), content: seed.content, causes: causes ?? [], at: seed.at });

    const landed = (state: FlowState<Id>, move: Move<Id>, guard: GuardEvaluation, event: Event | undefined): Transition<Id> => {
        const { receipts, notifyErrors } = event === undefined ? { receipts: [] as Receipt[], notifyErrors: [] as NotifyFailure[] } : fireNotify(event);
        return event === undefined
            ? { state, move, reason: guard.reason, guard, receipts, notifyErrors }
            : { state, move, reason: guard.reason, event, guard, receipts, notifyErrors };
    };

    function step(state: FlowState<Id>, seed: EventSeed): StepResult<Id> {
        const parsed = parseSeed(seed, SEED_KEYS, 'seed', 'invalid-option');
        requireParamsMatch(state);

        // 终态（##333 交付 F）：已跑完 ⇒ 直接返回 —— **不求值、不重跑 `action:`**
        // （「已经跑完」是领域事实，记在 `FlowState.done` 里，不是日志事实）
        if (state.done === true) return { status: 'done', state: stampParams(state) };

        if (state.position === null) {
            const event = audit(parsed, def.entry, SYSTEM_AUTHOR);
            const move: Move<Id> = { kind: 'entry', from: null, to: def.entry };
            return { status: 'moved', transition: landed(commit(state, def.entry, parsed), move, NO_GUARD, event) };
        }

        const node = nodeAt(state.position);
        const ctx = contextOf(node, SYSTEM_AUTHOR);

        // ① 先**零副作用**分类：含 `prompt:` → 系统一步都不动手（连可观测那半也不求值）
        const classification = classifyGuards(node.guard);
        if (classification.mode === 'actor') return { status: 'awaiting-actor', pending: classification.pending };

        // ② 求值**只此一次**（`action:` 可能写外部世界）
        const guard = evaluateGuards(node.guard, ctx, registry);
        const edges = outEdges(state.position);

        if (guard.pass) {
            const edge = selectEdge(edges, 'next', ctx, registry);
            if (!edge) {
                // 终态判据是**结构事实**：压根没有 `next` 出边 ⇒ 跑完了（**边上的 `when` 不参与判定** ——
                // `when` 是「这条边此刻能不能走」，不是「工作流有没有下一步」）。故：
                //   有 `next` 出边但 `when` 全不成立 ⇒ 停在**边上**（`stuck`，这一步不走）；
                //   只有 `bounce` 出边的节点 guard 全过 ⇒ `done`（没有下一步可走）。
                // 这条 `done` 不经过 `advance`（原地加标记），故由 `stampParams` 补上本次运行的参数值：
                // 「凡从 runtime 出来的 state 一律带本次运行的参数值（有参数时）」是可断言的不变量
                // （`moved` 那条路已由 `commit` 随 `AdvanceRequest.params` 承载，见 ##333 review2 P1）。
                if (!edges.some((candidate) => candidate.kind === 'next')) {
                    return { status: 'done', state: stampParams({ ...state, done: true }) };
                }
                return { status: 'stuck', reason: '没有可用的 next 出边（边上 `when` 未过）', guard };
            }
            const event = audit(parsed, edge.to, SYSTEM_AUTHOR);
            const move: Move<Id> = { kind: 'next', from: state.position, to: edge.to };
            return { status: 'moved', transition: landed(commit(state, edge.to, parsed), move, guard, event) };
        }

        const bounced = selectEdge(edges, 'bounce', ctx, registry);
        if (!bounced) {
            // 区分「压根没有打回边」（那就是停在原位）与「有打回边、只是它此刻的 `when` 不成立」
            const hasBounce = edges.some((candidate) => candidate.kind === 'bounce');
            return {
                status: 'stuck',
                reason: hasBounce ? `${guard.reason}（且打回边此刻不可用：边上 \`when\` 未过）` : guard.reason,
                guard,
            };
        }
        const event = audit(parsed, bounced.to, SYSTEM_AUTHOR);
        const move: Move<Id> = { kind: 'bounce', from: state.position, to: bounced.to };
        return { status: 'moved', transition: landed(commit(state, bounced.to, parsed), move, guard, event) };
    }

    function declare(state: FlowState<Id>, request: DeclareRequest<Id>): Transition<Id> {
        const parsed = parseSeed(request, DECLARE_KEYS, 'request', 'invalid-declare');
        requireParamsMatch(state);

        if (state.position === null) {
            throw new FlowError('invalid-entry', '尚未进入工作流：先用 step 进入入口节点', 'state.position');
        }
        if (typeof request.author !== 'string' || request.author === '') {
            throw new FlowError('invalid-declare', 'author 必填（宣布者：agent id / human）', 'request.author');
        }
        if (request.author === SYSTEM_AUTHOR) {
            throw new FlowError('invalid-declare', `author = ${JSON.stringify(SYSTEM_AUTHOR)} 是内核保留字（「系统自动求值，无人发言」的标记）—— actor 不得冒名`, 'request.author');
        }
        if (typeof request.content !== 'string') {
            throw new FlowError('invalid-declare', 'content 应为字符串（这条 Event 的正文）', 'request.content');
        }

        const node = nodeAt(state.position);
        const edge = outEdges(state.position).find((candidate) => candidate.to === request.to);
        if (!edge) {
            throw new FlowError('no-edge', `不存在从 ${JSON.stringify(state.position)} 到 ${JSON.stringify(request.to)} 的边（不许跳步）`, 'request.to');
        }

        // ② 闸门**先判、后求值**：非法宣布必须在「对外部世界动手」之前被拒
        if (node.actor === 'system') {
            throw new FlowError('not-declarable', `节点 ${JSON.stringify(state.position)} 的 actor = system（系统节点只能由系统推）—— actor 不得宣布`, 'request.to');
        }
        const classification = classifyGuards(node.guard);
        if (classification.mode === 'system') {
            throw new FlowError('not-declarable', `节点 ${JSON.stringify(state.position)} 的 guard 全可观测（${node.guard.join(', ')}），只能由系统推 —— actor 不得宣布`, 'request.to');
        }

        // 审计事件**先构造**（纯函数）：`id` / `content` / `causes` 形状错也必须在求值前暴露
        const event = audit(parsed, edge.to, request.author, request.causes);

        // ③ 打回不主张推进 → 不设闸门，**连求值也不做**（`action:` 不该因为「有人往后退」而动手；
        //    边上的 `when` 同此 —— 打回不主张推进，凭什么去判「走这条边的条件」）
        const ctx = contextOf(node, request.author);
        let guard: GuardEvaluation;
        if (edge.kind === 'bounce') {
            guard = unevaluatedGuards(node.guard);
        } else {
            // ④ 走 `next` 边：**边的条件**（`when`）先判，再判节点 guard（两道闸门都在求值前拒）
            requireEdgeAvailable(def, edge, ctx, registry);
            guard = evaluateGuards(node.guard, ctx, registry);
            if (!guard.pass) {
                throw new FlowError('guard-failed', `宣布推进，但可观测 guard 未过：${guard.reason}`, 'request.to');
            }
        }

        const move: Move<Id> = { kind: edge.kind, from: state.position, to: edge.to };
        return landed(commit(state, edge.to, parsed), move, guard, event);
    }

    function status(state: FlowState<Id>): NodeStatus<Id> {
        const bounces = state.path.filter((visit) => visit.kind === 'bounce').length;
        const done = state.done === true;
        if (state.position === null) {
            return { position: null, node: null, mode: 'entry', pending: [], outEdges: [], bounces, done };
        }
        const node = nodeAt(state.position);
        const refs = node.guard.map((raw, i) => parseGuardRef(raw, `guard[${i}]`));
        const pending = refs.filter((ref) => !isObservable(ref));
        return {
            position: state.position,
            node,
            mode: pending.length > 0 ? 'actor' : 'system',
            pending,
            outEdges: outEdges(state.position),
            bounces,
            done,
        };
    }

    return { def, registry, params, maxBounces, step, declare, status };
}
