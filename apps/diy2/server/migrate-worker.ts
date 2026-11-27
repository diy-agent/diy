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

import { MIGRATION_STEPS, openStore, type MigrationStepEvent } from '@diy-agent/entity-runtime';

const MARK = '@@';

/** index.mjs 复用入口时的标志：命中就当迁移子进程跑，不再正常启动 */
export const MIGRATE_WORKER_FLAG = '--migrate-worker';

function emit(payload: unknown): void {
    process.stdout.write(`${MARK}${JSON.stringify(payload)}\n`);
}

function countOf(store: ReturnType<typeof openStore>, table: string): number {
    try {
        return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } catch {
        return -1;
    }
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

    try {
        const store = openStore(dbPath, {
            onMigrationStep: (event: MigrationStepEvent) => emit({ kind: 'step', event }),
        });

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

        emit({ kind: 'summary', summary, orphanSessions, durationMs: Date.now() - started });
        store.db.close();
    } catch (error) {
        failed = error instanceof Error ? (error.stack ?? error.message) : String(error);
        emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        process.exitCode = 1;
    }

    if (failed !== undefined) process.stderr.write(`${failed}\n`);
}

// 直接执行（开发路径）：`tsx migrate-worker.ts <db>`
if (process.argv[1]?.endsWith('migrate-worker.ts') === true) {
    runMigrationWorker(process.argv[2]);
}
