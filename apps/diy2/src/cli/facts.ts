// src/cli/facts.ts —— 知识的只读投影（`diy2 facts brief|get|find|status`）。
//
// 真源仍是 `.diy/knowledge/**/*.md`（项目库优先，`~/.diy/knowledge` 兜底），
// 与 `@diy-agent/kb` 的写侧共用同一套扫描；这里只做「少打点字、少花点 token」的投影：
//   · brief  —— 目录/文件/前缀下每条知识的全部小节 + 首句（决定展开哪条）
//   · get    —— `<路径>#<小节>` 取正文
//   · find   —— 全文检索（多个关键词 = 全都要命中）
//   · status —— 条目 / 小节 / 字节数 + 问题清单（与 `diy kb check` 同一套判据）
//
// 语义是 2026-11 修订后的口径：文件仍是唯一真源，不建索引、不引入 claim / evidence。

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

import { z } from 'zod';
import { RpcSchema } from '@diy-agent/rpc';
import { briefOf, findIn, getSection, globalKbRoot, kbRootOf, scanKb } from '@diy-agent/kb';

const Scope = z.enum(['project', 'global']);

const BriefItem = z.object({
    path: z.string(),
    scope: Scope,
    sections: z.array(z.object({ section: z.string(), first: z.string() })),
});

const FindHit = z.object({
    path: z.string(),
    section: z.string(),
    line: z.number(),
    snippet: z.string(),
    scope: Scope,
});

const KbStats = z.object({
    root: z.string(),
    exists: z.boolean(),
    entries: z.number(),
    sections: z.number(),
    bytes: z.number(),
    problems: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })),
});

function statsOf(root: string) {
    const scan = scanKb(root);
    return {
        root: scan.root,
        exists: existsSync(scan.root),
        entries: scan.entries.length,
        sections: scan.entries.reduce((sum, entry) => sum + entry.sections, 0),
        bytes: scan.entries.reduce((sum, entry) => sum + entry.bytes, 0),
        problems: scan.problems.map((problem) => ({
            path: problem.path,
            code: problem.code,
            message: problem.message,
        })),
    };
}

export interface FactsDeps {
    readonly projectRoot?: string;
    readonly globalRoot?: string;
}

export const factsApi = RpcSchema.group({
    children: {
        facts: RpcSchema.group({
            desc:
                `知识库的只读投影（真源 = .diy/knowledge/**/*.md；项目库优先，~/.diy/knowledge 兜底）。` +
                `\n\n**不知道先看哪条 → \`diy2 facts brief rule\`**（列目录下每条知识的小节 + 首句）；` +
                `要正文用 \`diy2 facts get rule/dev#worktree\`；跨主题搜用 \`diy2 facts find 关键词\`。`,
            children: {
                brief: RpcSchema.unary({
                    desc: `列主题（目录 / 文件 / 前缀 wildcard）下每条知识的全部小节 + 首句（≤maxChars）`,
                    input: {
                        subject: z.string().cliArg({
                            placeholder: '<subject,...>',
                            desc: '目录名（rule）、文件（rule/dev）、前缀（app*）；多个用逗号',
                        }),
                        maxChars: z.number().optional().cliOption({ desc: '每条首句的字数上限（缺省 80）' }),
                    },
                    output: z.object({ items: z.array(BriefItem) }),
                }),
                get: RpcSchema.unary({
                    desc: `按 \`<路径>#<小节>\` 取一节正文；不带 # 则整篇（去 yaml 头）。找不到 → 退出码 1`,
                    input: {
                        claim: z.string().cliArg({
                            placeholder: '<path#section>',
                            desc: '如 rule/dev#worktree；路径可省 .md，小节可省 #',
                        }),
                    },
                    output: z.object({
                        path: z.string(),
                        section: z.string().nullable(),
                        body: z.string(),
                        scope: Scope,
                    }),
                }),
                find: RpcSchema.unary({
                    desc: `全文检索（大小写不敏感；多个关键词用逗号 = 全都要命中）`,
                    input: {
                        keywords: z.string().cliArg({ placeholder: '<kw,...>', desc: '关键词；多个用逗号分隔（与）' }),
                        limit: z.number().optional().cliOption({ desc: '最多返回几条（缺省 50）' }),
                    },
                    output: z.object({ hits: z.array(FindHit) }),
                }),
                status: RpcSchema.unary({
                    desc: `体检：条目 / 小节 / 字节数 + 问题清单（项目库与设备级库分列）`,
                    input: {},
                    output: z.object({ project: KbStats, global: KbStats }),
                }),
            },
        }),
    },
});

export function factsHandlers(deps?: FactsDeps): {
    facts: {
        brief: (req: { input: { subject: string; maxChars?: number } }) => {
            items: Array<{
                path: string;
                scope: 'project' | 'global';
                sections: ReadonlyArray<{ section: string; first: string }>;
            }>;
        };
        get: (req: { input: { claim: string } }) => {
            path: string;
            section: string | null;
            body: string;
            scope: 'project' | 'global';
        };
        find: (req: { input: { keywords: string; limit?: number } }) => {
            hits: Array<{ path: string; section: string; line: number; snippet: string; scope: 'project' | 'global' }>;
        };
        status: () => { project: ReturnType<typeof statsOf>; global: ReturnType<typeof statsOf> };
    };
} {
    const project = deps?.projectRoot ?? kbRootOf(process.cwd());
    const global = deps?.globalRoot ?? globalKbRoot(process.env['DIY_HOME'], homedir());

    const sectionsOf = (subject: string, maxChars: number) => [
        ...briefOf(project, subject, maxChars).map((item) => ({ ...item, scope: 'project' as const })),
        ...(existsSync(global)
            ? briefOf(global, subject, maxChars).map((item) => ({ ...item, scope: 'global' as const }))
            : []),
    ];

    return {
        facts: {
            brief: ({ input }) => {
                const maxChars = input.maxChars ?? 80;
                const items = input.subject
                    .split(',')
                    .map((subject) => subject.trim())
                    .filter((subject) => subject !== '')
                    .flatMap((subject) => {
                        const projectHits = sectionsOf(subject, maxChars).filter((item) => item.scope === 'project');
                        // 项目库有这个主题就以项目库为准（与注入器「同名取项目那份」同判据）
                        if (projectHits.length > 0) return projectHits;
                        return sectionsOf(subject, maxChars);
                    });
                return { items };
            },
            get: ({ input }) => {
                const fromProject = getSection(project, input.claim);
                if (fromProject !== null) return { ...fromProject, scope: 'project' as const };
                const fromGlobal = existsSync(global) ? getSection(global, input.claim) : null;
                if (fromGlobal !== null) return { ...fromGlobal, scope: 'global' as const };
                throw new Error(`没找到：${input.claim}（知识库：${project}）`);
            },
            find: ({ input }) => {
                const words = input.keywords
                    .split(',')
                    .map((word) => word.trim())
                    .filter((word) => word !== '');
                const limit = input.limit ?? 50;
                const projectHits = findIn(project, words, limit).map((hit) => ({ ...hit, scope: 'project' as const }));
                const seen = new Set(projectHits.map((hit) => `${hit.path}#${hit.section}`));
                const globalHits = existsSync(global)
                    ? findIn(global, words, limit)
                          .filter((hit) => !seen.has(`${hit.path}#${hit.section}`))
                          .map((hit) => ({ ...hit, scope: 'global' as const }))
                    : [];
                return { hits: [...projectHits, ...globalHits].slice(0, limit) };
            },
            status: () => ({ project: statsOf(project), global: statsOf(global) }),
        },
    };
}
