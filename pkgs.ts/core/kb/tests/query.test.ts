import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    briefOf,
    deviceKbRoot,
    findIn,
    firstSentence,
    getSection,
    parseSections,
    pathsOf,
    sameKbRoot,
} from '../src/query';

const dirs: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kb-query-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(root: string, rel: string, desc: string, sections: Array<[string, string]>): void {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    const body = sections.map(([name, text]) => `## ${name}\n\n${text}\n`).join('\n');
    writeFileSync(full, `---\ndesc: ${desc}\nupdated: 2026-11-19\n---\n\n${body}`);
}

describe('parseSections', () => {
    it('只认 ##，跳过 yaml 头与 ###；行号是文件里的绝对行号', () => {
        const text = ['---', 'desc: x', '---', '', '## a', 'A 内容', '### 子标题', '## b', 'B 内容'].join('\n');
        const sections = parseSections(text);
        expect(sections.map((section) => section.section)).toEqual(['a', 'b']);
        expect(sections[0]!.body).toContain('### 子标题');
        expect(sections[1]!.line).toBe(8);
    });
});

describe('firstSentence', () => {
    it('取到第一个句末标点，超长截断', () => {
        expect(firstSentence('第一句。第二句。')).toBe('第一句。');
        expect(firstSentence('没有标点'.padEnd(100, 'x'), 10)).toHaveLength(10);
    });
});

describe('pathsOf / briefOf / getSection / findIn', () => {
    function repo(): string {
        const root = join(tmp(), '.diy', 'knowledge');
        seed(root, 'rule/dev.md', '开发规则', [
            ['worktree', '**改代码先开 worktree**。主仓只读。'],
            ['check', '只准 ./sha.sh check。'],
        ]);
        seed(root, 'rule/doc.md', '文档规则', [['doc-format', '一行一条。']]);
        seed(root, 'find/find.md', '定位', [['app', '应用源码在 apps/diy-app。']]);
        return root;
    }

    it('pathsOf 支持目录、文件、前缀 wildcard', () => {
        const root = repo();
        expect(pathsOf(root, 'rule')).toEqual(['rule/dev.md', 'rule/doc.md']);
        expect(pathsOf(root, 'rule/dev')).toEqual(['rule/dev.md']);
        expect(pathsOf(root, 'rule/dev.md')).toEqual(['rule/dev.md']);
        expect(pathsOf(root, 'rule*')).toEqual(['rule/dev.md', 'rule/doc.md']);
    });

    it('briefOf 给每条知识的全部小节 + 首句', () => {
        const items = briefOf(repo(), 'rule/dev');
        expect(items).toHaveLength(1);
        expect(items[0]!.sections.map((section) => section.section)).toEqual(['worktree', 'check']);
        expect(items[0]!.sections[0]!.first).toContain('改代码先开 worktree');
    });

    it('getSection 支持 `path#section` / 省 .md / 大小写不敏感；找不到 = null', () => {
        const root = repo();
        expect(getSection(root, 'rule/dev#worktree')?.body).toContain('主仓只读');
        expect(getSection(root, 'rule/dev.md#CHECK')?.section).toBe('check');
        expect(getSection(root, 'rule/dev')?.section).toBeNull();
        expect(getSection(root, 'rule/dev#nope')).toBeNull();
        expect(getSection(root, '../escape#x')).toBeNull();
    });

    it('findIn 多个关键词 = 都要命中，命中行号与片段可读', () => {
        const root = repo();
        const hits = findIn(root, ['worktree', '主仓']);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ path: 'rule/dev.md', section: 'worktree' });
        expect(hits[0]!.line).toBeGreaterThan(0);
        expect(hits[0]!.snippet).toContain('worktree');
        expect(findIn(root, ['worktree', '不存在的词'])).toEqual([]);
    });
});

describe('deviceKbRoot / sameKbRoot（设备根与「同一份库」的判据）', () => {
    it('deviceKbRoot：显式设备根优先，缺省 ~/.diy2', () => {
        expect(deviceKbRoot(undefined, '/h')).toBe('/h/.diy2/knowledge');
        expect(deviceKbRoot('  ', '/h')).toBe('/h/.diy2/knowledge');
        expect(deviceKbRoot('/dev-root', '/h')).toBe('/dev-root/knowledge');
    });

    it('sameKbRoot：symlink 指同一份库算同一个（~/.diy/knowledge → ~/.diy2/knowledge）', () => {
        const base = tmp();
        const real = join(base, 'diy2', 'knowledge');
        mkdirSync(real, { recursive: true });
        const link = join(base, 'diy', 'knowledge');
        mkdirSync(join(base, 'diy'), { recursive: true });
        symlinkSync(real, link);

        expect(sameKbRoot(link, real)).toBe(true);
        const other = join(base, 'proj', '.diy', 'knowledge');
        mkdirSync(other, { recursive: true });
        expect(sameKbRoot(other, real)).toBe(false);
    });

    it('sameKbRoot：路径不存在时回落字符串比较（不抛）', () => {
        expect(sameKbRoot('/no/such/a', '/no/such/b')).toBe(false);
        expect(sameKbRoot('/no/such/a', '/no/such/a')).toBe(true);
    });
});
