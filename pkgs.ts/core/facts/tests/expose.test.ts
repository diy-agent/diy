import { describe, expect, it } from 'vitest';
import { DEFAULT_FULL_BUDGET, bytesOf, checkExpose, checkExposeLeveled, defaultExposeOf, exposeOf, weightsOf } from '../src/expose';
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

describe('defaultExposeOf', () => {
    it('任务库缺省 full（本任务结论最该常驻），项目/设备库缺省 index', () => {
        expect(defaultExposeOf('task')).toBe('full');
        expect(defaultExposeOf('project')).toBe('index');
        expect(defaultExposeOf('global')).toBe('index');
        // 不认识的类型退保守档（不抢预算）
        expect(defaultExposeOf('whatever')).toBe('index');
    });
});

describe('checkExposeLeveled', () => {
    it('按**逐条**档位算预算：同一 subject 在两库可不同档', () => {
        // 这正是「按库解析」的最小证据：合表就表达不出这个
        const facts = [fact('a', 'rule', 'x'.repeat(60)), fact('b', 'rule', 'y'.repeat(60))];
        const items = [
            { fact: facts[0]!, level: 'full' as const },
            { fact: facts[1]!, level: 'index' as const },
        ];
        expect(checkExposeLeveled(items, { budget: 100 })).toEqual([]);
        const both = items.map((i) => ({ ...i, level: 'full' as const }));
        expect(checkExposeLeveled(both, { budget: 100 }).map((p) => p.code)).toEqual(['facts/expose-budget']);
    });

    it('不可用（superseded / proposed）的事实不占预算', () => {
        const items = [{ fact: { ...fact('a', 'rule', 'x'.repeat(500)), lifecycle: 'superseded' as const }, level: 'full' as const }];
        expect(checkExposeLeveled(items, { budget: 100 })).toEqual([]);
    });
});
