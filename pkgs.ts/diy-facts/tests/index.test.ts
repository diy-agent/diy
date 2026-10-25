import { describe, expect, it } from 'vitest';
import { affected, buildIndex } from '../src/index-build';
import { validateFacts } from '../src/validate';
import type { Fact } from '../src/types';
import { realFacts } from './fixtures/real';

const base = { review: 'accepted', lifecycle: 'active', evidence: { source: 'code' } } as const;

function fact(id: string, extra: Partial<Fact> = {}): Fact {
    return { id, subject: 's', aspect: 'a', value: id, ...base, ...extra } as Fact;
}

describe('buildIndex：真实样例的结构检查', () => {
    it('真样例零 issue、零冲突（不然就是判据把自己绊倒）', () => {
        const idx = buildIndex(realFacts);
        expect(idx.issues).toEqual([]);
        expect(idx.conflicts).toEqual([]);
    });

    it('claim 表聚合同 claim 的多个环境变体', () => {
        const idx = buildIndex(realFacts);
        expect(idx.claims.get('app.port#default')).toEqual(['port.production', 'port.dev-test']);
    });

    it('反查表能回答「谁依赖了 app.port#default」', () => {
        const idx = buildIndex(realFacts);
        expect(idx.backlinks.get('app.port#default')).toEqual(['env.port', 'serve.port']);
    });

    it('影响面：触达的测试文件反查出相关纪律', () => {
        const idx = buildIndex(realFacts);
        expect(affected(idx, ['pkgs.ts/diy-app/tests/cli.intent.x.test.ts'])).toEqual(['rule.test-bail']);
        expect(affected(idx, ['pkgs.ts/diy-app/src/main/index.ts'])).toEqual([]);
    });
});

describe('buildIndex：病灶检测', () => {
    it('同 claim 同 scope 异值 = 冲突', () => {
        const idx = buildIndex([fact('a', { value: '1' }), fact('b', { value: '2' })]);
        expect(idx.conflicts).toHaveLength(1);
        expect(idx.conflicts[0]?.facts).toEqual(['a', 'b']);
    });

    it('同 claim 同 scope 同值 = 冗余（报 scope-duplicate，不进冲突）', () => {
        const idx = buildIndex([fact('a', { value: '1' }), fact('b', { value: '1' })]);
        expect(idx.conflicts).toEqual([]);
        expect(idx.issues.map((i) => i.code)).toContain('facts/scope-duplicate');
    });

    it('depends-on 指向不存在的 claim = 悬空', () => {
        const idx = buildIndex([fact('a', { refs: [{ rel: 'depends-on', data: { toClaim: 'x#y' } }] })]);
        expect(idx.issues.map((i) => i.code)).toContain('facts/dangling-ref');
    });

    it('supersedes 成环被拦下（A↔B）', () => {
        const idx = buildIndex([
            fact('a', { refs: [{ rel: 'supersedes', data: { toFactId: 'b' } }] }),
            fact('b', { refs: [{ rel: 'supersedes', data: { toFactId: 'a' } }] }),
        ]);
        expect(idx.issues.map((i) => i.code)).toContain('facts/supersede-cycle');
    });

    it('id 重复被拦下（审计锚点必须唯一）', () => {
        const idx = buildIndex([fact('a'), fact('a')]);
        expect(idx.issues.map((i) => i.code)).toContain('facts/id-duplicate');
    });
});

describe('validateFacts：一次报全部问题', () => {
    it('真样例通过校验', () => {
        const { facts, issues } = validateFacts(realFacts as unknown);
        expect(issues).toEqual([]);
        expect(facts).toHaveLength(realFacts.length);
    });

    it('缺 evidence / 未知字段 / 错 env 值一次全报出来', () => {
        const { issues } = validateFacts([
            { id: 'a', subject: 's', aspect: 'a', value: 'v', review: 'accepted', lifecycle: 'active' },
            {
                id: 'b',
                subject: 's',
                aspect: 'a',
                value: 'v',
                review: 'accepted',
                lifecycle: 'active',
                evidence: { source: 'code' },
                verifedAt: 'typo',
            },
            {
                id: 'c',
                subject: 's',
                aspect: 'a',
                value: 'v',
                review: 'accepted',
                lifecycle: 'active',
                evidence: { source: 'code' },
                scope: { env: 'lab' },
            },
        ]);
        expect(issues.length).toBeGreaterThanOrEqual(3);
        expect(issues.some((i) => i.detail.includes('evidence'))).toBe(true);
        expect(issues.some((i) => i.detail.includes('未知字段'))).toBe(true);
        expect(issues.some((i) => i.detail.includes('scope.env'))).toBe(true);
    });

    it('subject / aspect 含 # 被拒（claim 分隔符冲突）', () => {
        const { issues } = validateFacts([
            {
                id: 'a',
                subject: 's#x',
                aspect: 'a',
                value: 'v',
                review: 'accepted',
                lifecycle: 'active',
                evidence: { source: 'code' },
            },
        ]);
        expect(issues.some((i) => i.detail.includes('#'))).toBe(true);
    });
});
