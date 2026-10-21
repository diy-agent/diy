import { describe, expect, it } from 'vitest';
import { project, projectItems, type ProjectEntry } from '../src/node/project';
import type { Fact } from '../src/types';

function f(p: {
    id: string;
    subject: string;
    aspect?: string;
    value: string;
    env?: 'production' | 'development' | 'test';
    review?: 'proposed' | 'accepted' | 'rejected';
    lifecycle?: 'active' | 'superseded' | 'expired';
}): Fact {
    return {
        id: p.id,
        subject: p.subject,
        aspect: p.aspect ?? 'default',
        value: p.value,
        ...(p.env === undefined ? {} : { scope: { env: p.env } }),
        review: p.review ?? 'accepted',
        lifecycle: p.lifecycle ?? 'active',
        evidence: { source: 'code' },
    };
}

const PROD = f({ id: 'port.production', subject: 'app.port', value: '18888', env: 'production' });
const DEV = f({ id: 'port.dev', subject: 'app.port', value: '0', env: 'development' });
const FALLBACK = f({ id: 'model.fallback', subject: 'model.default', aspect: 'fallback', value: 'mimo-v2.5' });

const TASK = { kind: 'task', taskUri: 'projects/4/tasks/404' } as const;

function entries(): ProjectEntry[] {
    return [
        { ns: TASK, fact: f({ id: 't.check', subject: 'dev.check', aspect: 'entry', value: './sha.sh check' }) },
        { ns: { kind: 'project' }, fact: PROD },
        { ns: { kind: 'project' }, fact: DEV },
        { ns: { kind: 'global' }, fact: FALLBACK },
    ];
}

describe('projectItems', () => {
    it('同 claim 多变体按 ctx 解析成一条，并带上依据与变体数', () => {
        const { items } = projectItems({ entries: entries(), ctx: { env: 'production' } });
        const port = items.find((i) => i.claim === 'app.port#default');
        expect(port).toMatchObject({ value: '18888', resolvedBy: 'env=production', variants: 2 });
    });

    it('换环境取到另一个值（证明变体解析真在跑，不是抄第一条）', () => {
        const { items } = projectItems({ entries: entries(), ctx: { env: 'development' } });
        expect(items.find((i) => i.claim === 'app.port#default')?.value).toBe('0');
    });

    it('排序：任务 > 项目 > 全局', () => {
        const { items } = projectItems({ entries: entries(), ctx: { env: 'production' } });
        expect(items.map((i) => i.ns.kind)).toEqual(['task', 'project', 'global']);
    });

    it('冲突 / 悬空不静默：进 problems', () => {
        const dup = [
            { ns: { kind: 'project' } as const, fact: PROD },
            { ns: { kind: 'project' } as const, fact: f({ id: 'port.production2', subject: 'app.port', value: '1234', env: 'production' }) },
        ];
        const { items, problems } = projectItems({ entries: dup, ctx: { env: 'production' } });
        expect(items).toHaveLength(0);
        expect(problems[0]?.code).toBe('facts/scope-conflict');

        // 当前 scope 不适用 = 正常跳过（路径型/环境型事实在别的上下文就该消失），不是库坏了
        const miss = projectItems({ entries: [{ ns: { kind: 'project' }, fact: PROD }], ctx: { env: 'test' } });
        expect(miss.problems).toEqual([]);
        expect(miss.skipped).toEqual(['project:app.port#default']);
    });
});

describe('project 渲染', () => {
    it('yaml-nested：父节点 = 命名空间，子键 = claim', () => {
        const out = project({ entries: entries(), ctx: { env: 'production' } });
        expect(out.algorithm).toBe('yaml-nested');
        expect(out.text).toContain('task:projects/4/tasks/404:');
        expect(out.text).toContain('dev.check#entry');
        expect(out.text).toContain('model.default#fallback');
        // 任一 key 拼回都是合法 gid
        expect(out.shown).toContain('project:app.port#default');
        expect(out.shown).toContain('global:model.default#fallback');
    });

    it('auto shape：唯一且全局 = 裸标量；有变体 = 结构化（带 resolvedBy / variants）', () => {
        const out = project({ entries: entries(), ctx: { env: 'production' } });
        const lines = out.text.split('\n');
        const fallbackLine = lines.findIndex((l) => l.includes('model.default#fallback'));
        expect(lines[fallbackLine]).toContain('mimo-v2.5');
        expect(out.text).toContain('resolvedBy: env=production');
        expect(out.text).toContain('variants: 2');
    });

    it('shape=always-object 时全局条目也结构化', () => {
        const out = project({ entries: entries(), ctx: { env: 'production' }, shape: 'always-object' });
        expect(out.text).toContain('resolvedBy: global');
    });

    it('flat-gid：每条一行全 gid（可按 gid grep）', () => {
        const out = project({ entries: entries(), ctx: { env: 'production' }, algorithm: 'flat-gid' });
        // 实测：js-yaml 不给含 `:` 的 key 加引号（冒号后非空格 = 合法 plain scalar），
        // roundtrip 验证过 —— 而 claim 禁 `:` 又保证了这个前提成立。
        expect(out.text).toContain('project:app.port#default:');
        expect(out.text).toContain('task:projects/4/tasks/404:dev.check#entry:');
        // 平坦：没有"父节点单独一行"的分组形态
        expect(out.text).not.toMatch(/^ {2}(project|global):$/m);
    });

    it('md-list：一行一条，带依据标注', () => {
        const out = project({ entries: entries(), ctx: { env: 'production' }, algorithm: 'md-list' });
        expect(out.text).toContain('- `project:app.port#default` — 18888  (env=production, 2 变体)');
        expect(out.text).toContain('- `global:model.default#fallback` — mimo-v2.5');
    });

    it('三种算法覆盖同一批 gid（换算法不改语义）', () => {
        const base = project({ entries: entries(), ctx: { env: 'production' } });
        for (const algorithm of ['flat-gid', 'md-list'] as const) {
            const other = project({ entries: entries(), ctx: { env: 'production' }, algorithm });
            expect(new Set(other.shown)).toEqual(new Set(base.shown));
        }
    });

    it('预算裁剪按条目（不截断文本），且任务级优先留', () => {
        const all = project({ entries: entries(), ctx: { env: 'production' } });
        const cut = project({ entries: entries(), ctx: { env: 'production' }, maxBytes: all.bytes - 1 });
        expect(cut.omitted.length).toBe(1);
        expect(cut.omitted[0]).toBe('global:model.default#fallback');
        expect(cut.shown).toContain('task:projects/4/tasks/404:dev.check#entry');
        expect(cut.bytes).toBeLessThanOrEqual(all.bytes);
    });

    it('空输入 = 空投影（不是 null / 不是报错）', () => {
        const out = project({ entries: [] });
        expect(out.shown).toEqual([]);
        expect(out.skipped).toEqual([]);
        expect(out.problems).toEqual([]);
    });
});
