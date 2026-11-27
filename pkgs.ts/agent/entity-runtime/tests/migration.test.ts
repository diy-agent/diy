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

import { openStore, type Store } from '../src/db';

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
                { id: 'proj:x', name: 'x', workspace: '~/git/x', createdAt: 1_000 },
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

    it('bots 折成角色（bots_v0 留档）；journal_entries 折成 events（<type>.journal）', () => {
        const db = new DatabaseSync(file);
        db.exec(`
            CREATE TABLE rooms (
                id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
                data TEXT NOT NULL, model_key TEXT NOT NULL, created_at INTEGER NOT NULL
            );
            CREATE TABLE bots (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, persona TEXT NOT NULL,
                home_entity_id TEXT NOT NULL, home_dir TEXT, model_key TEXT NOT NULL
            );
            CREATE TABLE journal_entries (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL,
                at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL
            );
        `);
        db.prepare('INSERT INTO rooms VALUES (?,?,?,?,?,?)').run(
            'task-a',
            'task',
            'A',
            JSON.stringify({ status: 'open' }),
            'm',
            2_000,
        );
        db.prepare('INSERT INTO bots VALUES (?,?,?,?,?,?,?)').run('bot-1', 'diy', '#000', 'p', 'task-a', null, 'm');
        db.prepare('INSERT INTO journal_entries (entity_id, at, kind, text) VALUES (?,?,?,?)').run(
            'task-a',
            3_000,
            'decision',
            '选了 A',
        );
        db.close();

        const store = openStore(file);
        try {
            // 单行组：id / 名字原样，类型取归属容器的类型（task-a 是任务 → task），
            // persona 落进 instructions，model_key 落成角色自己的模型
            expect(store.listBotProfiles()).toEqual([
                expect.objectContaining({
                    id: 'bot-1',
                    type: 'task',
                    name: 'diy',
                    instructions: 'p',
                    primary: true,
                    modelKey: 'm',
                }),
            ]);
            expect(store.journalOf('task-a')).toEqual([
                { seq: expect.any(Number), at: 3_000, kind: 'decision', text: '选了 A' },
            ]);
            const names = tableNames(store);
            expect(names).toContain('bots_v0');
            expect(names).not.toContain('bots');
            expect(names).toContain('journal_entries_v0');
            expect(names).not.toContain('journal_entries');
        } finally {
            store.db.close();
        }
    });

    it('同类型同人格的 bot 合成一个角色；会话键跟着改（旧列名 bot_id 也改过来）', () => {
        const db = new DatabaseSync(file);
        db.exec(`
            CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE bots (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, persona TEXT NOT NULL,
                home_entity_id TEXT NOT NULL, home_dir TEXT, model_key TEXT NOT NULL
            );
            CREATE TABLE session_state (
                entity_id TEXT NOT NULL, bot_id TEXT NOT NULL, turn INTEGER NOT NULL,
                collapsed INTEGER NOT NULL, entries TEXT NOT NULL, usage TEXT,
                log_seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
                PRIMARY KEY (entity_id, bot_id)
            );
            CREATE TABLE entity_items (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, item TEXT NOT NULL, at INTEGER NOT NULL
            );
        `);
        for (const [id, name] of [
            ['task:t1', '任务一'],
            ['task:t2', '任务二'],
        ] as const) {
            db.prepare('INSERT INTO entities VALUES (?,?,?)').run(id, 'task', 1);
            // 两份「每个任务一个 bot」：人格一模一样 —— 真库里 27 个 task bot 就是这样
            db.prepare('INSERT INTO bots VALUES (?,?,?,?,?,?,?)').run(
                `bot-${id}`,
                name,
                '#000',
                '任务视角：做完要能自己验',
                id,
                null,
                // 占位键：当年的「没配置」写法，迁移时必须落成 null
                'none@none/none',
            );
        }
        // 会话挂在被合并掉的那个 id 上（t2 的 bot）
        db.prepare('INSERT INTO session_state VALUES (?,?,?,?,?,?,?,?)').run(
            'task:t2',
            'bot-task:t2',
            3,
            0,
            JSON.stringify([]),
            null,
            0,
            1,
        );
        // 历史消息：每个旧 bot 各一条。合并后 UI 按「消息 author.id ∈ 当前成员」显示，
        // 不重写就会整段消失（数据在、看不见）—— 2026-11-26 实测。
        for (const botId of ['bot-task:t1', 'bot-task:t2']) {
            db.prepare('INSERT INTO entity_items (entity_id, item, at) VALUES (?,?,?)').run(
                'task:t2',
                JSON.stringify({ id: `m-${botId}`, type: 'chat', author: { id: botId, role: 'bot' }, data: { text: 'x' } }),
                1_000,
            );
        }
        db.close();

        const store = openStore(file);
        try {
            const roles = store.listBotProfiles();
            expect(roles).toHaveLength(1);
            // id 复用组内最早那行（会话键因此能原地改过去），名字用类型名
            expect(roles[0]).toMatchObject({
                id: 'bot-task:t1',
                type: 'task',
                name: '任务助手',
                instructions: '任务视角：做完要能自己验',
                primary: true,
                // 当年的占位键 `none@none/none` 不该变成角色的模型：它必须落成 null（= 继续继承）
                modelKey: null,
            });
            // 会话键从 bot-task:t2 改成了它合并后的角色 id
            expect(store.loadSession('task:t2', 'bot-task:t1')?.turn).toBe(3);
            // 历史消息的 author.id 也要跟着换成合并后的角色 id（否则 UI 对不上成员、整段隐藏）
            const items = store.itemsOf('task:t2', 0) as Array<{ author?: { id: string } }>;
            expect(items.map((item) => item.author?.id)).toEqual(['bot-task:t1', 'bot-task:t1']);
            // 列名也改过来了（新列名才是真源，旧名只在老库里出现）
            const columns = (store.db.prepare('PRAGMA table_info(session_state)').all() as Array<{ name: string }>).map(
                (row) => row.name,
            );
            expect(columns).toContain('bot_profile_id');
            expect(columns).not.toContain('bot_id');
            const names = tableNames(store);
            expect(names).toContain('bots_v0');
            expect(names).not.toContain('bots');
        } finally {
            store.db.close();
        }
    });
});

describe('占位模型键 none@none/none', () => {
    // 当年拿它表示「没配模型」，却被写进了库：界面上会拼成「none · none@none」看着像配好了，
    // 发出去必失败。房间级 model_key 已退役（2026-11-27），现在只清角色级的存量。
    it('角色级存量行被清成 null', () => {
        const first = openStore(file);
        first.upsertBotProfile({
            id: 'bot-x',
            type: 'project',
            name: 'x',
            color: '#000',
            instructions: '',
            primary: true,
            modelKey: 'none@none/none',
            reasoningEffort: null,
            createdAt: 1,
            updatedAt: 1,
        });
        first.db.close();

        const second = openStore(file);
        try {
            const row = second.db.prepare("SELECT model_key FROM bot_profiles WHERE id = 'bot-x'").get() as {
                model_key: string | null;
            };
            expect(row.model_key).toBeNull();
        } finally {
            second.db.close();
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

function tableNames(store: Store): string[] {
    return (
        store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
            name: string;
        }>
    ).map((row) => row.name);
}
