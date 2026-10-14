// execute.ts — 转移执行器：谁来推、怎么落痕、卡住怎么办
//
// 依据 ##166 §10.3 / §14.3 与 ##101 结论四：
//
//   **可观测 guard（`pred:` / `action:`）** —— 系统求值**并自动转移**，落一条 `author = system`
//   的 Event（「系统自动求值，无人发言」）。过 → 走 `next` 边；不过 → **有 `bounce` 边就打回**，
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
// 内核**不取时间、不生成 id**：`EventSeed { id, at }` 由调用方给（同 ##313 的 `apply`）。

import { createEvent, nodeAnchor, type Event } from '@diy/talk';
import { apply, type FlowState } from './container';
import { findNode, type EdgeDef, type NodeDef, type WorkflowDef } from './define';
import { FlowError } from './errors';
import { evaluateGuards, isObservable, parseGuardRef, selectEdge, type GuardEvaluation, type GuardMode, type GuardRef } from './eval';
import { parseReceipt, type PluginContext, type Receipt } from './plugins';
import type { PluginRegistry } from './registry';

/** 新事件的种子：`id` 唯一性由调用方保证、`at` 由调用方给（内核不取时间、不生成 id） */
export interface EventSeed {
    readonly id: string;
    /** ISO-8601 */
    readonly at: string;
}

/** actor 宣布一次转移（不可观测 guard 由宣布者担责，##166 §10.3） */
export interface DeclareRequest<Id extends string = string> extends EventSeed {
    /** 宣布者：agent id / `human`（人是一等参与者） */
    readonly author: string;
    /** 走哪条出边（目标节点）；不存在这条边 → `no-edge`（不许跳步） */
    readonly to: Id;
    /** 宣布语（这条 Event 的正文） */
    readonly content: string;
    readonly causes?: readonly string[];
}

/** 一次成功的转移：新态 + 落下的那条 Event + 用到的 guard 求值 + notify 回执 */
export interface Transition<Id extends string = string> {
    readonly state: FlowState<Id>;
    readonly event: Event;
    readonly guard: GuardEvaluation;
    readonly receipts: readonly Receipt[];
}

/** `step` 的结果：走了 / 终态 / 停在原位 / 等 actor 宣布 —— 四种都不是异常，故用判别联合而非抛错 */
export type StepResult<Id extends string = string> =
    | { readonly status: 'moved'; readonly transition: Transition<Id> }
    /** guard 全过且**没有 next 出边**（终态节点）→ 工作流跑完 */
    | { readonly status: 'done' }
    /** guard 未过且没有 bounce 边 → 停在原位（「卡住」在边上） */
    | { readonly status: 'stuck'; readonly reason: string; readonly guard: GuardEvaluation }
    /** 含不可观测 guard → 系统判不了，等 actor 宣布 */
    | { readonly status: 'awaiting-actor'; readonly pending: readonly GuardRef[] };

/** 当前位置的「现在轮到谁」（只读分类，**不调用插件**，无副作用） */
export interface NodeStatus<Id extends string = string> {
    readonly position: Id | null;
    readonly node: NodeDef<Id> | null;
    /** `entry` = 尚未进入；`system` = 系统自动推；`actor` = 等 actor 宣布 */
    readonly mode: GuardMode | 'entry';
    readonly pending: readonly GuardRef[];
    readonly outEdges: readonly EdgeDef<Id>[];
    /** 折线上已有的打回次数 */
    readonly bounces: number;
}

export interface RuntimeOptions {
    readonly registry: PluginRegistry;
    /** L2 实例参数（##316 注入；本任务只透传） */
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
    /** 系统自动推：可观测 guard 全过 → 前进；不过 → 打回（有 bounce 边）或停在原位 */
    step(state: FlowState<Id>, seed: EventSeed): StepResult<Id>;
    /** actor 宣布转移：不可观测 guard 由宣布者担责，可观测部分仍由系统核（宣布推进时） */
    declare(state: FlowState<Id>, request: DeclareRequest<Id>): Transition<Id>;
    /** 当前位置的分类（供调度 / UI 判断「现在轮到谁」） */
    status(state: FlowState<Id>): NodeStatus<Id>;
}

const NO_GUARD: GuardEvaluation = { mode: 'system', pass: true, checks: [], pending: [], reason: '' };

function describeChecks(guard: GuardEvaluation): string {
    return guard.checks.map((check) => `${check.ref.raw} ✓`).join(', ');
}

