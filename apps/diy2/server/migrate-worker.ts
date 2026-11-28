// migrate-worker.ts —— 在一个**子进程**里跑迁移，把每一步用 JSON 行报到 stdout。
//
// 为什么必须单开进程：`openStore()` 里的迁移是同步的（node:sqlite 的 DatabaseSync），
// 208M 的老库折 bots 会卡住事件循环。跑在同一个进程里的话，迁移页会在「开始」之后整段不刷新 ——
// 人看到的是「点了没反应」，而那正是最需要看见进度的时候。
//
// 协议：每一行 `@@<json>`。前缀是给父进程分流用的（父进程还要转发子进程自己的报错）。
//
// 两种跑法（逻辑只有一份，入口由 `runMigrationWorker` 收口）：
//   - 开发：`tsx migrate-worker.ts <db>`（本文件直接执行，见文件末尾）
//   - 生产：产物只有 index.mjs 一个文件，所以复用入口 —— `node index.mjs --migrate-worker <db>`
//     （见 ./index.ts 顶部的标志分支）。以前这里假设生产也能 spawn tsx + .ts，
//     结果发布产物里两者都不存在，迁移页永远起不了子进程（2026-11-27 实测）。
//
// 2026-11-28 起它不只跑 schema 迁移：几条**数据迁移**（工具输出外置）也在这里跑，所以
// 这个进程同时负责迁移前**自动备份**、迁移后**校验**与 **VACUUM** —— 三者都必须独占库，
// 而且任何一步失败都要停在原地（页面看得见），不能带着半迁移的库启动。

import { copyFileSync, existsSync, readdirSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join } from 'node:path';

import { MIGRATION_STEPS, openStore, toolOutputOffloadPlan, type MigrationStepEvent } from '@diy-agent/entity-runtime';

const MARK = '@@';

/** index.mjs 复用入口时的标志：命中就当迁移子进程跑，不再正常启动 */
export const MIGRATE_WORKER_FLAG = '--migrate-worker';

/** 自动备份保留几份（只删本进程起的 `bak-migrate-*`，不碰历史手工备份） */
const KEEP_BACKUPS = 3;
/** 空闲页超过这个量才 VACUUM（小库、刚建库不值得停一下做全量重写） */
const VACUUM_MIN_BYTES = 8 * 1024 * 1024;

function emit(payload: unknown): void {
    process.stdout.write(`${MARK}${JSON.stringify(payload)}\n`);
}

function log(text: string): void {
    emit({ kind: 'log', text });
}

function countOf(store: ReturnType<typeof openStore>, table: string): number {
    try {
        return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } catch {
        return -1;
    }
}

