// migrate-mode.ts —— 「库还没迁完」时主 app 的形态。
//
// 为什么需要它（用户 2026-11-27 裁定：迁移页并进主 app 当路由，不再单开一个端口）：
//
//   `createDiy2App()` 一上手就 `openStore()`，而 `openStore()` 里迁移是**同步**跑的
//   （node:sqlite 的 DatabaseSync）。所以如果照常装配，页面还没渲染、迁移已经跑完了 ——
//   「/migrate 路由」就变成事后回顾。
//
// 于是进程起来先做一件很便宜的事：**只读**探一下库的版本（不打开 store、不改库）。
// 有待迁移就装配成这个「迁移态」app —— 只服务迁移页和三个接口；迁完再由入口换成真 app。
// 同一个端口、同一个 app，只是先站在门口。
//
// 迁移本身仍在**子进程**里跑：同步迁移会卡住事件循环，SSE 就推不出去了
// （这也是原来那套单独服务器 s 为什么 spawn worker，原因不变）。

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';

import {
    MIGRATION_STEPS,
    checksumDrift,
    migrationPlan,
    migrationVersion,
    missingMigrations,
} from '@diy-agent/migration';

import type { Diy2Config } from './config';
import { createStaticHandler } from './static';

/** 这个库里还有没有要做的事（**只读**，不会改库） */
export interface MigrationProbe {
    /** 已记账多少条迁移（只数代码里认得的） */
    applied: number;
    /** 一共多少条 */
    total: number;
    /** 还有待迁移的项吗（**按版本表**：代码里有、库里没记账的 id） */
    pending: boolean;
    /** 还差哪几条（id）；pending 为 false 时是空数组 */
    missing: string[];
    /** 库里记了、代码里没有的 id（跑过别的分支留下的，不是待迁移） */
    unknown: string[];
    /** 跑过之后文件又被改了的迁移 id（Flyway 式 checksum；不是待迁移，只是改了不生效） */
    drift: string[];
}

/**
 * 只读探一下：库是什么版本、还差什么。
 *
 * 绝不能用 `openStore()` —— 那会当场把库改了，「先给用户看一眼再决定」就无从谈起。
 *
 * **判据是版本表，不是 `done()`**（2026-11-27 改）：
 * 以前写的是 `migrationPlan(db).some(item => !item.done)`。后果是「数据长得不像迁过了」也算待迁移，
 * 于是老库每次启动都落回迁移页，而点「开始迁移」又被 run() 跳过（已记账的不重跑）—— 人真卡死。
 * 两者分工：**版本表决定「要不要拦启动」，`done()` 只用于 run() 的基线判断。**
 */
export function probeMigration(dbPath: string): MigrationProbe {
    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const version = migrationVersion(db);
        const missing = missingMigrations(db);
        return {
            applied: version.applied,
            total: version.total,
            pending: missing.length > 0,
            missing,
            unknown: version.unknown,
            drift: checksumDrift(db).map((item) => item.id),
        };
    } catch {
        // 打不开（还没建库 / 权限不对）→ 交给真 app 去报错，这里不抢戏
        return { applied: 0, total: MIGRATION_STEPS.length, pending: false, missing: [], unknown: [], drift: [] };
    } finally {
        db?.close();
    }
}

/** 迁移页要的全部数据（一次给够，省得页面回来问第二遍） */
function stateOf(dbPath: string): Record<string, unknown> {
    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        return {
            version: migrationVersion(db),
            // 计划项原样给出（含 `recorded` 与 `done` 两个字段）——
            // 页面用 `recorded` 判「待迁移」，用 `done` 显示「旧资源还在不在」
            plan: migrationPlan(db),
            steps: MIGRATION_STEPS,
            // 指纹对不上 = 迁移跑过之后文件被改过（已迁的库不会重放它，改了等于没改）
            drift: checksumDrift(db),
        };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    } finally {
        db?.close();
    }
}

function json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
}

const WORKER_TS = join(import.meta.dirname, 'migrate-worker.ts');
const ENTRY_MJS = join(import.meta.dirname, 'index.mjs');

