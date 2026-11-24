import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { instructionsOf } from '../src/agent';
import { unitBoard } from '../src/units';
import { buildRoomSystemContext, createRoomContext } from '../src/system-context';
import { clearWatchCache } from '../src/watch-cache';

const dirs: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'entity-ctx-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    clearWatchCache();
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
            type: 'task',
            data: { title: '任务一', status: 'open', body: '第一版正文' } as Record<string, unknown>,
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

    it('老任务只有 desc 时标题兜底（标题与描述合并前落的数据）', () => {
        const repo = tmp();
        const ctx = createRoomContext({
            spec: { id: 'task:t-old', type: 'task', data: { status: 'open', desc: '旧的一句话描述' } },
            cwd: repo,
            skillsRoot: join(tmp(), 'skills'),
        });
        // 合并后名字只住在 data.title；老数据没迁，读的时候用 desc 顶上
        expect(ctx.open().system).toContain('title: "旧的一句话描述"');
    });

    it('非 task 房间不投 task 节（不造空串冒充）', () => {
        const repo = tmp();
        const ctx = createRoomContext({
            spec: { id: 'proj:diy', type: 'project', data: { name: 'diy' } },
            cwd: repo,
            skillsRoot: join(tmp(), 'skills'),
        });
        // 同上：顶层键在 `vars:` 下缩进两格；写 `\ntask:` 永远为真 = 白测
        expect(ctx.open().system).not.toContain('  task:');
    });

    it('docs 索引：docs/plans 的篇数进 vars', () => {
        const repo = tmp();
        mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
        writeFileSync(join(repo, 'docs', 'plans', 'a.md'), '# A');
        const text = buildRoomSystemContext({ cwd: repo });
        expect(text).toContain('docs:');
        expect(text).toContain('count: 1');
        expect(text).toContain('docs/plans/a.md');
        expect(text).toContain('title: A');
    });

    it('journal：最近记录进 vars；追加只走 journal 增量', () => {
        const repo = tmp();
        const entries = [{ seq: 1, at: Date.now(), kind: 'decision' as const, text: '选了 A' }];
        const ctx = createRoomContext({
            spec: { id: 'task:t-1', type: 'task', data: { title: '任务一' } },
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

    it('units：全量注入（ready / doing / blocked / 分层）→ 「现在能做哪几条」不用先调工具', () => {
        const repo = tmp();
        // 用真的纯函数算 board：注入与视图 / 工具是同一份派生量，别在测试里手捏形状
        const facts = [
            { id: 'u1', title: '读现状', status: 'done' as const, seq: 1 },
            { id: 'u2', title: '写领域函数', status: 'doing' as const, seq: 2 },
            { id: 'u3', title: '加工具', status: 'open' as const, seq: 3 },
            { id: 'u4', title: '注入上下文', status: 'open' as const, seq: 4 },
        ];
        const deps = [
            { taskId: 'x', from: 'u1', to: 'u2' },
            { taskId: 'x', from: 'u2', to: 'u3' },
        ];
        const ctx = createRoomContext({
            spec: { id: 'task:t-1', type: 'task', data: { title: '任务一' } },
            cwd: repo,
            skillsRoot: join(tmp(), 'skills'),
            units: () => unitBoard(facts, deps),
        });
        const system = ctx.open().system;
        expect(system).toContain('units:');
        // 三档都进：ready 是「该做什么」的答案，blocked 带前置解释为什么还不能做
        expect(system).toContain('ready:');
        expect(system).toContain('u4');
        expect(system).toContain('doing:');
        expect(system).toContain('blocked:');
        // 分层是全图的骨架（视图与上下文同一形状）
        expect(system).toContain('layers:');
        // title 进上下文，body 不进（要全文用 unit_get）
        expect(system).toContain('写领域函数');
    });

    it('units：空图整节缺席（不造空壳冒充）', () => {
        const repo = tmp();
        const ctx = createRoomContext({
            spec: { id: 'task:t-1', type: 'task', data: { title: '任务一' } },
            cwd: repo,
            skillsRoot: join(tmp(), 'skills'),
            units: () => unitBoard([], []),
        });
        // 变量树顶层都在 `vars:` 下，所以缩进两格才是真断言（写 `\nunits:` 永远为真 = 白测）
        expect(ctx.open().system).not.toContain('  units:');
    });

    it('units：推状态只走 units 增量，system 逐字不动（不破前缀缓存）', () => {
        const repo = tmp();
        const facts = [
            { id: 'u1', title: '第一步', status: 'open' as const, seq: 1 },
            { id: 'u2', title: '第二步', status: 'open' as const, seq: 2 },
        ];
        const ctx = createRoomContext({
            spec: { id: 'task:t-1', type: 'task', data: { title: '任务一' } },
            cwd: repo,
            skillsRoot: join(tmp(), 'skills'),
            units: () => unitBoard(facts, [{ taskId: 'x', from: 'u1', to: 'u2' }]),
        });
        const open = ctx.open();
        expect(open.system).toContain('第一步');

        ctx.step();
        ctx.commit();
        facts[0]!.status = 'done';
        const step = ctx.step();
        expect(step.delta?.paths).toContain('units');
        // u1 做完 ⇒ u2 从 blocked 挪到 ready：增量里就该看得见这个转变
        expect(step.user).toContain('u2');
        expect(ctx.system).toBe(open.system);
    });

    it('room.members：成员名进 vars；成员变化只走 room.members 增量', () => {
        const repo = tmp();
        const members = [{ id: 'bot-1', name: '小满', key: '小满', main: true }];
        const ctx = createRoomContext({
            spec: { id: 'task:t-1', type: 'task', data: { title: '任务一' } },
            cwd: repo,
            skillsRoot: join(tmp(), 'skills'),
            members: () => members,
        });
        const open = ctx.open();
        expect(open.system).toContain('members:');
        expect(open.system).toContain('小满');

        ctx.step();
        ctx.commit();
        members.push({ id: 'bot-2', name: 'diy', key: 'diy', main: false });
        const step = ctx.step();
        expect(step.delta?.paths).toContain('room.members');
        expect(step.user).toContain('diy');
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
