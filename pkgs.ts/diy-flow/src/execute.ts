// execute.ts — 转移执行器：谁来推、怎么落痕、卡住怎么办
//
// 依据 ##166 §10.3 / §14.3 与 ##101 结论四：
//
//   **可观测 guard（`pred:` / `action:`）** —— 系统求值**并自动转移**，落一条 `author = system`
//   的 Event（「系统自动求值，无人发言」）。过 → 走 `next` 边；不过 → **有可用 `bounce` 边就打回**，
//   没有就**停在原位**（##101 结论四：「卡住」在**边上**，不在节点上 —— 别把「在等某条件」伪装成
//   节点内的困难）。金融工作流的 `risk` 就是这条：权重不合格 → 系统打回 `select`。
//
//   **不可观测 guard（`prompt:`）** —— 引擎判不了，**只能由 actor 宣布**，**转移本身就是一条 Event**
//   （§10.3：越不可观测越像聊天室）。actor 宣布时仍要把可观测那部分交给系统核一遍
//   （宣布「推进」而 `pred:` 明明不过 = `guard-failed`）；宣布「打回」不主张推进，不设闸门。
//
//   **打回**：不新建节点，只是一条锚在目标节点的 Event（##166 §14.2 推论 2 / ##313 的 container）。
//   死循环护栏 = 打回上限（`maxBounces`），超过即 `bounce-limit`。
//
// ── 三条次序铁律（`action:` 是**写外部世界**的槽，次序错了就是对外部世界多动手 / 白动手）──────
//
//   1. **先分类（零副作用），再求值。** `step` 撞上含 `prompt:` 的节点 → 直接 `awaiting-actor`，
//      **一个插件都不调**：否则 `action:` 会在 step 里跑一次、actor 宣布时再跑一次（同一件事做两遍）。
//   2. **先拒单，再求值。** 非法的 `declare`（系统节点 / 冒名 `system` / 边不存在）必须在求值**之前**
//      抛错 —— 不能先下了单、再告诉调用方「这次调用不允许」。
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
//   （`seed` 由调用方给新 id）。故 `action:` 插件**必须幂等**（同一 `ref` 不重复动手），
//   调用方拿到 `done` / `stuck` / `awaiting-actor` 后也不该空转轮询。
//
// 内核**不取时间、不生成 id**：`EventSeed { id, at }` 由调用方给（同 ##313 的 `apply`）。

import { createEvent, nodeAnchor, type Event } from '@diy/talk';
import { apply, type FlowState } from './container';
import { findNode, type EdgeDef, type NodeDef, type WorkflowDef } from './define';
import { FlowError } from './errors';
import { classifyGuards, evaluateGuards, isObservable, parseGuardRef, selectEdge, unevaluatedGuards, type GuardEvaluation, type GuardRef } from './eval';
import { parseReceipt, type PluginContext, type Receipt, type Slot } from './plugins';
import type { PluginRegistry } from './registry';
import { callPlugin, isObject, rejectUnknown } from './validate';

/** 新事件的种子：`id` 唯一性由调用方保证、`at` 由调用方给（内核不取时间、不生成 id） */
export interface EventSeed {
    readonly id: string;
    /** ISO-8601 */
    readonly at: string;
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

/** 一次成功的转移：新态 + 落下的那条 Event + 用到的 guard 求值 + notify 回执 */
export interface Transition<Id extends string = string> {
    readonly state: FlowState<Id>;
    readonly event: Event;
    /** 打回声明时 `evaluated === false`（不设闸门 → 连求值都没做） */
    readonly guard: GuardEvaluation;
    readonly receipts: readonly Receipt[];
    /** 通知失败的插件与原因（**不**影响 `state` / `event` 已落定这一事实） */
    readonly notifyErrors: readonly NotifyFailure[];
}

/** `step` 的结果：走了 / 终态 / 停在原位 / 等 actor 宣布 —— 四种都不是异常，故用判别联合而非抛错 */
export type StepResult<Id extends string = string> =
    | { readonly status: 'moved'; readonly transition: Transition<Id> }
    /** guard 全过且**没有 next 出边**（终态节点）→ 工作流跑完 */
    | { readonly status: 'done' }
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
}

