// claim.ts — claim = `subject#aspect`，纯派生
//
// 为什么 claim 可以派生而 fact id 不行（##404）：
//   claim 只是**查询键** —— 重算无副作用，改名只影响检索不破坏审计；
//   fact id 是**审计锚点** —— `supersedes.to` 指向它、证据与版本挂在它上。

import { scopeKey } from './scope.js';
import type { Fact } from './types';

/** claim 分隔符：`#` 不出现在 subject / aspect 里（校验器保证） */
export const CLAIM_SEP = '#';

export function claimOf(fact: Pick<Fact, 'subject' | 'aspect'>): string {
    return `${fact.subject}${CLAIM_SEP}${fact.aspect}`;
}

export function parseClaim(claim: string): { subject: string; aspect: string } | null {
    const at = claim.indexOf(CLAIM_SEP);
    if (at <= 0 || at === claim.length - 1) return null;
    return { subject: claim.slice(0, at), aspect: claim.slice(at + 1) };
}

/**
 * fact id 的派生值。**含 scope** —— 同一 claim 的不同变体必须能区分开
 * （否则两条只有 scope 不同的事实在 `buildIndex` 里会撞成 `facts/id-duplicate`）。
 * 显式 id 只在该锚点需要跨改名稳定时才写。
 */
export function derivedFactId(f: Pick<Fact, 'subject' | 'aspect' | 'scope'>): string {
    const claim = claimOf(f);
    const k = scopeKey(f.scope);
    return k === '' ? claim : `${claim}@${k}`;
}
