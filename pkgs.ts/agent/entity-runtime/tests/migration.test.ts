// migration.test.ts —— 老库（rooms 一个 data 袋子）→ entities + tasks / projects。
//
// 迁移的硬要求只有三条：
//   1. 旧 id 原样保留（journal / 消息 / 会话全挂在它上面）
//   2. 任务编号按创建顺序补，且不回收
//   3. 迁移是幂等的：中途失败下次还能接着来（所以 rooms 只在全部成功后才改名留档）

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore } from '../src/db';

let dir = '';
let file = '';

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'diy2-migrate-'));
    file = join(dir, 'diy2.db');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** 造一个「迁移前」的库：只有 rooms，没有 entities / tasks / projects */
function legacyDb(): void {
    const db = new DatabaseSync(file);
    db.exec(`
        CREATE TABLE rooms (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            data TEXT NOT NULL,
            model_key TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
    `);
    const insert = db.prepare('INSERT INTO rooms (id, type, name, data, model_key, created_at) VALUES (?,?,?,?,?,?)');
    insert.run('proj:x', 'project', 'x', JSON.stringify({ dir: '~/git/x' }), 'm1', 1_000);
    insert.run(
        'task-a',
        'task',
        'A',
        JSON.stringify({ projectId: 'proj:x', dir: '~/git/x', status: 'todo' }),
        'm1',
        2_000,
    );
    insert.run(
        'task-b',
        'task',
        'B',
        JSON.stringify({ projectId: 'proj:x', status: 'done', closedAt: 9_000, desc: '一句话', body: '正文' }),
        'm1',
        3_000,
    );
    db.close();
}

describe('rooms → entities + tasks / projects', () => {
    it('域字段落到真列；旧 id 原样保留', () => {
        legacyDb();
        const store = openStore(file);
        try {
            expect(store.listProjects()).toEqual([
                { id: 'proj:x', name: 'x', workspace: '~/git/x', modelKey: 'm1', createdAt: 1_000 },
            ]);

            const [a, b] = store.listTasks();
            expect(a).toMatchObject({
                id: 'task-a',
                title: 'A',
                projectId: 'proj:x',
                workspace: '~/git/x',
                status: 'open', // todo 是历史值，迁成规范的两态
                closedAt: null,
                createdAt: 2_000,
            });
            expect(b).toMatchObject({
                id: 'task-b',
                status: 'closed', // done → closed
                closedAt: 9_000,
                summary: '一句话',
                body: '正文',
                workspace: null,
            });

            expect(store.entityOf('proj:x')).toEqual({ id: 'proj:x', type: 'project', createdAt: 1_000 });
            expect(store.entityOf('task-a')).toMatchObject({ type: 'task' });
        } finally {
            store.db.close();
        }
    });

    it('编号按创建顺序补 1..N；再开一次不重号', () => {
        legacyDb();
        const first = openStore(file);
        expect(first.listTasks().map((task) => task.number)).toEqual([1, 2]);
        first.db.close();

        const again = openStore(file);
        try {
            expect(again.listTasks().map((task) => task.number)).toEqual([1, 2]);
            // 新任务接着往后排，不回收
            expect(again.saveTask(input('task-c')).number).toBe(3);
        } finally {
            again.db.close();
        }
    });

    it('rooms 改名留档（不删数据），迁移完成的库再开也不重复搬', () => {
        legacyDb();
        const store = openStore(file);
        const tables = (
            store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
                name: string;
            }>
        ).map((row) => row.name);
        expect(tables).toContain('rooms_v0');
        expect(tables).not.toContain('rooms');
        store.db.close();
    });

    it('bad data JSON 不拦整库迁移（身份与名字保住）', () => {
        const db = new DatabaseSync(file);
        db.exec(`
            CREATE TABLE rooms (
                id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
                data TEXT NOT NULL, model_key TEXT NOT NULL, created_at INTEGER NOT NULL
            );
        `);
        db.prepare('INSERT INTO rooms VALUES (?,?,?,?,?,?)').run('task-bad', 'task', '坏数据', '{不是 json', 'm', 0);
        db.close();

        const store = openStore(file);
        try {
            expect(store.taskOf('task-bad')).toMatchObject({ title: '坏数据', status: 'open', workspace: null });
        } finally {
            store.db.close();
        }
    });
});

function input(id: string) {
    return {
        id,
        title: id,
        summary: '',
        body: '',
        projectId: null,
        workspace: null,
        status: 'open',
        closedAt: null,
        modelKey: 'm',
    };
}
