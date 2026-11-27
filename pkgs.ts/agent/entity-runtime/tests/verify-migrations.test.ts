// verify-migrations.test.ts —— 迁移跑完自检：步骤 done ≠ 库是对的。
//
// 两级判据（见 ../src/verify-migrations.ts）：error 拦启动，warn 只报（记录表的孤儿行现实存在）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore, type Store } from '../src/db';
import { verifyDatabase } from '../src/verify-migrations';

let dir = '';
let file = '';

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'diy2-verify-'));
    file = join(dir, 'diy2.db');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('迁移后自检（verify-migrations）', () => {
    /** 拿一个只读自检能用的 runtime（迁移不在这里跑，只是喂同一份能力面） */
    function runtimeOf(store: Store) {
        const noop = (): void => undefined;
        return {
            db: store.db,
            transaction: <T>(fn: () => T): T => fn(),
            hasTable: (name: string): boolean =>
                store.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
                undefined,
            columns: (): Set<string> => new Set(),
            renameToBackup: noop,
            createSchema: noop,
            legacyRooms: noop,
            foldBots: noop,
            journalToEvents: noop,
            log: noop,
        };
    }

    it('健康的库：没有任何结论', () => {
        const store = openStore(file);
        try {
            expect(verifyDatabase(runtimeOf(store))).toEqual([]);
        } finally {
            store.db.close();
        }
    });

    it('记录表孤儿行只报 warn，不拦启动', () => {
        const first = openStore(file);
        first.db
            .prepare('INSERT INTO entity_items (entity_id, seq, at, item) VALUES (?,?,?,?)')
            .run('proj:nowhere', 1, 1, JSON.stringify({ type: 'chat' }));
        first.db.close();

        // 重开：error 级为空 → 不抛
        const second = openStore(file);
        try {
            const findings = verifyDatabase(runtimeOf(second));
            expect(findings.map((item) => item.check)).toEqual(['orphan-entity-items']);
            expect(findings[0]?.level).toBe('warn');
        } finally {
            second.db.close();
        }
    });

    it('域表孤儿行是 error：重开库直接拒绝', () => {
        const first = openStore(file);
        first.db
            .prepare('INSERT INTO room_entries (entity_id, seq, at, entry) VALUES (?,?,?,?)')
            .run('nobody', 1, 1, '{}');
        first.db.close();

        expect(() => openStore(file)).toThrowError(/自检未通过/);
    });

    it('版本表缺一条 = error（迁移器没跑完）', () => {
        const store = openStore(file);
        try {
            // 直接看自检判据：重开库会被迁移器补上，测不到这一项
            store.db.prepare("DELETE FROM schema_migrations WHERE id = 'create-tables'").run();
            const findings = verifyDatabase(runtimeOf(store));
            expect(findings.map((item) => item.check)).toContain('version-table');
        } finally {
            store.db.close();
        }
    });
});
