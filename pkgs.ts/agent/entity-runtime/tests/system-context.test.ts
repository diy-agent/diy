import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { instructionsOf } from '../src/agent';
import { buildRoomSystemContext, createRoomContext } from '../src/system-context';

const dirs: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'entity-ctx-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedAgents(repo: string, text: string): void {
    writeFileSync(join(repo, 'AGENTS.md'), text);
}

function seedKb(repo: string, rel: string, desc: string, sections: Array<[string, string]>): void {
    const full = join(repo, '.diy', 'knowledge', rel);
    mkdirSync(join(full, '..'), { recursive: true });
    const body = sections.map(([name, text]) => `## ${name}\n\n${text}\n`).join('\n');
    writeFileSync(full, `---\ndesc: ${desc}\n---\n\n${body}`);
}

describe('buildRoomSystemContext', () => {
    it('AGENTS.md 链 + 知识库索引都在（索引只给路径/desc/节数）', () => {
        const repo = tmp();
        seedAgents(repo, '仓库规则：改代码先开 worktree。');
        seedKb(repo, 'rule/dev.md', '开发规则', [['worktree', 'KB_BODY_ONLY']]);

        const text = buildRoomSystemContext({ cwd: repo });
        expect(text).toContain('仓库规则：改代码先开 worktree。');
        expect(text).toContain('AGENTS.md');
        expect(text).toContain('path: rule/dev.md');
        expect(text).toContain('开发规则');
        expect(text).toContain('scope: project');
        // 索引不投正文
        expect(text).not.toContain('KB_BODY_ONLY');
    });

    it('没有 home 时不读设备级库（不出现 scope=global）', () => {
        const repo = tmp();
        seedKb(repo, 'rule/dev.md', '开发规则', [['a', 'x']]);
        const text = buildRoomSystemContext({ cwd: repo });
        expect(text).toContain('scope: project');
        expect(text).not.toContain('scope: global');
    });

    it('空目录：没有链/知识库，但 diy / cwd 仍在信封里', () => {
        const text = buildRoomSystemContext({ cwd: tmp() });
        expect(text).toContain('vars:');
        expect(text).not.toContain('AGENTS.md');
    });
});

describe('createRoomContext：任务字段是变量单元（改正文不重建 system）', () => {
    it('任务 body/state 进 system；改一个字段只走 user 增量', () => {
        const repo = tmp();
        seedAgents(repo, '仓库规则：改代码先开 worktree。');
        const skillsRoot = join(tmp(), 'skills');
        const spec = {
            id: 'task:t-1',
            name: '任务一',
            type: 'task',
            data: { status: 'open', body: '第一版正文' } as Record<string, unknown>,
        };
        const ctx = createRoomContext({ spec, cwd: repo, skillsRoot });

        const open = ctx.open();
        expect(open.system).toContain('task:');
        expect(open.system).toContain('第一版正文');
        expect(open.system).toContain('state: open');

        // 首轮：没有变化 ⇒ 不产增量（system 里已经是全量）
        expect(ctx.step().user).toBe('');
        ctx.commit();

        spec.data['body'] = '第二版正文';
        const step = ctx.step();
        expect(step.delta?.paths).toContain('task.body');
        expect(step.user).toContain('第二版正文');
        expect(ctx.system).toBe(open.system); // system 逐字不动
        ctx.commit();
    });

    it('非 task 房间不投 task 节（不造空串冒充）', () => {
        const repo = tmp();
        const ctx = createRoomContext({
            spec: { id: 'proj:diy', name: 'diy', type: 'project', data: {} },
            cwd: repo,
            skillsRoot: join(tmp(), 'skills'),
        });
        expect(ctx.open().system).not.toContain('\ntask:');
    });

    it('docs 索引：docs/plans 的篇数进 vars', () => {
        const repo = tmp();
        mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
        writeFileSync(join(repo, 'docs', 'plans', 'a.md'), '# A');
        const text = buildRoomSystemContext({ cwd: repo });
        expect(text).toContain('docs:');
        expect(text).toContain('count: 1');
    });

    it('journal：最近记录进 vars；追加只走 journal 增量', () => {
        const repo = tmp();
        const entries = [{ seq: 1, at: Date.now(), kind: 'decision' as const, text: '选了 A' }];
        const ctx = createRoomContext({
            spec: { id: 'task:t-1', name: '任务一', type: 'task', data: {} },
            cwd: repo,
            skillsRoot: join(tmp(), 'skills'),
            journal: () => entries,
        });
        const open = ctx.open();
        expect(open.system).toContain('选了 A');
        expect(open.system).toContain('kind: decision');

        ctx.step();
        ctx.commit();
        entries.push({ seq: 2, at: Date.now(), kind: 'pitfall' as const, text: 'B 会炸' });
        const step = ctx.step();
        expect(step.delta?.paths).toContain('journal');
        expect(step.user).toContain('B 会炸');
        expect(ctx.system).toBe(open.system);
    });
});

describe('instructionsOf', () => {
    it('没有 systemContext 时与旧版逐字一致', () => {
        expect(instructionsOf({ botName: '小满', persona: '产品视角。' })).toBe(
            '你是「小满」，这个实体的专属 bot。\n产品视角。\n回答简洁；需要时间时调用 get_time 工具。',
        );
    });

    it('有 systemContext 时插在 persona 与工具提示之间', () => {
        const text = instructionsOf({ botName: 'a', persona: 'p', systemContext: 'RULES', toolsHint: 'T' });
        expect(text).toBe('你是「a」，这个实体的专属 bot。\np\nRULES\nT');
    });
});
