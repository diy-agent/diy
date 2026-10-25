import { describe, expect, it } from 'vitest';
import { resolveClaim, resolveClaims } from '../src/resolve';
import type { Fact } from '../src/types';
import { realFacts } from './fixtures/real';

const base = {
    review: 'accepted',
    lifecycle: 'active',
    evidence: { source: 'code' },
} as const;

function fact(id: string, value: string, extra: Partial<Fact> = {}): Fact {
    return { id, subject: 's', aspect: 'a', value, ...base, ...extra } as Fact;
}

describe('resolveClaim：按当前上下文挑变体', () => {
    it('同一 claim 不同 env 解析出不同值（真样例）', () => {
        const prod = resolveClaim(realFacts, 'app.port#default', { env: 'production' });
        const test = resolveClaim(realFacts, 'app.port#default', { env: 'test' });
        expect(prod.ok && prod.value.value).toBe('18888');
        expect(test.ok && test.value.value).toBe('0');
    });

    it('ctx 未声明 env 时 env-scoped 事实不命中（显式失败，不返回 null）', () => {
        const r = resolveClaim(realFacts, 'app.port#default', {});
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('facts/scope-no-match');
    });

    it('claim 不存在与「存在但当前 scope 无值」给不同的码', () => {
        const unknown = resolveClaim(realFacts, 'nope#nope', { env: 'test' });
        expect(!unknown.ok && unknown.code).toBe('facts/claim-unknown');
    });

    it('被替代的旧事实不参与解析（lifecycle=superseded）', () => {
        const r = resolveClaim(realFacts, 'model.default#缺省模型', { env: 'production' });
        expect(r.ok && r.value.factId).toBe('model.default.v2');
    });

    it('特定度更高者胜出：带 scope 的覆盖全局的', () => {
        const facts = [fact('g', 'global'), fact('s1', 'scoped', { scope: { env: 'test' } })];
        const r = resolveClaim(facts, 's#a', { env: 'test' });
        expect(r.ok && r.value.value).toBe('scoped');
    });

    it('同特定度并列且值不同 = 冲突（不随机挑一条）', () => {
        const facts = [fact('a', '3000', { scope: { env: 'test' } }), fact('b', '4000', { scope: { env: 'test' } })];
        const r = resolveClaim(facts, 's#a', { env: 'test' });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.code).toBe('facts/scope-conflict');
            expect(r.facts).toEqual(['a', 'b']);
        }
    });

    it('proposed 默认不可读，includeProposed 时才可见', () => {
        const facts = [fact('p', 'maybe', { review: 'proposed' })];
        expect(resolveClaim(facts, 's#a').ok).toBe(false);
        const withProposed = resolveClaim(facts, 's#a', { includeProposed: true });
        expect(withProposed.ok && withProposed.value.value).toBe('maybe');
    });

    it('批量解析遇错即返回该错误', () => {
        const r = resolveClaims(realFacts, ['app.port#default', 'nope#x'], { env: 'test' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('facts/claim-unknown');
    });
});
