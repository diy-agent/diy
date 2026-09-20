// tests/core/template-engine-equivalence.test.ts
//
// ═══════════════════════════════════════════════════════════════
// 🎯 换引擎的「零回归」证据：新引擎（@diy/template）渲染今天的真实模版，
//    与现有实现（prompt-registry 的正则白名单替换 + 代码包裹/拼接）逐字节相同。
//
// 为什么这个用例最关键：
//   换引擎是"模型看到的东西不能变"的改造。只要有一处字节差异，就要人工判断
//   是 bug 还是有意改进 —— 所以先用等价性把"无意漂移"锁死。
//
// 覆盖两部分：
//   1. 8 份内置模版逐份等价（含片段 _chain.md 的作用域）
//   2. 装配等价：把代码里的「包裹标签 + 空节跳过 + join("\n\n")」搬到模版后，
//      整份 system 的输出与今天**逐字节相同**
//
// 已拍板的两条（本用例用固定值把差异按住）：
//   · 注册表将**停止** trim + 补 \n，模版源逐字节进引擎 → 新模版自己写末尾换行
//     （见下方 fixtures；这里为了对齐"今天的 registry 行为"，旧侧仍按 trim+\n 计算）。
//   · 节间分隔符由**节模版自带**（末节不带），布局只列顺序；片段内的多元素分隔用
//     {{.isFirst}} 表达（见 chain 用例，等价于 join("\n\n")）。
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';
import { render as renderDsl } from '@diy/template';
import { PROMPT_DEFAULTS } from '../../src/main/prompts/defaults';
import { renderTemplate, type AssembleVars } from '../../src/main/services/prompt-registry';

/** 与 prompt-registry.parseMd 完全一致的 body 提取（frontmatter 之后 trim + 补 \n） */
function bodyOf(raw: string): string {
    if (!raw.startsWith('---')) return raw;
    const end = raw.indexOf('---', 3);
    if (end === -1) return raw;
    return `${raw.slice(end + 3).trim()}\n`;
}

/**
 * 把"今天的模版正文"改写成 DSL 形态。
 * 现在只剩一件事要做：**目标模版与今天的模版正文逐字节相同**——
 * 输出标签（`<diy>`、`<project_instructions path="…">`）在新引擎里就是文本，
 * `<pid>` / `<tid>` 也不需要任何转义（这正是这次收窄换来的）。
 */
function dslize(body: string, locals: string[] = []): string {
    // 唯一的改写：片段局部变量加 `.` 前缀（动态作用域）——今天的扁平名在新引擎里读的是 globals
    let out = body;
    for (const name of locals) out = out.split(`{{${name}}}`).join(`{{.${name}}}`);
    return out;
}

/** frontmatter 里的 tag（包裹标签；空串 = 裸文本节） */
function tagOf(raw: string): string {
    const end = raw.indexOf('---', 3);
    if (end === -1) return '';
    const front = (yaml.load(raw.slice(3, end).trim() || '{}') as Record<string, unknown>) ?? {};
    return String(front['tag'] ?? '');
}

/** 与 assembleSystem 的 AssembleVars 同形状的固定值（全部 12 个名字都要在，否则严格解析会报错） */
const VARS: AssembleVars = {
    diy_cli: '/repo/diy.sh',
    diy_home: '/tmp/diy-home',
    project_path: '/repo',
    task_uri: 'projects/4/tasks/4',
    task_title: '评审任务',
    task_state: 'active',
    task_body: '正文里有 & 与 <x> 这类字符。',
    task_dir: '/tmp/diy-home/projects/4/tasks/4',
    cwd: '/repo',
    cwd_note: '',
    project_instructions: '',
    skills: '',
};

/** 链上 4 层（与真实分层同形，内容里带 & 与 < 以验证不转义） */
const CHAIN = [
    { path: '/Users/ccc/AGENTS.md', scope: '/Users/ccc', content: '根规则 & 全局约定' },
    { path: '/repo/AGENTS.md', scope: '/repo', content: '仓库规则 <docs>' },
];

describe('换引擎零回归：8 份内置模版逐份逐字节等价', () => {
    for (const relpath of Object.keys(PROMPT_DEFAULTS)) {
        it(`${relpath}：新旧渲染结果完全一致`, () => {
            const raw = PROMPT_DEFAULTS[relpath]!;
            const body = bodyOf(raw);
            const legacy = renderTemplate(body, VARS, {
                known: ['path', 'scope', 'content'],
                extra: { path: '/repo/AGENTS.md', scope: '/repo', content: '规则 & <docs>' },
            });
            expect(legacy.unknown).toEqual([]);
            const locals = relpath === '_chain.md' ? ['path', 'scope', 'content'] : [];
            const next = renderDsl(dslize(body, locals), {
                globals: VARS as unknown as Record<string, unknown>,
                dynamic: [{ vars: { path: '/repo/AGENTS.md', scope: '/repo', content: '规则 & <docs>' } }],
            });
            expect(next).toBe(legacy.text);
        });
    }

    it('空白值（cwd_note / skills 为空串）不会被当成缺失；未转义', () => {
        const body = bodyOf(PROMPT_DEFAULTS['300-task.md']!);
        const legacy = renderTemplate(body, VARS).text;
        const next = renderDsl(body, { globals: VARS as unknown as Record<string, unknown> });
        expect(next).toBe(legacy);
        expect(next).toContain('正文里有 & 与 <x> 这类字符。');
        expect(next).not.toContain('&amp;');
    });
});

