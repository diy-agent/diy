// 07 — 多个 actor 汇总成一条流（导航树）
//
//   node --import tsx pkgs.ts/core/actor/examples/07-aggregate/
//
// 这一节只讲一件事：**整体状态不是「问 N 个」，是一个 actor 的 state。**
// 每个 session 各自提交，单向上报给 catalog；nav 只订阅 catalog 一条流。
//
// 为什么不用扇出查询：返回值在你拿到那一刻就过期，而且 N 条查询会把写挡住。
// 折叠只要求「最终」，不要求「同时」。

import { actor } from '../../src/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Row {
    uri: string;
    sessionId: string; // 源的第几次生命
    seq: number; // 源的提交位置
    run: 'idle' | 'running' | 'done';
    turns: number;
}

/** 单调合并：只有 (sessionId, seq) 比现有的新才接受 */
function isNewer(next: Row, prev: Row | undefined): boolean {
    if (!prev) return true;
    if (next.sessionId !== prev.sessionId) return true; // 源重启过，整行替换
    return next.seq > prev.seq;
}

// ══ catalog：一个普通 actor，state 就是那张行表 ═════════════════════════

const catalog = actor(() => {
    const rows = new Map<string, Row>();
    const subs = new Set<(rows: readonly Row[]) => void>();
    const emit = () => {
        const snapshot = [...rows.values()];
        for (const cb of subs) cb(snapshot);
    };

    return {
        upsert(row: Row): { accepted: boolean; reason: string } {
            const prev = rows.get(row.uri);
            if (!isNewer(row, prev)) {
                return { accepted: false, reason: `旧行：seq ${row.seq} ≤ ${prev!.seq}` };
            }
            rows.set(row.uri, row);
            emit();
            return { accepted: true, reason: prev ? '替换' : '新增' };
        },

        forget(uri: string): boolean {
            const had = rows.delete(uri);
            if (had) emit();
            return had;
        },

        list(): readonly Row[] {
            return [...rows.values()];
        },

        /** 订阅：先给当前全量，之后每次变化推一份 */
        watch(cb: (rows: readonly Row[]) => void): () => void {
            subs.add(cb);
            cb([...rows.values()]);
            return () => subs.delete(cb);
        },
    };
});

// ══ nav：只订阅一条流 ══════════════════════════════════════════════════

console.log('nav 初始：');

const stop = await catalog.watch((rows) => {
    const text = rows
        .slice()
        .sort((a, b) => a.uri.localeCompare(b.uri))
        .map((r) => `${r.uri.split('/').at(-1)}[${r.run} ${r.turns}轮]`)
        .join('  ');
    console.log(`  nav ⟵ ${text || '(空)'}`);
});

// ══ 三个 session，各自提交后上报 ═══════════════════════════════════════

async function openSession(uri: string, sessionId: string) {
    let seq = 0;
    let turns = 0;

    return actor(() => ({
        async runTurn(): Promise<void> {
            // 开始跑：先上报一次 running
            await catalog.upsert({ uri, sessionId, seq: ++seq, run: 'running', turns });
            await sleep(20 + Math.random() * 30);
            turns += 1;
            // 跑完：再上报一次 done
            await catalog.upsert({ uri, sessionId, seq: ++seq, run: 'done', turns });
        },
        async idle(): Promise<void> {
            await catalog.upsert({ uri, sessionId, seq: ++seq, run: 'idle', turns });
        },
    }));
}

const t1 = await openSession('diy://node-a/session/t1', 'boot-1');
const t2 = await openSession('diy://node-a/session/t2', 'boot-1');
const t3 = await openSession('diy://node-b/session/t3', 'boot-1');

// 三个 session 同时跑，互相不认识
await Promise.all([t1.runTurn(), t2.runTurn(), t3.runTurn()]);
await Promise.all([t1.idle(), t2.idle(), t3.idle()]);

// ══ 乱序 / 重放都安全 ═══════════════════════════════════════════════════

console.log('\n乱序投递：');
console.log(`  投一条 t1 的旧行（seq=1）→ ${JSON.stringify(await catalog.upsert({ uri: 'diy://node-a/session/t1', sessionId: 'boot-1', seq: 1, run: 'running', turns: 0 }))}`);
console.log(`  投一条 t1 的新行（seq=99）→ ${JSON.stringify(await catalog.upsert({ uri: 'diy://node-a/session/t1', sessionId: 'boot-1', seq: 99, run: 'done', turns: 9 }))}`);

// ══ 源重启：sessionId 变了，整行替换 ═══════════════════════════════════

console.log('\n源重启（sessionId 换个值）：');
console.log(`  → ${JSON.stringify(await catalog.upsert({ uri: 'diy://node-a/session/t1', sessionId: 'boot-2', seq: 1, run: 'running', turns: 0 }))}`);

console.log('\n最终行表：');
for (const r of await catalog.list()) {
    console.log(`  ${r.uri}  session=${r.sessionId} seq=${r.seq} ${r.run} ${r.turns}轮`);
}

stop();
console.log(`\n订阅已停（行还在：${(await catalog.list()).length} 行）`);
