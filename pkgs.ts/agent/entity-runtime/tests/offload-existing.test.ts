// offload-existing.test.ts —— 存量工具输出搬出库（2026-11-28）。
//
// 锁四条判据（与写入闸同一套）：
//   1. 超阈值 ⇒ 正文进文件、条目改写成 output；
//   2. ≤ 阈值 / 非字符串 ⇒ 原样不动；
//   3. 已有 output ⇒ 幂等跳过（重跑不二次搬家）；
//   4. dryRun ⇒ 只统计，库里一个字不改。

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Item } from '@diy-agent/protocol';

import { openStore } from '../src/db';
import { OUTPUT_OFFLOAD_BYTES } from '../src/output-store';
import { offloadExistingToolOutputs } from '../src/offload-existing';

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
});
