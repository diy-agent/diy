// tests/kb-index.test.ts — 索引折叠的判据（##5 第 9 轮：索引成了新的固定前缀成本）
import { describe, expect, it } from 'vitest';
import { foldKbIndex, KB_FOLD_MIN_GROUP, type KbSubjectEntry } from '../src/index';

function e(subject: string, claims = 1, ns: ('project' | 'global')[] = ['project']): KbSubjectEntry {
    return { subject, desc: `${subject} 的说明`, claims, ns };
}

describe('foldKbIndex', () => {
    it('同前缀 ≥ minGroup 折成一条，claims 求和、ns 取并集', () => {
        const out = foldKbIndex([
            e('app.find', 32),
            e('app.rule', 23, ['project', 'global']),
            e('app.history', 18),
            e('tool', 22),
        ]);
        expect(out.map((x) => x.subject)).toEqual(['app.*', 'tool']);
        const app = out[0] as KbSubjectEntry;
        expect(app.claims).toBe(73);
        expect(app.ns).toEqual(['project', 'global']);
        // 折叠项必须自带展开方法，否则「省了字节、断了去路」
        expect(app.desc).toContain('diy facts brief app.*');
        expect(app.desc).toContain('3 个主题');
    });

    it('不足 minGroup 不折（折了反而多一层跳转）', () => {
        const out = foldKbIndex([e('app.find'), e('app.rule'), e('tool')]);
        expect(out.map((x) => x.subject)).toEqual(['app.find', 'app.rule', 'tool']);
    });

    it('裸前缀主题并入同前缀折叠组（`dev` 与 `dev.*` 不能两行并存 —— 读起来像两个主题）', () => {
        const out = foldKbIndex([e('dev', 4), e('dev.context', 7), e('dev.check', 2), e('dev.lab', 1)]);
        expect(out.map((x) => x.subject)).toEqual(['dev.*']);
        expect(out[0]?.claims).toBe(14);
        expect(out[0]?.desc).toContain('含 `dev` 本体');
        expect(out[0]?.desc).toContain('4 个主题');
    });

    it('裸前缀存在但不够 minGroup ⇒ 不并（不为了消除歧义硬折）', () => {
        const out = foldKbIndex([e('dev'), e('dev.context')]);
        expect(out.map((x) => x.subject)).toEqual(['dev', 'dev.context']);
    });

    it('无前缀主题不受影响，结果按主题名排序', () => {
        const out = foldKbIndex([e('tool'), e('ns.a'), e('ns.b'), e('ns.c'), e('rule.lang')]);
        expect(out.map((x) => x.subject)).toEqual(['ns.*', 'rule.lang', 'tool']);
    });

    it('minGroup 可调；缺省是 3', () => {
        expect(KB_FOLD_MIN_GROUP).toBe(3);
        const entries = [e('a.x'), e('a.y')];
        expect(foldKbIndex(entries).map((x) => x.subject)).toEqual(['a.x', 'a.y']);
        expect(foldKbIndex(entries, { minGroup: 2 }).map((x) => x.subject)).toEqual(['a.*']);
    });
});
