// eval.ts — guard 求值：数组 = **与**（全部满足才可转移）
//
// 依据 ##166 §10.3 / §14.4 与用户 2026-10-13 修订（`guard` 放宽为数组，与语义）：
//   分水岭是「**guard 可不可观测**」，不是「系统类型」（§10.3）：
//     `pred:名`   → 引擎自己能判（读外部世界的「过没过」）      → **系统求值、自动转移**
//     `action:名` → 同上，且求值本身就可能**写外部世界**        → **系统求值、自动转移**
//     `prompt:名` → 只是一段提示词，没人能验证                  → **只能由 actor 宣布**（转移 = 一条发言）
//   所以同一条泳道图里，CI 节点是流水线、开发/Review 节点是聊天室 —— 不是选一个，是同一种容器的两端。
//
// 三条硬规则：
//   1. **与**：数组每一项都要过（空数组 = 恒真，即「无需判据即可离开」）；
//   2. **短路**：遇到第一个失败即停 —— `action:` 有副作用（下单 / 发布），不能在已知前项失败后仍执行它；
//   3. **不降级**：`pred:` / `action:` 名字没注册 → 抛 `unknown-plugin`（绝不当成「不通过」糊过去，
//      否则打错一个字母就会静默把工作流推成另一条路径，见 registry.ts 头注）。

import type { EdgeDef, EdgeKind } from './define';
import { FlowError } from './errors';
import { parseActionResult, parseGuardResult, type PluginContext } from './plugins';
import type { PluginRegistry } from './registry';
import { callPlugin } from './validate';

/** guard 引用的三种前缀 —— `prompt:` 之外都可观测 */
export const GUARD_PREFIXES = ['prompt', 'pred', 'action'] as const;
export type GuardPrefix = (typeof GUARD_PREFIXES)[number];

/** 一条解析后的 guard 引用：`pred:ci_green` → `{ prefix: 'pred', name: 'ci_green' }` */
export interface GuardRef {
    readonly raw: string;
    readonly prefix: GuardPrefix;
    readonly name: string;
}

/** 解析 `前缀:名字`；缺前缀 / 未知前缀 / 缺名字一律抛 `invalid-guard`（带点路径） */
export function parseGuardRef(raw: string, path = 'guard'): GuardRef {
    const at = raw.indexOf(':');
    if (at <= 0) {
        throw new FlowError('invalid-guard', `guard 引用 ${JSON.stringify(raw)} 缺少前缀（形状：${GUARD_PREFIXES.map((p) => `${p}:`).join(' / ')}名字）`, path);
    }
    const prefix = raw.slice(0, at);
    if (!(GUARD_PREFIXES as readonly string[]).includes(prefix)) {
        throw new FlowError('invalid-guard', `guard 引用 ${JSON.stringify(raw)} 的前缀未知（合法：${GUARD_PREFIXES.join(' | ')}）`, path);
    }
    const name = raw.slice(at + 1);
    if (name === '') throw new FlowError('invalid-guard', `guard 引用 ${JSON.stringify(raw)} 缺少名字`, path);
    return { raw, prefix: prefix as GuardPrefix, name };
}

/** 可观测 = 引擎自己能判（`pred:` / `action:`）；`prompt:` 不可观测 → 只能 actor 宣布 */
export function isObservable(ref: GuardRef): boolean {
    return ref.prefix !== 'prompt';
}

/** 谁来推这条转移：`system` = 全可观测（引擎自决）；`actor` = 含不可观测项（只能等 actor 宣布） */
export type GuardMode = 'system' | 'actor';

/** 一条可观测 guard 的求值结果 */
export interface GuardCheck {
    readonly ref: GuardRef;
    readonly pass: boolean;
    /** `pass === false` 时的原因 */
    readonly reason: string;
}

export interface GuardEvaluation {
    readonly mode: GuardMode;
    /** 是否**真的跑过插件**：`false` = 一个插件都没调（打回声明不设闸门 → 连「能不能往前走」都不问） */
    readonly evaluated: boolean;
    /** 已求值的可观测 guard 是否**全过**（短路：首个失败即停，之后的不求值） */
    readonly pass: boolean;
    /** 已求值的可观测 guard（按数组序；短路时少于全部） */
    readonly checks: readonly GuardCheck[];
    /** 未求值的不可观测 guard（`mode === 'actor'` 时非空） */
    readonly pending: readonly GuardRef[];
    /** `pass === false` 时的原因 */
    readonly reason: string;
}

/** 静态分类：**不调用任何插件**（免副作用），只按前缀分出「谁可观测」（给 `status` 这类只读查询用） */
export function classifyGuards(refs: readonly string[], base = 'guard'): { mode: GuardMode; refs: readonly GuardRef[]; pending: readonly GuardRef[] } {
    const parsed = refs.map((raw, i) => parseGuardRef(raw, `${base}[${i}]`));
    const pending = parsed.filter((ref) => !isObservable(ref));
    return { mode: pending.length > 0 ? 'actor' : 'system', refs: parsed, pending };
}

