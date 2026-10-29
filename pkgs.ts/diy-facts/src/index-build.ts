// index-build.ts — 索引与结构问题（**全部由程序生成**，agent 只提议，##404 §「索引由程序生成」）
//
// 生成物四件：claim 表 · 反查表 · 结构问题 · 冲突清单。
// 「影响面」= 给定本轮触达的文件，反查哪些事实需要复核（`affected`）。

import { claimOf } from './claim.js';
import { pathCovers, scopeKey } from './scope.js';
import type { Fact, FactsErrorCode } from './types.js';

export interface Issue {
    readonly code: FactsErrorCode;
    readonly detail: string;
    readonly facts?: readonly string[];
}

export interface Conflict {
    readonly claim: string;
    readonly scopeKey: string;
    readonly values: readonly string[];
    readonly facts: readonly string[];
}

export interface FactsIndex {
    readonly byId: ReadonlyMap<string, Fact>;
    /** claim → fact id（同 claim 多个 scope 变体都在这里） */
    readonly claims: ReadonlyMap<string, readonly string[]>;
    /** 目标（claim 或 fact id）→ 引用它的 fact id */
    readonly backlinks: ReadonlyMap<string, readonly string[]>;
    readonly issues: readonly Issue[];
    readonly conflicts: readonly Conflict[];
}

function push<K>(m: Map<K, string[]>, k: K, v: string): void {
    const cur = m.get(k);
    if (cur === undefined) m.set(k, [v]);
    else cur.push(v);
}

/** 只判「结构合法」；事实真伪由证据与验证过程保证（图不打这个包票） */
export function buildIndex(facts: readonly Fact[]): FactsIndex {
    const byId = new Map<string, Fact>();
    const claims = new Map<string, string[]>();
    const backlinks = new Map<string, string[]>();
    const issues: Issue[] = [];

    for (const f of facts) {
        if (byId.has(f.id)) {
            issues.push({
                code: 'facts/id-duplicate',
                detail: `fact id 重复：${f.id}`,
                facts: [f.id],
            });
            continue;
        }
        byId.set(f.id, f);
        push(claims, claimOf(f), f.id);
    }

    // 同 claim + 同 scope：值不同 = 冲突；值相同 = 冗余（两条都得消掉一条）
    const conflicts: Conflict[] = [];
    for (const [claim, ids] of claims) {
        const buckets = new Map<string, Fact[]>();
        for (const id of ids) {
            const f = byId.get(id);
            if (f === undefined) continue;
            const k = scopeKey(f.scope);
            const cur = buckets.get(k);
            if (cur === undefined) buckets.set(k, [f]);
            else cur.push(f);
        }
        for (const [sk, group] of buckets) {
            if (group.length < 2) continue;
            // 只有「都可参与检索」的才判冲突/冗余：被替代（superseded）与
            // 已过期（expired）的留档本来就是同 claim 同 scope，不是问题
            const live = group.filter((f) => f.review === 'accepted' && f.lifecycle === 'active');
            if (live.length < 2) continue;
            const values = [...new Set(live.map((f) => f.value))];
            const liveIds = live.map((f) => f.id);
            if (values.length > 1) {
                conflicts.push({ claim, scopeKey: sk, values, facts: liveIds });
            } else {
                issues.push({
                    code: 'facts/scope-duplicate',
                    detail: `同 claim 同 scope 的冗余事实：${claim} @ ${sk === '' ? '(全局)' : sk}`,
                    facts: liveIds,
                });
            }
        }
    }

    // 引用完整性
    for (const f of facts) {
        for (const ref of f.refs ?? []) {
            if (ref.rel === 'depends-on') {
                const target = ref.data.toClaim;
                if (!claims.has(target)) {
                    issues.push({
                        code: 'facts/dangling-ref',
                        detail: `depends-on 指向不存在的 claim：${target}`,
                        facts: [f.id],
                    });
                }
                push(backlinks, target, f.id);
            } else if (ref.rel === 'supersedes') {
                const target = ref.data.toFactId;
                if (target === f.id) {
                    issues.push({
                        code: 'facts/dangling-ref',
                        detail: `supersedes 自指：${f.id}`,
                        facts: [f.id],
                    });
                } else if (!byId.has(target)) {
                    issues.push({
                        code: 'facts/dangling-ref',
                        detail: `supersedes 指向不存在的 fact：${target}`,
                        facts: [f.id],
                    });
                }
                push(backlinks, target, f.id);
            } else {
                const unknown: never = ref;
                issues.push({
                    code: 'facts/rel-unknown',
                    detail: `未知关系：${JSON.stringify(unknown)}`,
                    facts: [f.id],
                });
            }
        }
    }

    issues.push(...findSupersedeCycles(facts));

    return { byId, claims, backlinks, issues, conflicts };
}

/** supersedes 不得成环：A 替代 B、B 又替代 A ⇒ 「谁有效」永远算不出来 */
function findSupersedeCycles(facts: readonly Fact[]): Issue[] {
    const next = new Map<string, string[]>();
    for (const f of facts) {
        for (const ref of f.refs ?? []) {
            if (ref.rel !== 'supersedes') continue;
            push(next, f.id, ref.data.toFactId);
        }
    }
    const state = new Map<string, 'visiting' | 'done'>();
    const issues: Issue[] = [];

    const walk = (id: string, path: readonly string[]): void => {
        const cur = state.get(id);
        if (cur === 'done') return;
        if (cur === 'visiting') {
            issues.push({
                code: 'facts/supersede-cycle',
                detail: `supersedes 成环：${[...path, id].join(' → ')}`,
                facts: [...new Set([...path, id])],
            });
            return;
        }
        state.set(id, 'visiting');
        for (const n of next.get(id) ?? []) walk(n, [...path, id]);
        state.set(id, 'done');
    };

    for (const id of next.keys()) walk(id, []);
    return issues;
}

/** 影响面：本轮触达这些文件 → 哪些事实可能已过期（复核清单，不是结论） */
export function affected(index: FactsIndex, files: readonly string[]): readonly string[] {
    const out: string[] = [];
    for (const [id, f] of index.byId) {
        const ps = f.scope?.paths ?? [];
        if (ps.length === 0) continue;
        if (ps.some((p) => files.some((file) => pathCovers(p, file)))) out.push(id);
    }
    return out;
}

/** 给定 id，返回它引用的事实链（1 跳，够 agent 用；多跳遍历按需再加） */
export function refsOf(index: FactsIndex, factId: string): readonly string[] {
    const refs = index.backlinks.get(factId) ?? [];
    return refs;
}
