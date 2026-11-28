// migrate-worker.test.ts —— 迁移子进程的「周边动作」（2026-11-28）。
//
// 迁移页点一下之后，真正兜底的不是那几个 `up()`，而是子进程这一圈：
//   ① 迁前自动备份（没有退路就不动库）；
//   ② 跑迁移（含存量工具输出外置）；
//   ③ 迁后校验（没有漏搬、引用的文件真的在且字节数一致）；
//   ④ 关库后 VACUUM（小库跳过）；
//   ⑤ 把 summary 报给页面（体积 / 校验 / 备份路径）。
// 这里用真库文件跑一遍，锁住「备份存在 + 校验通过 + 结果能报出去」。

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openStore } from '@diy-agent/entity-runtime';
import type { Item } from '@diy-agent/protocol';

import { runMigrationWorker } from '../server/migrate-worker';

let roots: string[] = [];

function tmpRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diy2-worker-'));
    roots.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
    roots = [];
    process.exitCode = 0;
});

const big = 'z'.repeat(200 * 1024);

function bigToolItem(): Item {
    return {
        id: 'tool-call_big',
        seq: 1,
        turn: 1,
        at: 1_700_000_000_000,
        status: 'done',
        author: { id: 'bot-a', name: 'a', color: '#000', role: 'bot' },
        type: 'tool',
        data: { name: 'bash', args: { command: 'x' }, result: big, state: 'ok' },
    } as unknown as Item;
}

/** 造一个「存量库」：有条目、但外置迁移还没记账 */
function staleDb(dir: string): string {
    const file = join(dir, 'diy2.db');
    const store = openStore(file);
    store.appendItem('task-a', bigToolItem());
    store.db.prepare("DELETE FROM schema_migrations WHERE id = 'offload-tool-outputs'").run();
    store.db.close();
    return file;
}

describe('migrate-worker', () => {
    it('备份 → 外置迁移 → 校验 → 报 summary（VACUUM 小库跳过）', () => {
        const dir = tmpRoot();
        const file = staleDb(dir);

        const lines: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
            lines.push(String(chunk));
            return true;
        });
        try {
            runMigrationWorker(file);
        } finally {
            spy.mockRestore();
        }

        expect(process.exitCode ?? 0).toBe(0);
        const events = lines
            .filter((line) => line.startsWith('@@'))
            .map((line) => JSON.parse(line.slice(2)) as Record<string, unknown>);

        // 迁移步骤报出去了（页面靠它画进度），而且外置那步有进度分母
        const steps = events.filter((event) => event['kind'] === 'step').map((event) => event['event']);
        expect(steps.some((event) => (event as { id: string }).id === 'offload-tool-outputs')).toBe(true);

        const summary = events.find((event) => event['kind'] === 'summary') as Record<string, unknown> | undefined;
        expect(summary).toBeDefined();
        expect(String(summary!['offloadCheck'])).toContain('字节数一致');
        expect(String(summary!['backup'])).toContain('.bak-migrate-');
        // 自动备份真的落在库旁边
        expect(readdirSync(dir).some((name) => name.includes('.bak-migrate-'))).toBe(true);
    });

    it('迁移失败时置 exitCode=1 并报 error（页面不能停在「迁移中」）', () => {
        const dir = tmpRoot();
        const file = join(dir, 'diy2.db');
        // 不是 SQLite 文件：开库必炸
        writeFileSync(file, 'not a database');

        const lines: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
            lines.push(String(chunk));
            return true;
        });
        try {
            runMigrationWorker(file);
        } finally {
            spy.mockRestore();
        }

        expect(process.exitCode).toBe(1);
        const events = lines
            .filter((line) => line.startsWith('@@'))
            .map((line) => JSON.parse(line.slice(2)) as Record<string, unknown>);
        expect(events.some((event) => event['kind'] === 'error')).toBe(true);
    });
});