/** 迁移前备份：`<db>.bak-migrate-<YYYYMMDD-HHMMSS>`；空间不够就不开始（宁可不动库） */
function backupBeforeMigrate(dbPath: string): string | undefined {
    // 本文件整个跑在**独立子进程**里、按顺序执行迁移（父进程靠 stdout 的 `@@<json>` 看进度），
    // 没有要护的事件循环 —— 这里同步反而正是设计要求（见文件头）。
    // sync-io-ok: 迁移子进程独占库、顺序执行，无事件循环要护
    if (!existsSync(dbPath)) return undefined; // 新库：没有可备份的东西
    // sync-io-ok: 迁移子进程独占库、顺序执行，无事件循环要护
    const bytes = statSync(dbPath).size;
    try {
        const stat = statfsSync(dirname(dbPath));
        const free = Number(stat.bavail) * Number(stat.bsize);
        // 备份 + VACUUM 的临时文件，最坏要再放下一整份库
        if (free < bytes * 2.1) {
            throw new Error(
                `磁盘不足：需要约 ${String(Math.ceil((bytes * 2.1) / 1048576))}MB，剩余 ${String(
                    Math.floor(free / 1048576),
                )}MB`,
            );
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('磁盘不足')) throw error;
        // statfs 不可用不拦（保守放行：备份失败会自己报错）
    }
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    // 本地时间（备份文件名是给人看的；UTC 会让人对不上「我刚才什么时候点的」）
    const stamp =
        `${String(d.getFullYear())}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const target = `${dbPath}.bak-migrate-${stamp}`;
    // sync-io-ok: 同上（迁移子进程、顺序执行、独占库）
    copyFileSync(dbPath, target);
    log(`已备份：${basename(target)}（${(bytes / 1048576).toFixed(1)}MB）`);
    pruneBackups(dbPath);
    return target;
}

function pruneBackups(dbPath: string): void {
    try {
        const dir = dirname(dbPath);
        const prefix = `${basename(dbPath)}.bak-migrate-`;
        // sync-io-ok: 同上（迁移子进程的旁路清理）
        const old = readdirSync(dir)
            .filter((name) => name.startsWith(prefix))
            .sort()
            .reverse()
            .slice(KEEP_BACKUPS);
        // sync-io-ok: 同上（迁移子进程的旁路清理）
        for (const name of old) unlinkSync(join(dir, name));
    } catch {
        /* 备份清理是旁路，失败不影响迁移 */
    }
}

/**
 * 迁移后校验：没有漏搬的条目；每条引用的文件在、字节数与条目一致。
 *
 * 两类问题分开处置：
 *   · **还有 >64KB 的正文没搬** ⇒ 硬失败（迁移本身没做完，不能假装迁过）；
 *   · **引用文件缺失 / 字节对不上** ⇒ 只报警告（历史文件可能是在副本上演练时没拷过来，
 *     或早就被人删了 —— 它不改变「迁移已完成」这个事实，没有理由把人拦在迁移页）。
 */
function verifyOffload(store: ReturnType<typeof openStore>, dbPath: string): { ok: string; missing: string[] } {
    const left = toolOutputOffloadPlan(store.db);
    if (left.rows > 0) throw new Error(`外置校验失败：还有 ${String(left.rows)} 条 >64KB 的正文没搬走`);
    const rows = store.db
        .prepare('SELECT item FROM entity_items WHERE item LIKE \'%"output":{"ref"%\'')
        .all() as Array<{ item: string }>;
    let checked = 0;
    const missing: string[] = [];
    for (const row of rows) {
        let ref: { ref?: unknown; bytes?: unknown } | undefined;
        try {
            ref = (JSON.parse(row.item) as { data?: { output?: { ref?: unknown; bytes?: unknown } } }).data?.output;
        } catch {
            continue;
        }
        if (ref === undefined || typeof ref.ref !== 'string') continue;
        const file = join(dirname(dbPath), ref.ref);
        // sync-io-ok: 同上（迁移子进程，校验外置引用大小）
        if (!existsSync(file)) {
            missing.push(ref.ref);
            continue;
        }
        // sync-io-ok: 同上
        const size = statSync(file).size;
        if (typeof ref.bytes === 'number' && size !== Number(ref.bytes)) {
            missing.push(`${ref.ref}（大小 ${String(size)} ≠ 记录 ${String(ref.bytes)}）`);
            continue;
        }
        checked += 1;
    }
    return { ok: checked === 0 ? '无外置条目' : `${String(checked)} 条外置引用可读、字节数一致`, missing };
}

/** VACUUM 回收空闲页（必须独占库、且不在事务里 —— 调用时 store 已关） */
function vacuum(dbPath: string): { before: number; after: number } | undefined {
    // sync-io-ok: 同上（VACUUM 前后量体积）
    const before = statSync(dbPath).size;
    const db = new DatabaseSync(dbPath);
    try {
        const pageSize = Number((db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size);
        const free = Number((db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count);
        const freeBytes = pageSize * free;
        if (freeBytes < VACUUM_MIN_BYTES) {
            log(`空闲页只有 ${(freeBytes / 1048576).toFixed(1)}MB，跳过 VACUUM`);
            return undefined;
        }
        log(`VACUUM：回收约 ${(freeBytes / 1048576).toFixed(1)}MB 空闲页（需几秒）…`);
        db.exec('VACUUM');
    } finally {
        db.close();
    }
    // sync-io-ok: 同上
    const after = statSync(dbPath).size;
    log(`VACUUM 完成：${(before / 1048576).toFixed(1)}MB → ${(after / 1048576).toFixed(1)}MB`);
    return { before, after };
}

/** 真干活的那部分；同步跑完（失败时置 exitCode=1 并把栈写 stderr） */
export function runMigrationWorker(dbPath: string | undefined): void {
    if (dbPath === undefined) {
        emit({ kind: 'fatal', message: '缺参数：数据库路径' });
        process.exit(2);
    }

    // 先把「一共几步」报给页面：进度条要有分母（不然只能画一个不知道到哪的转圈）
    emit({ kind: 'plan', steps: MIGRATION_STEPS });

    const started = Date.now();
    let failed: string | undefined;
    let store: ReturnType<typeof openStore> | undefined;

    try {
        // ① 备份：数据迁移会改写历史条目，没有退路就不开始
        const backup = backupBeforeMigrate(dbPath);
        // sync-io-ok: 同上（统计迁移前后体积，报给迁移页）
        const dbBytesBefore = existsSync(dbPath) ? statSync(dbPath).size : 0;

        // ② 迁移（同步；含数据迁移，进度经 onMigrationStep 逐条报出去）
        store = openStore(dbPath, {
            onMigrationStep: (event: MigrationStepEvent) => emit({ kind: 'step', event }),
        });

        // ③ 校验：迁移步骤 done ≠ 数据是对的
        const verify = verifyOffload(store, dbPath);
        if (verify.missing.length > 0) {
            log(
                `外置校验：${String(verify.missing.length)} 个引用文件缺失/大小不符（不拦启动，界面会显示预览）` +
                    `：${verify.missing.slice(0, 3).join('、')}${verify.missing.length > 3 ? ' …' : ''}`,
            );
        }
        const offloadCheck =
            verify.missing.length === 0 ? verify.ok : `${verify.ok}；${String(verify.missing.length)} 个文件缺失`;

        // 迁移后才有的结论：行数与孤儿检查（迁移页的「结果」那张表就是它）
        const summary = {
            botProfiles: countOf(store, 'bot_profiles'),
            botProfileDefaults: countOf(store, 'bot_profile_defaults'),
            botProfilesV0: countOf(store, 'bots_v0'),
            sessions: countOf(store, 'session_state'),
            roomEntries: countOf(store, 'room_entries'),
            rooms: countOf(store, 'rooms_v0'),
            entities: countOf(store, 'entities'),
            tasks: countOf(store, 'tasks'),
            projects: countOf(store, 'projects'),
        };
        const orphanSessions = (() => {
            try {
                return (
                    store.db
                        .prepare(
                            'SELECT COUNT(*) AS n FROM session_state WHERE bot_profile_id NOT IN (SELECT id FROM bot_profiles)',
                        )
                        .get() as { n: number }
                ).n;
            } catch {
                return -1;
            }
        })();

        // ④ 关库后才能 VACUUM（独占 + 不能有事务）；失败只降级成日志，不回滚已完成的迁移
        store.db.close();
        store = undefined;
        let vacuumed: { before: number; after: number } | undefined;
        try {
            vacuumed = vacuum(dbPath);
        } catch (error) {
            log(`VACUUM 失败（迁移已完成，空间暂未回收）：${error instanceof Error ? error.message : String(error)}`);
        }

        emit({
            kind: 'summary',
            summary,
            orphanSessions,
            offloadCheck,
            backup,
            dbBytesBefore,
            // sync-io-ok: 同上
            dbBytesAfter: existsSync(dbPath) ? statSync(dbPath).size : dbBytesBefore,
            vacuumed,
            durationMs: Date.now() - started,
        });
    } catch (error) {
        failed = error instanceof Error ? (error.stack ?? error.message) : String(error);
        emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        process.exitCode = 1;
    } finally {
        try {
            store?.db.close();
        } catch {
            /* 已关 */
        }
    }

    if (failed !== undefined) process.stderr.write(`${failed}\n`);
}

// 直接执行（开发路径）：`tsx migrate-worker.ts <db>`
if (process.argv[1]?.endsWith('migrate-worker.ts') === true) {
    runMigrationWorker(process.argv[2]);
}
