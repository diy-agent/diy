import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { factsHandlers } from '../src/cli/facts';

const dirs: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diy2-facts-'));
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

function fixture(): { project: string; global: string } {
    const project = join(tmp(), '.diy', 'knowledge');
    const global = join(tmp(), 'home', 'knowledge');
    seed(project, 'rule/dev.md', '开发规则', [['worktree', '改代码先开 worktree。']]);
    seed(project, 'find/find.md', '定位', [['app', '源码在 apps/diy-app。']]);
    seed(global, 'rule/rule.md', '全局规则', [['gpg', 'git 操作必须签名。']]);
    return { project, global };
}

describe('facts handlers（md 只读投影）', () => {
    it('brief：两库按 path 合并——全局独有条目不被项目库同主题遮住', () => {
        const { project, global } = fixture();
        seed(global, 'rule/code.md', '全局代码规则', [['x', '全局才有。']]);
        const { facts } = factsHandlers({ projectRoot: project, globalRoot: global });
        const items = facts.brief({ input: { subject: 'rule' } }).items;
        // 反例：旧实现按 subject 短路，项目库 rule/ 只有一个文件也会把全局 rule/rule.md
        // 整块蒙住 —— 删掉扁平副本后（##519）这会让通用硬约束凭空消失
        expect(items.map((item) => item.path)).toEqual(['rule/dev.md', 'rule/code.md', 'rule/rule.md']);
        expect(items.map((item) => item.scope)).toEqual(['project', 'global', 'global']);
    });

    it('brief：同 path 两库都有 → 只出项目那份（不重复列）', () => {
        const { project, global } = fixture();
        seed(global, 'rule/dev.md', '全局的开发规则', [['worktree', '全局版本。']]);
        const { facts } = factsHandlers({ projectRoot: project, globalRoot: global });
        const items = facts.brief({ input: { subject: 'rule' } }).items;
        expect(items.map((item) => item.path)).toEqual(['rule/dev.md', 'rule/rule.md']);
        expect(items[0]).toMatchObject({ path: 'rule/dev.md', scope: 'project' });
    });

    it('brief：项目库没有的主题回落全局库', () => {
        const { project, global } = fixture();
        const { facts } = factsHandlers({ projectRoot: project, globalRoot: global });
        expect(facts.brief({ input: { subject: 'nothing' } }).items).toEqual([]);
        seed(global, 'only/global.md', '仅全局', [['x', '只有全局有。']]);
        const items = facts.brief({ input: { subject: 'only' } }).items;
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ path: 'only/global.md', scope: 'global' });
    });

    it('get：先项目后全局；找不到抛错（CLI 退出码 1）', () => {
        const { project, global } = fixture();
        const { facts } = factsHandlers({ projectRoot: project, globalRoot: global });
        expect(facts.get({ input: { claim: 'rule/dev#worktree' } })).toMatchObject({
            path: 'rule/dev.md',
            scope: 'project',
        });
        expect(facts.get({ input: { claim: 'rule/rule#gpg' } })).toMatchObject({
            path: 'rule/rule.md',
            scope: 'global',
        });
        expect(() => facts.get({ input: { claim: 'rule/dev#nope' } })).toThrow(/没找到/);
    });

    it('find：项目 + 全局，同 path#section 去重', () => {
        const { project, global } = fixture();
        const { facts } = factsHandlers({ projectRoot: project, globalRoot: global });
        const hits = facts.find({ input: { keywords: 'worktree' } }).hits;
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ path: 'rule/dev.md', scope: 'project' });
        expect(facts.find({ input: { keywords: '签名' } }).hits[0]).toMatchObject({
            path: 'rule/rule.md',
            scope: 'global',
        });
    });

    it('status：两个库分列，问题清单透传', () => {
        const { project, global } = fixture();
        const { facts } = factsHandlers({ projectRoot: project, globalRoot: global });
        const status = facts.status();
        expect(status.project.entries).toBe(2);
        expect(status.project.sections).toBe(2);
        expect(status.global.entries).toBe(1);
        expect(status.project.problems).toEqual([]);
    });

    it('status：同名文件逐字节比对——相同记镜像，不同记漂移', () => {
        const { project, global } = fixture();
        seed(global, 'rule/dev.md', '开发规则', [['worktree', '改代码先开 worktree。']]); // 与项目那份逐字节相同
        seed(global, 'find/find.md', '定位', [['app', '设备库版本不同。']]); // 同名异内容
        const { facts } = factsHandlers({ projectRoot: project, globalRoot: global });
        const { overlap } = facts.status();
        expect(overlap.same).toBe(1);
        expect(overlap.differs.map((item) => item.path)).toEqual(['find/find.md']);
        expect(overlap.differs[0]?.globalBytes).toBeGreaterThan(0);
    });

    it('brief：多个 subject 之间同 path 只出一次', () => {
        const { project, global } = fixture();
        const { facts } = factsHandlers({ projectRoot: project, globalRoot: global });
        // `rule` 已含 rule/dev.md，再显式要 rule/dev 不该再列一次
        const items = facts.brief({ input: { subject: 'rule,rule/dev' } }).items;
        expect(items.map((item) => item.path)).toEqual(['rule/dev.md', 'rule/rule.md']);
    });
});
