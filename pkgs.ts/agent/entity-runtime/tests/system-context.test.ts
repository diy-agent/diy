import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { instructionsOf } from '../src/agent';
import { buildRoomSystemContext } from '../src/system-context';

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
        expect(text).toContain('<project_instructions');
        expect(text).toContain('rule/dev.md — 开发规则（1 节 · project）');
        // 索引不投正文
        expect(text).not.toContain('KB_BODY_ONLY');
    });

    it('没有 home 时不读设备级库（不出现 scope=global）', () => {
        const repo = tmp();
        seedKb(repo, 'rule/dev.md', '开发规则', [['a', 'x']]);
        const text = buildRoomSystemContext({ cwd: repo });
        expect(text).toContain('· project');
        expect(text).not.toContain('· global');
    });

    it('超预算截断并标注（不静默丢）', () => {
        const repo = tmp();
        seedAgents(repo, 'x'.repeat(2000));
        const text = buildRoomSystemContext({ cwd: repo, maxBytes: 200 });
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(400);
        expect(text).toContain('上下文超预算');
    });

    it('空目录 → 空串（agent 退回只有 persona）', () => {
        expect(buildRoomSystemContext({ cwd: tmp() })).toBe('');
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
