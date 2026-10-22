import { describe, expect, it } from 'vitest';
import { DEFAULT_FULL_BUDGET, bytesOf, checkExpose, exposeOf, weightsOf } from '../src/expose';
import type { Fact } from '../src/types';

const base = { review: 'accepted', lifecycle: 'active', evidence: { source: 'code' } } as const;

function fact(id: string, subject: string, value: string, extra: Partial<Fact> = {}): Fact {
    return { id, subject, aspect: 'a', value, ...base, ...extra } as Fact;
}

describe('bytesOf', () => {
    it('按 UTF-8 字节算（中文 3 字节，String.length 会少算一半）', () => {
        expect(bytesOf('abc')).toBe(3);
        expect(bytesOf('端口')).toBe(6);
        expect(bytesOf('a端')).toBe(4);
        // 预算必须按字节：`rule` 一个主题 9.3 KB 是字节不是字数
        expect(bytesOf('😀')).toBe(4);
    });
});

describe('exposeOf', () => {
    it('没声明的 subject 落 index（不是 full / none）', () => {
        expect(exposeOf({}, 'app.port')).toBe('index');
        expect(exposeOf({ 'app.port': 'full' }, 'app.port')).toBe('full');
        expect(exposeOf({ 'app.port': 'full' }, 'dev.test')).toBe('index');
    });
});

describe('weightsOf', () => {
    it('只算可用事实（superseded / proposed 不占预算）', () => {
        const w = weightsOf([
            fact('a', 'app.port', '18888'),
            fact('b', 'app.port', '0', { lifecycle: 'superseded' }),
            fact('c', 'app.port', 'x', { review: 'proposed' }),
            fact('d', 'dev.test', 'npm test'),
        ]);
        expect(w.find((x) => x.subject === 'app.port')).toEqual({ subject: 'app.port', claims: 1, facts: 1, bytes: 5 });
        expect(w.find((x) => x.subject === 'dev.test')?.bytes).toBe(8);
        // 按字节降序：预算紧时先看见最贵的话题
        expect(w[0]?.subject).toBe('dev.test');
    });
});

describe('checkExpose', () => {
    it('full 字节和 ≤ 预算 ⇒ 零问题', () => {
        expect(checkExpose([fact('a', 'app.port', '18888')], { 'app.port': 'full' }, { budget: 100 })).toEqual([]);
    });

    it('full 字节和 > 预算 ⇒ facts/expose-budget（错误，不是警告）', () => {
        const problems = checkExpose([fact('a', 'app.port', 'x'.repeat(101))], { 'app.port': 'full' }, { budget: 100 });
        expect(problems.map((p) => p.code)).toEqual(['facts/expose-budget']);
        // 讯息要能直接告诉人怎么改：哪个主题占了多少、拆到多细
        expect(problems[0]?.detail).toContain('app.port');
        expect(problems[0]?.detail).toContain('101');
    });

    it('index / none 档不占预算（只有 full 参与）', () => {
        const big = [fact('a', 'rule', 'x'.repeat(9000))];
        expect(checkExpose(big, { rule: 'index' }, { budget: 4000 })).toEqual([]);
        expect(checkExpose(big, { rule: 'none' }, { budget: 4000 })).toEqual([]);
    });

    it('档位非法 ⇒ facts/expose-level（拼错的档位不能悄悄降级）', () => {
        const problems = checkExpose([fact('a', 'app.port', '1')], { 'app.port': 'al' as never }, { budget: 4000 });
        expect(problems.map((p) => p.code)).toEqual(['facts/expose-level']);
    });

    it('缺省预算是 4 KB（与 runtime 投影同一个数）', () => {
        expect(DEFAULT_FULL_BUDGET).toBe(4000);
    });
});
