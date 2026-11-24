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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { agentsChain } from '@diy-agent/agents-chain';
import {
    AssembleGlobalsSchema,
    createContextSession,
    type ContextProvider,
    type ContextSession,
} from '@diy-agent/context';
import { foldKbIndex, globalKbRoot, kbRootOf, scanKb } from '@diy-agent/kb';
import { skillsOf } from '@diy-agent/skills';
import { localISOString } from '@diy-agent/time';

import type { JournalEntry } from './db';
import type { UnitBoard } from './units';
import { watchedValue } from './watch-cache';

/** 房间上下文需要的 spec 形状（只读；与 `Room` 结构兼容） */
export interface RoomContextSpec {
    readonly id: string;
    readonly type: string;
    /** 类型特有数据：容器的名字也在这里（task → `title`，project → `name`） */
    readonly data: Record<string, unknown>;
}

/**
 * 容器名：房间自己没有名字，名字跟着容器走（2026-11-22 裁，见 protocol 的 Room）。
 * task 用 `data.title`、project 用 `data.name`；都没有才退 id（插件容器可能不取名）。
 */
function containerName(spec: RoomContextSpec): string {
    const text = (key: string): string => (typeof spec.data[key] === 'string' ? (spec.data[key] as string).trim() : '');
    return text('title') || text('name') || spec.id;
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
    /** 任务内部的拆分图（unit DAG）：宿主给取数函数；不传 = 不投 units 节 */
    readonly units?: () => UnitBoard;
    /** 房间成员（@ 键 / 是否主人格）：不传 = 不投 room 节 */
    readonly members?: () => readonly { id: string; name: string; key: string; main: boolean }[];
}

/** 知识库索引（项目优先、设备兜底；形状与 `AssembleGlobalsSchema.kb` 一致） */
function kbProvider(cwd: string, home: string | undefined): ContextProvider {
    const global = globalKbRoot(process.env['DIY_HOME'], homedir());
    const project = kbRootOf(cwd);
    const roots: { dir: string; scope: 'project' | 'global' }[] = [];
    if (resolve(project) !== resolve(global)) roots.push({ dir: project, scope: 'project' });
    if (home !== undefined) roots.push({ dir: global, scope: 'global' });

    const compute = ():
        | { entries: Array<{ path: string; desc: string; sections: number; scope: 'project' | 'global' }> }
        | undefined => {
        const byPath = new Map<string, { path: string; desc: string; sections: number; scope: 'project' | 'global' }>();
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
        // 按目录折叠（##404 减负）：每轮固定前缀按文件平铺会随迁移线性涨，折叠只损失「逐文件 desc」。
        // `showNames: 0` = 目录级（只给「N 个文件」，不给名字）：一个任务只碰 1~2 个目录，
        // 逐目录列名字是白付的；要文件名就 `diy2 facts brief <目录>`。
        const entries = foldKbIndex([...byPath.values()], { showNames: 0 });
        return entries.length === 0 ? undefined : { entries };
    };

    const cached = watchedValue(
        `kb:${roots.map((root) => `${root.scope}:${root.dir}`).join('|')}`,
        roots.map((root) => root.dir),
        compute,
        { recursive: true },
    );
    return { key: 'kb', provide: () => cached() };
}

