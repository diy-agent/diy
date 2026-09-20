// tests/core/template-dsl-golden.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 换引擎的验收：DSL 模版装配出来的 system 与**换引擎前的真实输出**逐字节一致
//
// golden（tests/fixtures/system.golden.txt）是 M4 之前用 legacy 路径（正则替换 + 代码拼装）
// 产出的 system，输入是下面这份合成数据（稳定、不依赖本机 AGENTS.md 内容）。
//
// 唯一允许的差异：**末尾一个 \n** —— 决策"模版源逐字节进引擎"意味着节模版自带末尾换行，
// 而 legacy 的 blocks.join("\n\n") 不带。其它任何一处字节差异都是 bug。
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSystemDsl, type AssembleGlobals } from '../../src/main/services/prompt-registry';

const golden = readFileSync(join(__dirname, '..', 'fixtures', 'system.golden.txt'), 'utf-8');

/** 与生成 golden 时完全相同的输入（只是换成命名空间版变量） */
const GLOBALS: AssembleGlobals = {
    diy: { cli: '/repo/diy.sh', home: '/tmp/diy-home' },
    project: { path: '/repo' },
    task: {
        uri: 'projects/4/tasks/4',
        title: '评审任务',
        state: 'active',
        body: '正文里有 & 与 <x> 这类字符。',
        dir: '/tmp/diy-home/projects/4/tasks/4',
    },
    // legacy 的 cwd_note 是 "\n注意：…"；现在文案进模版，变量只留事实与原因
    cwd: { path: '/repo', note: '项目目录不存在，工具实际在任务目录下执行', isFallback: true, isTaskDir: true, isAppDir: false },
    chain: [
        { path: '/Users/ccc/AGENTS.md', scope: '/Users/ccc', content: '根规则 & 全局约定' },
        { path: '/repo/AGENTS.md', scope: '/repo', content: '仓库规则 <docs>' },
    ],
    skills: [],
};

describe('DSL 装配 === 换引擎前的 system（逐字节，末尾换行除外）', () => {
    it('整份 system 与 golden 相同', () => {
        const system = renderSystemDsl({ globals: GLOBALS });
        expect(system).toBe(`${golden}\n`);
    });

    it('差异只有末尾那一个 \\n（把两边都去掉末尾换行后必须完全相等）', () => {
        const system = renderSystemDsl({ globals: GLOBALS });
        expect(system.replace(/\n$/, '')).toBe(golden);
    });

    it('节顺序与节间分隔正确（空行 = 旧代码的 join("\\n\\n")）', () => {
        const system = renderSystemDsl({ globals: GLOBALS });
        const order = ['<diy>', '<project_context>', '<task>', '<rules>', '<guard>'];
        const positions = order.map((t) => system.indexOf(t));
        expect(positions.every((p) => p > -1)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        for (const t of order.slice(1)) expect(system).toContain(`\n\n${t}`);
    });

    it('skills 为空数组时整节不出现；有技能时插在 rules 之后', () => {
        expect(renderSystemDsl({ globals: GLOBALS })).not.toContain('<skills>');
        const withSkills = renderSystemDsl({
            globals: { ...GLOBALS, skills: [{ name: 'diy-dev', desc: '开发流程' }] },
        });
        expect(withSkills).toContain('<skills>\n- diy-dev：开发流程\n</skills>');
        expect(withSkills.indexOf('<skills>')).toBeGreaterThan(withSkills.indexOf('</rules>'));
        expect(withSkills.indexOf('<skills>')).toBeLessThan(withSkills.indexOf('<guard>'));
    });

    it('链上每层用 _chain.md 渲染，层间空行与旧 join("\\n\\n") 一致', () => {
        const system = renderSystemDsl({ globals: GLOBALS });
        expect(system).toContain(
            '<project_instructions path="/Users/ccc/AGENTS.md" scope="/Users/ccc">\n根规则 & 全局约定\n</project_instructions>' +
                '\n\n' +
                '<project_instructions path="/repo/AGENTS.md" scope="/repo">\n仓库规则 <docs>\n</project_instructions>',
        );
    });

    it('正文里的 <pid> / & 等字符零转义（输出标签是纯文本）', () => {
        const system = renderSystemDsl({ globals: GLOBALS });
        expect(system).toContain('projects/<pid>/tasks/<tid>/AGENTS.md');
        expect(system).toContain('正文里有 & 与 <x> 这类字符。');
        expect(system).not.toContain('&lt;');
    });
});
