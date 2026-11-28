// offload-existing.test.ts —— 存量工具输出搬出库（2026-11-28）。
//
// 锁四条判据（与写入闸同一套）：
//   1. 超阈值 ⇒ 正文进文件、条目改写成 output；
//   2. ≤ 阈值 / 非字符串 ⇒ 原样不动；
//   3. 已有 output ⇒ 幂等跳过（重跑不二次搬家）；
//   4. dryRun ⇒ 只统计，库里一个字不改。

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Item } from '@diy-agent/protocol';

import { openStore } from '../src/db';
import { OUTPUT_OFFLOAD_BYTES } from '../src/output-store';
import { offloadExistingToolOutputs, toolOutputOffloadPlan } from '../src/offload-existing';

let roots: string[] = [];

function tmpRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diy-offload-'));
    roots.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
    roots = [];
});

const big = 'z'.repeat(OUTPUT_OFFLOAD_BYTES + 100);

function toolItem(id: string, result: unknown): Item {
    return {
        id,
        seq: 1,
        turn: 1,
        at: 1_700_000_000_000,
        status: 'done',
        author: { id: 'bot-a', name: 'a', color: '#000', role: 'bot' },
        type: 'tool',
        data: { name: 'bash', args: { command: 'x' }, result, state: 'ok' },
    } as unknown as Item;
}

describe('offload-existing', () => {
    it('超阈值外置、小结果与非字符串不动', () => {
        const root = tmpRoot();
        const file = join(root, 'diy2.db');
        const store = openStore(file);
        store.appendItem('task-a', toolItem('tool-call_big', big));
        store.appendItem('task-a', toolItem('tool-call_small', 'ok'));
        store.appendItem('task-a', toolItem('tool-call_obj', { mode: 'image' }));
        (store as unknown as { close?: () => void }).close?.();

        const db = new DatabaseSync(file);
        const stats = offloadExistingToolOutputs(db, { dataRoot: root });
        db.close();

        expect(stats).toMatchObject({ scanned: 3, offloaded: 1, stayed: 2, failed: 0 });
        expect(stats.bytesMoved).toBe(Buffer.byteLength(big, 'utf8'));

        const check = new DatabaseSync(file);
        const items = check
            .prepare("SELECT item FROM entity_items WHERE json_extract(item, '$.type') = 'tool' ORDER BY seq")
            .all() as { item: string }[];
        const [first] = items.map((r) => JSON.parse(r.item) as Item);
        expect(first!.type).toBe('tool');
        const data = (first as Extract<Item, { type: 'tool' }>).data;
        expect(data.output?.ref.startsWith('runs/tool/')).toBe(true);
        expect(data.result).toBeUndefined();
        check.close();
    });

    it('幂等：已有 output 的不再搬', () => {
        const root = tmpRoot();
        const file = join(root, 'diy2.db');
        const store = openStore(file);
        store.appendItem('task-a', toolItem('tool-call_big', big));
        (store as unknown as { close?: () => void }).close?.();

        const first = new DatabaseSync(file);
        offloadExistingToolOutputs(first, { dataRoot: root });
        first.close();

        const second = new DatabaseSync(file);
        const stats = offloadExistingToolOutputs(second, { dataRoot: root });
        second.close();
        expect(stats.offloaded).toBe(0);
        expect(stats.alreadyOffloaded).toBe(1);
    });

    it('dryRun 只统计、不改库', () => {
        const root = tmpRoot();
        const file = join(root, 'diy2.db');
        const store = openStore(file);
        store.appendItem('task-a', toolItem('tool-call_big', big));
        (store as unknown as { close?: () => void }).close?.();

        const db = new DatabaseSync(file);
        const stats = offloadExistingToolOutputs(db, { dataRoot: root, dryRun: true });
        const row = db.prepare('SELECT item FROM entity_items').get() as { item: string };
        db.close();

        expect(stats.offloaded).toBe(1);
        expect((JSON.parse(row.item) as Extract<Item, { type: 'tool' }>).data.result).toBe(big);
    });

    it('迁移步骤：openStore 时搬走存量并记账；再开幂等', () => {
        const root = tmpRoot();
        const file = join(root, 'diy2.db');
        // 第一次开库（空库）：迁移按基线记账，没有东西可搬
        const store = openStore(file);
        expect(toolOutputOffloadPlan(store.db).rows).toBe(0);
        store.appendItem('task-a', toolItem('tool-call_big', big));
        // 模拟「存量库」：条目在、迁移还没记账
        store.db.prepare("DELETE FROM schema_migrations WHERE id = 'offload-tool-outputs'").run();
        store.db.close();

        // 第二次开库：迁移器看见这条没记账 → 在事务里把正文搬出去
        const again = openStore(file);
        try {
            expect(toolOutputOffloadPlan(again.db).rows).toBe(0);
            const recorded = again.db
                .prepare("SELECT baseline FROM schema_migrations WHERE id = 'offload-tool-outputs'")
                .get() as { baseline: number } | undefined;
            expect(recorded?.baseline).toBe(0); // 真跑过，不是基线
            const row = again.db
                .prepare("SELECT item FROM entity_items WHERE json_extract(item, '$.type') = 'tool'")
                .get() as { item: string };
            const data = (JSON.parse(row.item) as Extract<Item, { type: 'tool' }>).data;
            expect(data.result).toBeUndefined();
            expect(typeof data.output?.ref).toBe('string');
            // 正文真的落到了数据根下（ref 相对数据根）
            expect(statSync(join(root, data.output!.ref)).size).toBe(Buffer.byteLength(big, 'utf8'));
        } finally {
            again.db.close();
        }

        // 再开一次：不重复搬（不新增文件、条目不动）
        const third = openStore(file);
        try {
            expect(toolOutputOffloadPlan(third.db).rows).toBe(0);
            const row = third.db
                .prepare("SELECT item FROM entity_items WHERE json_extract(item, '$.type') = 'tool'")
                .get() as { item: string };
            expect((JSON.parse(row.item) as Extract<Item, { type: 'tool' }>).data.result).toBeUndefined();
        } finally {
            third.db.close();
        }
    });
});
