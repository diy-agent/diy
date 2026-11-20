// system-context.ts —— 房间 agent 的**规则上下文**：走 @diy-agent/context 的会话门面。
//
// 为什么不再手拼字符串（2026-11-20）：diy2 之前只有「你是 X」+ persona + 工具提示，
// 规则（worktree / GPG / 验证入口）一条都进不来。上一版（#503）把 chain + kb 拼成一个
// system 字符串 —— 能看见规则，但**没有变量树**：任务正文、status 一变只能重建 system
// （前缀缓存全废），也没法做增量 / diff。
//
// 现在：provider 提供**结构化值**，`createContextSession` 负责 system 快照与 user 增量。
// 这一步是任务接入（body / status / journal / docs）的前置。
//
// 三条判据（与 diy-app / bot 同口径）：
//   · 链从 cwd 爬到 `$HOME`（不进 `/`、不进 `/Users`）；外层在前、最深处最特化
//   · `<home>/AGENTS.md`（应用级）在链首；home 不传 = 没有应用级规范
//   · 知识库只投索引（路径 + desc + 节数），正文按需 `diy2 facts get`

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { agentsChain } from '@diy-agent/agents-chain';
import {
    AssembleGlobalsSchema,
    createContextSession,
    type ContextProvider,
    type ContextSession,
} from '@diy-agent/context';
import { globalKbRoot, kbRootOf, scanKb } from '@diy-agent/kb';
import { skillsOf } from '@diy-agent/skills';
import { localISOString } from '@diy-agent/time';

import type { JournalEntry } from './db';

/** 房间上下文需要的 spec 形状（只读；与 `Room` 结构兼容） */
export interface RoomContextSpec {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly data: Record<string, unknown>;
}

export interface RoomContextOptions {
    readonly spec: RoomContextSpec;
    /** 房间的工作目录（`data.dir`） */
    readonly cwd: string;
    /** 应用数据根（diy2 = `DIY2_HOME`）：应用级 AGENTS.md + 设备级知识库 */
    readonly home?: string;
    /** 全局 skills 根；缺省 `~/.agents`（测试可指向临时目录） */
    readonly skillsRoot?: string;
    /** 任务日志（append-only）：由宿主给取数函数；不传 = 不投 journal 节 */
    readonly journal?: () => readonly JournalEntry[];
}

/** 知识库索引（项目优先、设备兜底；形状与 `AssembleGlobalsSchema.kb` 一致） */
function kbProvider(cwd: string, home: string | undefined): ContextProvider {
    return {
        key: 'kb',
        provide: () => {
            const global = globalKbRoot(process.env['DIY_HOME'], homedir());
            const project = kbRootOf(cwd);
            const roots: { dir: string; scope: 'project' | 'global' }[] = [];
            if (resolve(project) !== resolve(global)) roots.push({ dir: project, scope: 'project' });
            if (home !== undefined) roots.push({ dir: global, scope: 'global' });

            const byPath = new Map<
                string,
                { path: string; desc: string; sections: number; scope: 'project' | 'global' }
            >();
            for (const root of roots) {
                for (const entry of scanKb(root.dir).entries) {
                    if (root.scope === 'global' && byPath.has(entry.path)) continue;
                    byPath.set(entry.path, {
                        path: entry.path,
                        // 索引只要「这个文件讲什么」；完整 desc 用 `diy2 facts brief` 取
                        desc: entry.desc.length <= 80 ? entry.desc : `${entry.desc.slice(0, 79)}…`,
                        sections: entry.sections,
                        scope: root.scope,
                    });
                }
            }
            const entries = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
            return entries.length === 0 ? undefined : { entries };
        },
    };
}

/** 递归收集 `*.md`（跳过 `.` 开头的目录；`depth` 限制层数） */
function mdFiles(dir: string, depth = Number.POSITIVE_INFINITY): string[] {
    const out: string[] = [];
    const walk = (at: string, left: number): void => {
        let names: string[];
        try {
            names = readdirSync(at);
        } catch {
            return;
        }
        for (const name of names) {
            if (name.startsWith('.')) continue;
            const full = join(at, name);
            let stat;
            try {
                stat = statSync(full);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                if (left > 0) walk(full, left - 1);
                continue;
            }
            if (name.endsWith('.md')) out.push(full);
        }
    };
    walk(dir, depth);
    return out;
}

