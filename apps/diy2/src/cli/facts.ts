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

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

const KbOverlap = z.object({
    same: z.number(),
    differs: z.array(z.object({ path: z.string(), projectBytes: z.number(), globalBytes: z.number() })),
});

const KbStats = z.object({
    root: z.string(),
    exists: z.boolean(),
    entries: z.number(),
    sections: z.number(),
    bytes: z.number(),
    problems: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })),
});

/**
 * 项目库根：`kbRootOf(cwd)` 会一路走到 `$HOME` —— cwd 在任何用户目录下都会撞上
 * `~/.diy/knowledge`，那是**设备级库**，不是项目库。所以「与 global 同路径」时
 * 按「没有项目库」处理（给一个不存在的路径，scanKb 自然返回空）。
 */
function projectRootOf(global: string): string {
    const found = kbRootOf(process.cwd());
    return resolve(found) === resolve(global) ? join(process.cwd(), '.diy', 'knowledge') : found;
}

/**
 * 两库同名文件的比对：内容逐字节相同 = 镜像（可消除），不同 = 漂移（必须显式）。
 *
 * 为什么要这项：取值侧是「项目库优先、设备级库兵库」，同 path 两份内容不同时
 * **静默取项目那份** —— 知识库改错了也收不到任何信号。镜像副本同理：靠人工保
 * 持两份一致早晚会分叉，分叉后又没人知道到底用哪份。
 */
function overlapOf(project: string, global: string) {
    const empty = { same: 0, differs: [] as Array<{ path: string; projectBytes: number; globalBytes: number }> };
    if (!existsSync(project) || !existsSync(global)) return empty;
    const projectEntries = new Map(scanKb(project).entries.map((entry) => [entry.path, entry]));
    const differs: Array<{ path: string; projectBytes: number; globalBytes: number }> = [];
    let same = 0;
    for (const entry of scanKb(global).entries) {
        const hit = projectEntries.get(entry.path);
        if (hit === undefined) continue;
        if (readFileSync(join(project, entry.path)).equals(readFileSync(join(global, entry.path)))) same += 1;
        else differs.push({ path: entry.path, projectBytes: hit.bytes, globalBytes: entry.bytes });
    }
    return { same, differs: differs.sort((a, b) => a.path.localeCompare(b.path)) };
}

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
                    desc:
                        `体检：条目 / 小节 / 字节数 + 问题清单（项目库与设备级库分列）` +
                        `\n\n同时比对**两库同名文件**：逐字节相同 = 镜像副本（应消除，否则迟早分叉），` +
                        `不同 = 漂移（取值时静默取项目那份，漂移不可见）→ 列在 \`overlap.differs\`。`,
                    input: {},
                    output: z.object({ project: KbStats, global: KbStats, overlap: KbOverlap }),
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
        status: () => {
            project: ReturnType<typeof statsOf>;
            global: ReturnType<typeof statsOf>;
            overlap: ReturnType<typeof overlapOf>;
        };
    };
} {
    const global = deps?.globalRoot ?? globalKbRoot(process.env['DIY_HOME'], homedir());
    const project = deps?.projectRoot ?? projectRootOf(global);

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
                // 两库按 **path** 合并（项目那份胜出，与 kbProvider / get 同判据）。
                // 不再按 subject 短路：短路判据是「项目库该主题有没有条目」，项目库只剩
                // 一个文件也会把设备库同主题的其余文件整块蒙住（`rule/` 只剩 `dev.md`
                // 时，`rule/rule.md` 这类通用硬约束就查不到了）。
                //
                // byPath 跨 subject 共用：`brief rule,rule/dev` 里前者已含 `rule/dev.md`，
                // 逐个 subject 各自去重会让同一 path 出两次（顺序 = subject 序 + 首次出现序）。
                const byPath = new Map<string, ReturnType<typeof sectionsOf>[number]>();
                for (const subject of input.subject
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s !== '')) {
                    for (const item of sectionsOf(subject, maxChars)) {
                        if (!byPath.has(item.path)) byPath.set(item.path, item);
                    }
                }
                return { items: [...byPath.values()] };
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
            status: () => ({ project: statsOf(project), global: statsOf(global), overlap: overlapOf(project, global) }),
        },
    };
}