/**
 * 「不评估」的求值结果：`evaluated = false`、`checks` 空、`pass` 恒真（**没有闸门**）。
 *
 * 用于**打回声明**：宣布打回不主张推进，节点 guard 问的是「能不能往前走」，打回根本不问它 ——
 * 所以一个插件都不跑（`action:` 是写外部世界的，绝不能因为「有人往后退」而动手）。
 */
export function unevaluatedGuards(refs: readonly string[], base = 'guard'): GuardEvaluation {
    const { mode, pending } = classifyGuards(refs, base);
    return { mode, evaluated: false, pass: true, checks: [], pending, reason: '' };
}

function runGuard(ref: GuardRef, ctx: PluginContext, registry: PluginRegistry, path: string): GuardCheck {
    if (ref.prefix === 'pred') {
        const result = parseGuardResult(callPlugin(`guard 插件 ${ref.name}`, path, () => registry.resolve('guard', ref.name)(ctx)), path);
        return { ref, pass: result.pass, reason: result.pass ? '' : (result.reason ?? `guard 「${ref.name}」未过`) };
    }
    // `action:` —— 求值即「对外部世界动手」，`ok` 就是过没过（##166 §14.4：`impl` 把 pred/action 注册成真函数）
    const result = parseActionResult(callPlugin(`action 插件 ${ref.name}`, path, () => registry.resolve('action', ref.name)(ctx)), path);
    const why = result.ref === undefined ? `action 「${ref.name}」未成功` : `action 「${ref.name}」未成功（${result.ref}）`;
    return { ref, pass: result.ok, reason: result.ok ? '' : why };
}

/**
 * 求值一组 guard（与语义 + 短路）。
 *
 * - 全是 `pred:` / `action:` → `mode = 'system'`，`pass` 即总判据（全部满足才可转移）；
 * - 含 `prompt:` → `mode = 'actor'`，引擎判不了，`pending` 列出未求值的不可观测项（由 actor 担责）。
 */
export function evaluateGuards(refs: readonly string[], ctx: PluginContext, registry: PluginRegistry): GuardEvaluation {
    const parsed = refs.map((raw, i) => parseGuardRef(raw, `guard[${i}]`));
    const pending = parsed.filter((ref) => !isObservable(ref));

    const checks: GuardCheck[] = [];
    let failed: GuardCheck | null = null;
    for (let i = 0; i < parsed.length; i += 1) {
        const ref = parsed[i];
        if (!isObservable(ref)) continue;
        if (failed) break; // 短路：已知不通过，不再执行后面的（尤其 `action:` 的副作用）
        const check = runGuard(ref, ctx, registry, `guard[${i}]`);
        checks.push(check);
        if (!check.pass) failed = check;
    }

    return {
        mode: pending.length > 0 ? 'actor' : 'system',
        evaluated: true,
        pass: failed === null,
        checks,
        pending,
        reason: failed === null ? '' : failed.reason,
    };
}

/**
 * 从同种边里选出**唯一**一条可用出边；`null` = 一条都不满足（边在、但此刻走不了）。
 *
 * `when` 是**边的条件**（##166 §14.4「何时走这条边」），与 `guard` 同一套前缀规则 ——
 * **单出口也照判**：边上写了 `when: 'pred:never'`，那就是「此刻不走这条边」，
 * 不能因为它是唯一一条就当成恒真（那正是本包最反对的「悄悄偏到另一条路径」）。
 * - `when` 缺省 = 恒真；`when` 不可观测（`prompt:`）= 系统选不了 → 不算命中（只能由 actor 宣布）；
 * - 命中数 > 1 → `ambiguous-edge`（宁可报错，也不替作者掷骰子）；命中数 = 0 → `null`。
 */
export function selectEdge<Id extends string>(edges: readonly EdgeDef<Id>[], kind: EdgeKind, ctx: PluginContext, registry: PluginRegistry): EdgeDef<Id> | null {
    const candidates = edges.filter((edge) => edge.kind === kind);
    const matched = candidates.filter((edge) => {
        if (edge.when === undefined) return true;
        const index = edges.indexOf(edge);
        const ref = parseGuardRef(edge.when, `edges[${index}].when`);
        if (!isObservable(ref)) return false;
        return evaluateGuards([edge.when], ctx, registry).pass;
    });
    if (matched.length > 1) {
        throw new FlowError('ambiguous-edge', `当前节点有 ${candidates.length} 条 kind=${kind} 的边，when 命中 ${matched.length} 条（须恰 1 条）`, 'edges');
    }
    return matched.length === 1 ? matched[0] : null;
}
