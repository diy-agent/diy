// tests/fold.test.ts — 索引折叠（##404 减负的现行实现，原先在 @diy-agent/facts）
import { describe, expect, it } from 'vitest';

import { foldKbIndex, KB_INDEX_FOLD_MIN_GROUP, type KbIndexEntry } from '../src/index.js';

function e(path: string, sections = 1, scope: 'project' | 'global' = 'project'): KbIndexEntry {
    return { path, desc: `${path} 的说明`, sections, scope };
}

describe('foldKbIndex', () => {
    it('同目录 ≥ minGroup 折成一条：path 以 / 结尾、sections 合计、名字列出处', () => {
        const out = foldKbIndex([e('app/a.md', 2), e('app/b.md', 3), e('app/c.md', 5)]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ path: 'app/', sections: 10, scope: 'project' }); // 节数由渲染器统一给
        expect(out[0]?.desc).toContain('3 个文件');
        expect(out[0]?.desc).toContain('a、b、c');
        expect(out[0]?.desc).toContain('brief app');
    });

    it('两个文件也折（desc 仍列名字，丢的只是各自节数）', () => {
        const out = foldKbIndex([e('x/a.md'), e('x/b.md')]);
        expect(out.map((entry) => entry.path)).toEqual(['x/']);
        expect(out[0]?.desc).toContain('2 个文件');
        expect(out[0]?.desc).toContain('a、b');
        expect(KB_INDEX_FOLD_MIN_GROUP).toBe(2);
    });

    it('单文件目录不折（折了反而多一层跳转）', () => {
        const out = foldKbIndex([e('x/a.md')]);
        expect(out.map((entry) => entry.path)).toEqual(['x/a.md']);
    });

    it('根目录文件不折（没有目录段可折）', () => {
        const out = foldKbIndex([e('INDEX.md'), e('a/b.md'), e('a/c.md'), e('a/d.md')]);
        expect(out.map((entry) => entry.path)).toEqual(['a/', 'INDEX.md']); // localeCompare：小写 a 排在大写 I 前
    });

    it('超过 showNames 时截断并给出总数', () => {
        const entries = Array.from({ length: 9 }, (_, i) => e(`g/f${String(i)}.md`));
        const out = foldKbIndex(entries, { showNames: 3 });
        expect(out[0]?.desc).toContain('…等 9 个');
        expect(out[0]?.desc).not.toContain('f8');
    });

    it('组内混库取 project（与「项目库优先」同判据）', () => {
        const out = foldKbIndex([e('k/a.md', 1, 'global'), e('k/b.md', 1, 'project'), e('k/c.md', 1, 'global')]);
        expect(out[0]?.scope).toBe('project');
    });

    it('结果按路径排序（折叠项与散文件混排）', () => {
        const out = foldKbIndex([e('z/a.md'), e('b/a.md'), e('b/b.md'), e('b/c.md')]);
        expect(out.map((entry) => entry.path)).toEqual(['b/', 'z/a.md']);
    });
});