/** 从 cwd 到 `$HOME`（含）的目录；cwd 不在 home 下时只取自己 */
function ancestorDirs(from: string): string[] {
    const out: string[] = [];
    const home = resolve(homedir());
    let at = resolve(from);
    const underHome = at === home || at.startsWith(home + sep);
    for (;;) {
        out.push(at);
        if (!underHome || at === home) break;
        const parent = resolve(at, '..');
        if (parent === at) break;
        at = parent;
    }
    return out;
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

/** 文档标题：首个 `# ` 行；没有就用文件名 */
function titleOf(file: string): string {
    try {
        const text = readFileSync(file, 'utf-8');
        const match = /^#\s+(.+)$/m.exec(text);
        if (match !== null) return match[1]!.trim();
    } catch {
        /* 读不到就用文件名 */
    }
    return file.split('/').pop()?.replace(/\.md$/, '') ?? file;
}

/** 仓库文档索引（摘要 + 惰性索引）：`docs/plans` 优先；没有则退回 `docs/` 顶层 */
function docsProvider(cwd: string): ContextProvider {
    const plans = join(cwd, 'docs', 'plans');
    const docs = join(cwd, 'docs');
    const compute = ():
        | {
              roots: string[];
              count: number;
              entries: Array<{ path: string; title: string }>;
              newest?: string;
          }
        | undefined => {
        let roots = ['docs/plans'];
        let files = mdFiles(plans);
        if (files.length === 0) {
            roots = ['docs'];
            files = mdFiles(docs, 1);
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
        const entries = files
            .map((file) => ({
                path: relative(cwd, file).split(sep).join('/'),
                title: titleOf(file),
            }))
            .sort((a, b) => a.path.localeCompare(b.path));
        return { roots, count: files.length, entries, ...(newest === '' ? {} : { newest }) };
    };

    const cached = watchedValue(`docs:${cwd}`, [plans, docs], compute, { recursive: true });
    return { key: 'docs', provide: () => cached() };
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

/**
 * 任务拆分图（unit DAG）。**全量注入**（2026-11-24 用户裁：先简单走）——
 * 于是「现在能做哪几条」不需要多一次工具调用，代价是图越长上下文越贵。
 *
 * ⚠️ 溢出线：>40 个 unit 或本节 >1.5 KB 时必须改成摘要（只给 ready + 计数，全图靠
 * `unit_list` 按需查）。全量是阶段一的省事，不是终态。
 */
function unitsProvider(get?: () => UnitBoard): ContextProvider {
    return {
        key: 'units',
        provide: () => {
            const board = get?.();
            if (board === undefined || board.rows.length === 0) return undefined;
            const ref = (id: string) => {
                const row = board.rows.find((item) => item.id === id);
                return { id, title: row?.title ?? '', deps: row?.deps ?? [] };
            };
            return {
                ready: board.ready.map(ref),
                doing: board.doing.map(ref),
                blocked: board.blocked.map(ref),
                layers: board.layers.map((layer) =>
                    layer.map((row) => ({ id: row.id, title: row.title, deps: row.deps, status: row.status })),
                ),
            };
        },
    };
}

/** 房间成员（低频）：模型要 @ 谁，得先知道房里有什么名字 */
function roomProvider(opts: RoomContextOptions): ContextProvider {
    return {
        key: 'room',
        provide: () => {
            const list = opts.members?.() ?? [];
            if (list.length === 0) return undefined;
            return {
                members: {
                    roomId: opts.spec.id,
                    name: containerName(opts.spec),
                    list: list.map((member) => ({
                        id: member.id,
                        name: member.name,
                        key: member.key,
                        main: member.main,
                    })),
                },
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
                // 标题与描述合并前的任务只落了 `desc`：标题取不到时用它兜底，
                // 否则模型看到的任务没有名字（老数据不迁，读的地方兜住）
                title: str('title') || desc,
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
    const chainDirs = ancestorDirs(opts.cwd);
    if (!chainDirs.includes(resolve(appHome))) chainDirs.push(resolve(appHome));
    const chainValue = watchedValue(
        `chain:${opts.cwd}:${appHome}`,
        chainDirs,
        () =>
            agentsChain({ appHome, cwd: opts.cwd }).map((item) => ({
                path: item.path,
                scope: item.scope,
                content: item.content,
            })),
        { recursive: false },
    );
    const skillsValue = watchedValue(
        `skills:${opts.cwd}:${skillsRoot}`,
        [join(skillsRoot, 'skills'), join(opts.cwd, '.agents', 'skills')],
        () =>
            skillsOf({ cwd: opts.cwd, globalRoot: skillsRoot }).map(({ name, desc }) => ({
                name,
                // 技能说明动辄几百字；索引只需要「有哪些 + 一句干什么」
                desc: desc.length <= 120 ? desc : `${desc.slice(0, 119)}…`,
            })),
        { recursive: true },
    );
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
            provide: () => chainValue(),
        },
        {
            key: 'skills',
            provide: () => skillsValue(),
        },
        kbProvider(opts.cwd, opts.home),
        docsProvider(opts.cwd),
        roomProvider(opts),
        journalProvider(opts.journal),
        unitsProvider(opts.units),
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
        spec: { id: '', type: 'project', data: {} },
        cwd: opts.cwd,
        ...(opts.home === undefined ? {} : { home: opts.home }),
    });
    return session.open().system;
}