/** 往上找 `node_modules/.bin/tsx`（开发时它在仓根；不要在产物目录里假设相对深度） */
function resolveTsx(start: string): string {
    let dir = start;
    for (let depth = 0; depth < 6; depth += 1) {
        const candidate = join(dir, 'node_modules/.bin/tsx');
        // sync-io-ok: 只在「点开始迁移」那一下 spawn 前探一次路径，不在请求/事件流热路径上
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return join(start, 'node_modules/.bin/tsx');
}

/**
 * 起迁移子进程。
 *
 * 两种形态（见 ./migrate-worker.ts 文件头）：
 *  - 源码态：旁边有 `migrate-worker.ts` → `tsx` 跑它（dev / staging 从源码起）；
 *  - 产物态：只有 `index.mjs` → `node index.mjs --migrate-worker <db>`。
 *
 * 以前只写死了第一种，发布版里 tsx 与 .ts 都不存在 → spawn ENOENT，
 * 而页面那一下正等着进度，人看到的是「点了没反应」（2026-11-27 实测）。
 */
function spawnWorker(dbPath: string): ChildProcess {
    // sync-io-ok: 同上 —— 一次性决定「源码态用 tsx 还是产物态用 node」，紧随其后就 spawn
    if (existsSync(WORKER_TS)) {
        return spawn(resolveTsx(import.meta.dirname), [WORKER_TS, dbPath], {
            cwd: import.meta.dirname,
            env: process.env,
        });
    }
    // Electron 里 process.execPath 是 Electron 本体，要显式降级成 node 语义
    const env = process.versions.electron === undefined ? process.env : { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    return spawn(process.execPath, [ENTRY_MJS, '--migrate-worker', dbPath], { cwd: import.meta.dirname, env });
}

/**
 * 「迁移态」app：只服务迁移页与它的三个接口。
 *
 * @param onDone 迁移子进程正常结束回调 —— 入口在这里换成真 app（同一个 server，不换端口）
 */
export async function createMigrateModeApp(opts: {
    config: Diy2Config;
    port: () => number | null;
    onDone: () => Promise<void>;
    /** `/api/info` 的回包：外层靠它判「这个端口是不是我的实例」，迁移态也得答 */
    info: () => unknown;
}): Promise<{
    handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    close: () => void;
}> {
    const dbPath = opts.config.dbPath;
    const serveStatic = await createStaticHandler(opts.config.webDir ?? undefined);
    const clients = new Set<ServerResponse>();
    let running = false;
    /**
     * 迁移开始前拍一张状态快照。
     *
     * 迁移**在跑**时不再开库回答状态：每次 `readOnly` 开会与子进程的写事务抢锁，
     * 把几百毫秒的迁移拖成「看不出进展」（2026-11-27 e2e 实测：300ms 轮询 → 卡在 8/18）。
     * 跑的时候计划本来就在变（进度走 SSE），页面要的数据是「开始前的计划 + 进度事件」。
     */
    const snapshot: Record<string, unknown> = { mode: 'migrate', ...stateOf(dbPath) };

    const broadcast = (payload: unknown): void => {
        const frame = `data: ${JSON.stringify(payload)}\n\n`;
        for (const client of clients) {
            try {
                client.write(frame);
            } catch {
                clients.delete(client);
            }
        }
    };

    const start = (): void => {
        if (running) {
            broadcast({ kind: 'error', message: '已经在跑了（一次只能跑一个）' });
            return;
        }
        running = true;
        broadcast({ kind: 'started', at: Date.now() });
        // 子进程怎么起看形态（源码 / 产物），逻辑见 spawnWorker
        const child = spawnWorker(dbPath);

        let buffered = '';
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            buffered += chunk;
            let index = buffered.indexOf('\n');
            while (index >= 0) {
                const line = buffered.slice(0, index);
                buffered = buffered.slice(index + 1);
                index = buffered.indexOf('\n');
                if (!line.startsWith('@@')) {
                    if (line.trim() !== '') broadcast({ kind: 'log', text: line });
                    continue;
                }
                try {
                    broadcast(JSON.parse(line.slice(2)) as unknown);
                } catch {
                    broadcast({ kind: 'log', text: line });
                }
            }
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => broadcast({ kind: 'stderr', text: chunk }));
        // spawn 失败不能把进程打死 —— 那正是人盯着页面的时候，要变成页面上的一行红字
        child.on('error', (error: Error) => {
            running = false;
            broadcast({ kind: 'error', message: `起不了迁移进程：${error.message}` });
        });
        child.on('close', (code) => {
            running = false;
            broadcast({ kind: 'closed', code });
            if (code === 0) {
                // 迁完了：入口去装配真 app，然后把这一页的客户端都叫去刷新
                void opts.onDone().then(() => broadcast({ kind: 'ready', url: '/' }));
            }
        });
    };

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        try {
            // `/api/info` 必须照常答：外层靠它判「这个端口是不是我的实例」
            if (req.method === 'GET' && url.pathname === '/api/info') {
                json(res, 200, opts.info());
                return;
            }

            if (url.pathname === '/api/migrate/state') {
                json(res, 200, running ? { ...snapshot, running: true } : snapshot);
                return;
            }
            if (url.pathname === '/api/migrate/events') {
                res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-store',
                    connection: 'keep-alive',
                });
                res.write(': connected\n\n');
                clients.add(res);
                req.on('close', () => clients.delete(res));
                return;
            }
            if (url.pathname === '/api/migrate/start' && req.method === 'POST') {
                start();
                json(res, 202, { ok: true });
                return;
            }
            // 其余 API 一律拒：库还没迁完，读什么都是错的
            if (url.pathname.startsWith('/api')) {
                json(res, 503, { error: '库还没迁移完', mode: 'migrate' });
                return;
            }
            // 页面本体照常由 SPA 产物提供；UI 看到 mode=migrate 就渲染迁移屏
            if (req.method === 'GET' && serveStatic !== undefined) {
                if (await serveStatic(url.pathname, res)) return;
            }
            json(res, 404, { error: `unknown ${req.method ?? '?'} ${url.pathname}` });
        } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
    };

    return {
        handle,
        close: (): void => {
            for (const client of clients) {
                try {
                    client.end();
                } catch {
                    /* 已经断了 */
                }
            }
            clients.clear();
        },
    };
}