export function createRuntime<Id extends string = string>(def: WorkflowDef<Id>, options: RuntimeOptions): Runtime<Id> {
    const { registry } = options;
    const params = options.params ?? {};
    const maxBounces = options.maxBounces ?? Number.POSITIVE_INFINITY;
    const notifiers = options.notify ?? [];

    const nodeAt = (id: Id): NodeDef<Id> => {
        const node = findNode(def, id);
        if (!node) throw new FlowError('unknown-node', `工作流里没有节点 ${JSON.stringify(id)}`, 'position');
        return node;
    };
    const outEdges = (from: Id): EdgeDef<Id>[] => def.edges.filter((edge) => edge.from === from);
    const contextOf = (node: NodeDef<Id>, actor: string): PluginContext => ({ workflow: def, node, params, actor });

    const fireNotify = (event: Event): Receipt[] =>
        notifiers.map((name) => parseReceipt(registry.resolve('notify', name)(event), `notify:${name}`));

    const commit = (state: FlowState<Id>, event: Event, guard: GuardEvaluation): Transition<Id> => {
        const next = apply(def, state, event);
        const last = next.path[next.path.length - 1];
        if (last.kind === 'bounce') {
            const used = next.path.filter((visit) => visit.kind === 'bounce').length;
            if (used > maxBounces) {
                throw new FlowError('bounce-limit', `打回已达 ${used} 次，超过上限 ${maxBounces}（死循环护栏）`, 'state.path');
            }
        }
        return { state: next, event, guard, receipts: fireNotify(event) };
    };

    function step(state: FlowState<Id>, seed: EventSeed): StepResult<Id> {
        if (state.position === null) {
            const entry = nodeAt(def.entry);
            const event = createEvent({
                id: seed.id,
                author: 'system',
                anchor: nodeAnchor(def.entry),
                content: `进入入口节点「${entry.name}」`,
                at: seed.at,
            });
            return { status: 'moved', transition: commit(state, event, NO_GUARD) };
        }

        const node = nodeAt(state.position);
        const ctx = contextOf(node, 'system');
        const guard = evaluateGuards(node.guard, ctx, registry);
        if (guard.mode === 'actor') return { status: 'awaiting-actor', pending: guard.pending };

        const edges = outEdges(state.position);
        if (guard.pass) {
            if (!edges.some((edge) => edge.kind === 'next')) return { status: 'done' };
            const edge = selectEdge(edges, 'next', ctx, registry);
            const event = createEvent({
                id: seed.id,
                author: 'system',
                anchor: nodeAnchor(edge.to),
                content: `系统求值通过（${describeChecks(guard)}）→ ${edge.to}`,
                at: seed.at,
            });
            return { status: 'moved', transition: commit(state, event, guard) };
        }

        if (!edges.some((edge) => edge.kind === 'bounce')) return { status: 'stuck', reason: guard.reason, guard };
        const edge = selectEdge(edges, 'bounce', ctx, registry);
        const event = createEvent({
            id: seed.id,
            author: 'system',
            anchor: nodeAnchor(edge.to),
            content: `系统求值未过（${guard.reason}）→ 打回 ${edge.to}`,
            at: seed.at,
        });
        return { status: 'moved', transition: commit(state, event, guard) };
    }

    function declare(state: FlowState<Id>, request: DeclareRequest<Id>): Transition<Id> {
        if (state.position === null) {
            throw new FlowError('invalid-entry', '尚未进入工作流：先用 step 进入入口节点', 'state.position');
        }
        const node = nodeAt(state.position);
        const edge = outEdges(state.position).find((candidate) => candidate.to === request.to);
        if (!edge) {
            throw new FlowError('no-edge', `不存在从 ${JSON.stringify(state.position)} 到 ${JSON.stringify(request.to)} 的边（不许跳步）`, 'request.to');
        }

        const guard = evaluateGuards(node.guard, contextOf(node, request.author), registry);
        if (guard.mode === 'system') {
            throw new FlowError('not-declarable', `节点 ${JSON.stringify(state.position)} 的 guard 全可观测（${node.guard.join(', ')}），只能由系统推 —— actor 不得宣布`, 'request.to');
        }
        // 宣布「推进」要把可观测那部分交给系统核一遍；宣布「打回」不主张推进，不设闸门
        if (edge.kind === 'next' && !guard.pass) {
            throw new FlowError('guard-failed', `宣布推进，但可观测 guard 未过：${guard.reason}`, 'request.to');
        }

        const event = createEvent({
            id: request.id,
            author: request.author,
            anchor: nodeAnchor(edge.to),
            content: request.content,
            causes: request.causes ?? [],
            at: request.at,
        });
        return commit(state, event, guard);
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