/** 仓库文档索引（摘要）：`docs/plans` 优先；没有则退回 `docs/` 顶层 */
function docsProvider(cwd: string): ContextProvider {
    return {
        key: 'docs',
        provide: () => {
            let roots = ['docs/plans'];
            let files = mdFiles(join(cwd, 'docs', 'plans'));
            if (files.length === 0) {
                roots = ['docs'];
                files = mdFiles(join(cwd, 'docs'), 1);
            }
            if (files.length === 0) return undefined;
            let newest = '';
            for (const file of files) {
                try {
                    const key = localISOString(new Date(statSync(file).mtimeMs)).slice(2, 10);
                    if (key > newest) newest = key;
                } catch {
                    /* 读不到就跳过 */
                }
            }
            return { roots, count: files.length, ...(newest === '' ? {} : { newest }) };
        },
    };
}

/** 任务日志（append-only）：宿主给取数函数；空 = 整节缺席 */
function journalProvider(get?: () => readonly JournalEntry[]): ContextProvider {
    return {
        key: 'journal',
        provide: () => {
            const entries = get?.() ?? [];
            if (entries.length === 0) return undefined;
            return {
                entries: entries.map((entry) => ({
                    at: localISOString(new Date(entry.at)),
                    kind: entry.kind,
                    text: entry.text,
                })),
            };
        },
    };
}

function taskProvider(spec: RoomContextSpec, cwd: string): ContextProvider {
    return {
        key: 'task',
        provide: () => {
            if (spec.type !== 'task') return undefined;
            const data = spec.data;
            const str = (key: string): string => (typeof data[key] === 'string' ? (data[key] as string) : '');
            const desc = str('desc');
            const body = str('body');
            return {
                uri: spec.id,
                title: spec.name,
                state: str('status') || 'open',
                parent: str('parent'),
                created: str('created'),
                updated: str('updated'),
                change_type: str('changeType'),
                module: str('module'),
                priority: str('priority'),
                persona: str('persona'),
                // 描述是任务简报；正文是任务本体。两者都有就分行拼，模型读到的是一段完整简报
                body: [desc, body].filter((part) => part.trim() !== '').join('\n\n'),
                dir: str('dir') || cwd,
            };
        },
    };
}

/** 房间 provider 集：diy / cwd / chain / skills / kb / task（task 仅 task 房间） */
export function roomProviders(opts: RoomContextOptions): ContextProvider[] {
    const appHome = opts.home ?? join(opts.cwd, '__no_app__');
    const skillsRoot = opts.skillsRoot ?? join(homedir(), '.agents');
    return [
        {
            key: 'diy',
            provide: () => ({ cli: 'diy2', home: opts.home ?? '' }),
        },
        {
            key: 'cwd',
            provide: () => ({
                path: opts.cwd,
                note: '',
                isFallback: false,
                isTaskDir: opts.spec.type === 'task',
                isAppDir: false,
            }),
        },
        {
            key: 'chain',
            provide: () =>
                agentsChain({ appHome, cwd: opts.cwd }).map((item) => ({
                    path: item.path,
                    scope: item.scope,
                    content: item.content,
                })),
        },
        {
            key: 'skills',
            provide: () =>
                skillsOf({ cwd: opts.cwd, globalRoot: skillsRoot }).map(({ name, desc }) => ({
                    name,
                    // 技能说明动辄几百字；索引只需要「有哪些 + 一句干什么」
                    desc: desc.length <= 120 ? desc : `${desc.slice(0, 119)}…`,
                })),
        },
        kbProvider(opts.cwd, opts.home),
        docsProvider(opts.cwd),
        journalProvider(opts.journal),
        taskProvider(opts.spec, opts.cwd),
    ];
}

/** 一个房间成员的上下文会话（system 快照 + 每轮增量；每个 bot 各一份 cursor） */
export function createRoomContext(opts: RoomContextOptions): ContextSession {
    return createContextSession({ providers: roomProviders(opts), schema: AssembleGlobalsSchema });
}

/** 兼容入口（#503 的测试与旧调用点）：只按 cwd/home 组装一次 system，不带任务 */
export function buildRoomSystemContext(opts: { cwd: string; home?: string }): string {
    const session = createRoomContext({
        spec: { id: '', name: '', type: 'project', data: {} },
        cwd: opts.cwd,
        ...(opts.home === undefined ? {} : { home: opts.home }),
    });
    return session.open().system;
}