describe('换引擎零回归：把「包裹 + 空节 + join」搬进模版后，整份 system 仍逐字节相同', () => {
    /** 今天的装配：按 key 序、空节跳过、tag 包裹、join("\n\n") */
    function legacySystem(): string {
        const vars: AssembleVars = { ...VARS, project_instructions: legacyChain() };
        const blocks: string[] = [];
        for (const relpath of Object.keys(PROMPT_DEFAULTS)) {
            const body = bodyOf(PROMPT_DEFAULTS[relpath]!);
            if (/fragment:\s*true/.test(PROMPT_DEFAULTS[relpath]!)) continue;
            const text = renderTemplate(body, vars).text.trim();
            if (text === '') continue;
            const tag = tagOf(PROMPT_DEFAULTS[relpath]!);
            blocks.push(tag ? `<${tag}>\n${text}\n</${tag}>` : text);
        }
        return blocks.join('\n\n');
    }

    /** 今天的链渲染：片段逐层渲染 + trim + join("\n\n") */
    function legacyChain(): string {
        const tpl = bodyOf(PROMPT_DEFAULTS['_chain.md']!);
        return CHAIN.map((f) =>
            renderTemplate(tpl, {} as AssembleVars, {
                known: ['path', 'scope', 'content'],
                extra: { path: f.path, scope: f.scope, content: f.content },
            }).text.trim(),
        ).join('\n\n');
    }

    it('XML 化的模版 + system.md 装配 === 今天的 system', () => {
        // 迁移目标形态：标签内联、链在模版里迭代、末尾换行按"不 trim"规则去掉
        const files: Record<string, string> = {
            './000-identity.md': dslize(bodyOf(PROMPT_DEFAULTS['000-identity.md']!).trimEnd()),
            './100-diy.md': `<diy>\n${dslize(bodyOf(PROMPT_DEFAULTS['100-diy.md']!).trim())}\n</diy>`,
            './200-project.md': `<project_context>\n${dslize(bodyOf(PROMPT_DEFAULTS['200-project.md']!).trim())
                .replace(
                    '{{project_instructions}}',
                    '<template :for="f of chain"><template :unless=".isFirst">\n\n</template><template :include="./_chain.md" path=".f.path" scope=".f.scope" content=".f.content" /></template>',
                )}\n</project_context>`,
            './300-task.md': `<task>\n${dslize(bodyOf(PROMPT_DEFAULTS['300-task.md']!).trim())}\n</task>`,
            './_chain.md': dslize(bodyOf(PROMPT_DEFAULTS['_chain.md']!).trimEnd(), ['path', 'scope', 'content']),
            './400-rules.md': `<rules>\n${dslize(bodyOf(PROMPT_DEFAULTS['400-rules.md']!).trim())}\n</rules>`,
            './_guard.md': `<guard>\n${dslize(bodyOf(PROMPT_DEFAULTS['_guard.md']!).trim())}\n</guard>`,
        };
        const resolver = {
            resolve: (rel: string) =>
                rel in files ? { source: files[rel]!, fragment: rel === './_chain.md', locked: rel === './_guard.md' } : null,
        };
        // system.md：每节一行 include，节与节之间空一行 → 输出正好是 join("\n\n") 的效果
        const system = [
            '<template :include="./000-identity.md" />',
            '',
            '<template :include="./100-diy.md" />',
            '',
            '<template :include="./200-project.md" />',
            '',
            '<template :include="./300-task.md" />',
            '',
            '<template :include="./400-rules.md" />',
            '',
            '<template :include="./_guard.md" />',
        ].join('\n');

        const next = renderDsl(
            system,
            // 变量名沿用今天的扁平命名（名字改名是另一件事，与"输出是否等价"无关）
            { globals: { ...(VARS as unknown as Record<string, unknown>), chain: CHAIN } },
            { resolver, file: 'system.md', locked: true },
        );
        expect(next).toBe(legacySystem());
        // 顺带证明链确实进了 system（不是空节被跳过）
        expect(next).toContain('<project_instructions path="/repo/AGENTS.md" scope="/repo">');
        expect(next).toContain('根规则 & 全局约定');
    });
});
