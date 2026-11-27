// migrate-worker.ts —— 在一个**子进程**里跑迁移，把每一步用 JSON 行报到 stdout。
//
// 为什么必须单开进程：`openStore()` 里的迁移是同步的（node:sqlite 的 DatabaseSync），
// 208M 的老库折 bots 会卡住事件循环。跑在同一个进程里的话，迁移页会在「开始」之后整段不刷新 ——
// 人看到的是「点了没反应」，而那正是最需要看见进度的时候。
//
// 协议：每一行 `@@<json>`。前缀是给父进程分流用的（父进程还要转发子进程自己的报错）。

import { openStore, type MigrationStepEvent } from '@diy-agent/entity-runtime';

const MARK = '@@';

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

const dbPath = process.argv[2];
if (dbPath === undefined) {
    emit({ kind: 'fatal', message: '缺参数：数据库路径' });
    process.exit(2);
}

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
