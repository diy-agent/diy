// resolve.ts — 按当前上下文解析 claim（读取侧的唯一入口）
//
// 五条判定（##404「解析语义」）：命中 → 取特定度最高 → 并列同值取其一 → 并列异值报冲突 → 无命中报悬空。
// **不返回 null**：悬空与冲突都能让库腐坏得很安静，必须显式失败。

import { claimOf } from './claim.js';
import { scopeMatches, scopeSpecificity } from './scope.js';
import { fail, ok, type Env, type Evidence, type Fact, type Lifecycle, type Result, type Scope } from './types.js';

export interface ReadCtx {
    readonly env?: Env;
    readonly paths?: readonly string[];
    readonly task?: string;
    /** 把 `proposed` 也纳入候选（审阅 / 自检用；正常运行不开） */
    readonly includeProposed?: boolean;
}

export interface Resolved {
    readonly claim: string;
    readonly factId: string;
    readonly value: string;
    readonly scope?: Scope;
    readonly lifecycle: Lifecycle;
    /**
     * 被选中那条事实的证据（来源 / 定位 / 验证时间）。
     * 投影要拿 `evidence.verifiedAt` 决定预算裁剪时的保留顺序 ——
     * 只放 `Resolved` 里，**不进投影文本**（证据是给人核的，不是给模型读的）。
     */
    readonly evidence: Evidence;
}

function readable(fact: Fact, includeProposed: boolean): boolean {
    if (fact.lifecycle !== 'active') return false;
    if (fact.review === 'accepted') return true;
    return includeProposed && fact.review === 'proposed';
}

function toScope(ctx: ReadCtx): Scope {
    return {
        ...(ctx.env === undefined ? {} : { env: ctx.env }),
        ...(ctx.paths === undefined ? {} : { paths: ctx.paths }),
        ...(ctx.task === undefined ? {} : { task: ctx.task }),
    };
}

export function resolveClaim(facts: readonly Fact[], claim: string, ctx: ReadCtx = {}): Result<Resolved> {
    const includeProposed = ctx.includeProposed === true;
    const sameClaim = facts.filter((f) => claimOf(f) === claim);

    // claim 在库里不存在 ≠ 库里有但当前 scope 下没值 —— 两者给不同的码，处置不同
    if (sameClaim.length === 0) {
        return fail('facts/claim-unknown', `claim 不存在：${claim}`);
    }

    const active = sameClaim.filter((f) => readable(f, includeProposed));
    if (active.length === 0) {
        return fail(
            'facts/scope-no-match',
            `claim 存在但无可用事实（review/lifecycle 过滤后为空）：${claim}`,
            sameClaim.map((f) => f.id),
        );
    }

    const cs = toScope(ctx);
    const hit = active.filter((f) => scopeMatches(f.scope, cs));
    if (hit.length === 0) {
        return fail(
            'facts/scope-no-match',
            `当前 scope 下无匹配事实：${claim}`,
            active.map((f) => f.id),
        );
    }

    let max = -1;
    for (const f of hit) max = Math.max(max, scopeSpecificity(f.scope));
    const top = hit.filter((f) => scopeSpecificity(f.scope) === max);

    const values = new Set(top.map((f) => f.value));
    if (values.size > 1) {
        return fail(
            'facts/scope-conflict',
            `同一 claim 在同一 scope 下给出 ${values.size} 个不同值：${claim}`,
            top.map((f) => f.id),
        );
    }

    const chosen = top[0];
    if (chosen === undefined) {
        return fail('facts/scope-no-match', `内部不变量被破坏：top 为空：${claim}`);
    }

    return ok({
        claim,
        factId: chosen.id,
        value: chosen.value,
        ...(chosen.scope === undefined ? {} : { scope: chosen.scope }),
        lifecycle: chosen.lifecycle,
        evidence: chosen.evidence,
    });
}

/** 批量解析（一轮里要若干条事实时一次调用，别让 agent 逐个敲） */
export function resolveClaims(
    facts: readonly Fact[],
    claims: readonly string[],
    ctx: ReadCtx = {},
): Result<readonly Resolved[]> {
    const out: Resolved[] = [];
    for (const c of claims) {
        const r = resolveClaim(facts, c, ctx);
        if (!r.ok) return r;
        out.push(r.value);
    }
    return ok(out);
}