export interface RuntimeOptions {
    readonly registry: PluginRegistry;
    /** L2 实例参数（##316 注入；本任务只透传 —— 冻结一份副本交给插件，宿主对象不被改） */
    readonly params?: Readonly<Record<string, unknown>>;
    /** 打回上限（死循环护栏）；缺省不限 —— 具体数值属 L2 参数，内核不预设行业策略 */
    readonly maxBounces?: number;
    /** 每次转移后要唤醒的 `notify` 插件名（##166 §13.2 第五槽） */
    readonly notify?: readonly string[];
}

export interface Runtime<Id extends string = string> {
    readonly def: WorkflowDef<Id>;
    readonly registry: PluginRegistry;
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

const SEED_KEYS = ['id', 'at'] as const;
const DECLARE_KEYS = ['id', 'at', 'author', 'to', 'content', 'causes'] as const;
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

function describeChecks(guard: GuardEvaluation): string {
    return guard.checks.map((check) => `${check.ref.raw} ✓`).join(', ');
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
    const params = Object.freeze({ ...options.params });

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

    /** 落定一条事实（`apply` + 打回护栏）—— **不动外部世界**；通知在 `landed` 里补 */
    const commit = (state: FlowState<Id>, event: Event): FlowState<Id> => {
        const next = apply(def, state, event);
        const last = next.path[next.path.length - 1];
        if (last.kind === 'bounce') {
            const used = next.path.filter((visit) => visit.kind === 'bounce').length;
            if (used > maxBounces) {
                throw new FlowError('bounce-limit', `打回已达 ${used} 次，超过上限 ${maxBounces}（死循环护栏）`, 'state.path');
            }
        }
        return next;
    };

    const landed = (state: FlowState<Id>, event: Event, guard: GuardEvaluation): Transition<Id> => {
        const { receipts, notifyErrors } = fireNotify(event);
        return { state, event, guard, receipts, notifyErrors };
    };

    function step(state: FlowState<Id>, seed: EventSeed): StepResult<Id> {
        rejectUnknown(seed as unknown as Record<string, unknown>, SEED_KEYS, 'seed', 'invalid-option');

        if (state.position === null) {
            const entry = nodeAt(def.entry);
            const event = createEvent({
                id: seed.id,
                author: SYSTEM_AUTHOR,
                anchor: nodeAnchor(def.entry),
                content: `进入入口节点「${entry.name}」`,
                at: seed.at,
            });
            return { status: 'moved', transition: landed(commit(state, event), event, NO_GUARD) };
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
                // 压根没有 next 出边 = 终态；有边但 `when` 不满足 = 停在边上（这一步不走）
                if (!edges.some((candidate) => candidate.kind === 'next')) return { status: 'done' };
                return { status: 'stuck', reason: '没有可用的 next 出边（边上 `when` 未过）', guard };
            }
            const event = createEvent({
                id: seed.id,
                author: SYSTEM_AUTHOR,
                anchor: nodeAnchor(edge.to),
                content: `系统求值通过（${describeChecks(guard)}）→ ${edge.to}`,
                at: seed.at,
            });
            return { status: 'moved', transition: landed(commit(state, event), event, guard) };
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
        const event = createEvent({
            id: seed.id,
            author: SYSTEM_AUTHOR,
            anchor: nodeAnchor(bounced.to),
            content: `系统求值未过（${guard.reason}）→ 打回 ${bounced.to}`,
            at: seed.at,
        });
        return { status: 'moved', transition: landed(commit(state, event), event, guard) };
    }

    function declare(state: FlowState<Id>, request: DeclareRequest<Id>): Transition<Id> {
        rejectUnknown(request as unknown as Record<string, unknown>, DECLARE_KEYS, 'request', 'invalid-declare');

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

        const event = createEvent({
            id: request.id,
            author: request.author,
            anchor: nodeAnchor(edge.to),
            content: request.content,
            causes: request.causes ?? [],
            at: request.at,
        });
        return landed(commit(state, event), event, guard);
    }

    function status(state: FlowState<Id>): NodeStatus<Id> {
        const bounces = state.path.filter((visit) => visit.kind === 'bounce').length;
        if (state.position === null) {
            return { position: null, node: null, mode: 'entry', pending: [], outEdges: [], bounces };
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
        };
    }

    return { def, registry, params, maxBounces, step, declare, status };
}
