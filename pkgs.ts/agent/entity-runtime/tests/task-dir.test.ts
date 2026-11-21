// task-dir.test.ts —— 任务目录：`<数据根>/tasks/2026-11-21/<id>/`
//
// 钉三件事：
//   1. 日期取**本地时区**的创建日（晚上建的任务不能跑到「昨天」）。
//   2. 路径只由 (createdAt, id) 决定 —— 改标题 / 状态 / workspace 都不换目录。
//   3. DB 是真源：task.md / journal.jsonl 是导出物；删任务只把目录挪进 _trash。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore, type Store } from '../src/db';
import { dayOf } from '../src/task-dir';

let root = '';
let store: Store;

function input(id: string, extra: Record<string, unknown> = {}) {
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
        ...extra,
    };
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'diy2-taskdir-'));
    store = openStore(join(root, 'diy2.db'));
});

afterEach(() => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
});

describe('dayOf', () => {
    it('用本地时区：晚上 23:30 仍算当天', () => {
        expect(dayOf(new Date(2026, 10, 21, 23, 30).getTime())).toBe('2026-11-21');
        expect(dayOf(new Date(2026, 0, 1, 0, 5).getTime())).toBe('2026-01-01');
    });
});

describe('任务目录', () => {
    it('保存任务 → 建目录 + task.md + artifacts/；路径按创建日', () => {
        const createdAt = new Date(2026, 10, 21, 10).getTime();
        const task = store.saveTask(input('t-1', { createdAt, summary: '一句话', body: '正文' }));
        const dir = join(root, 'tasks', '2026-11-21', 't-1');

        expect(store.taskDirOf(task.id)).toBe(dir);
        expect(existsSync(join(dir, 'artifacts'))).toBe(true);

        const doc = readFileSync(join(dir, 'task.md'), 'utf8');
        expect(doc).toContain('id: "t-1"');
        expect(doc).toContain(`number: ${task.number}`);
        expect(doc).toContain('title: "t-1"');
        expect(doc).toContain('summary: "一句话"');
        expect(doc).toContain('status: "open"');
        expect(doc).toContain('正文');
    });

    it('改标题 / 状态 / workspace 不换目录（日期只认 createdAt）', () => {
        const createdAt = new Date(2026, 10, 21, 10).getTime();
        store.saveTask(input('t-1', { createdAt }));
        const before = store.taskDirOf('t-1');

        store.saveTask(input('t-1', { createdAt, title: '改名', status: 'closed', workspace: '~/w' }));
        expect(store.taskDirOf('t-1')).toBe(before);
        expect(readFileSync(join(before!, 'task.md'), 'utf8')).toContain('title: "改名"');
    });

    it('历史 id 里的 ":" 换成分隔符（Windows 上非法）', () => {
        const createdAt = new Date(2026, 10, 21, 10).getTime();
        const task = store.saveTask(input('task:t-001', { createdAt }));
        expect(store.taskDirOf(task.id)).toBe(join(root, 'tasks', '2026-11-21', 'task-t-001'));
    });

    it('journal 追加到 journal.jsonl（一行一条，append-only）', () => {
        const createdAt = new Date(2026, 10, 21, 10).getTime();
        store.saveTask(input('t-1', { createdAt }));
        const a = store.appendJournal('t-1', { kind: 'decision', text: '选了 A' });
        const b = store.appendJournal('t-1', { kind: 'pitfall', text: 'B 会炸' });

        const lines = readFileSync(join(root, 'tasks', '2026-11-21', 't-1', 'journal.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { seq: number; kind: string; text: string });
        expect(lines).toEqual([
            { seq: a.seq, at: a.at, kind: 'decision', text: '选了 A' },
            { seq: b.seq, at: b.at, kind: 'pitfall', text: 'B 会炸' },
        ]);
    });

    it('删任务把目录挪进 _trash（产物不跟着消失）', () => {
        const createdAt = new Date(2026, 10, 21, 10).getTime();
        store.saveTask(input('t-1', { createdAt }));
        expect(existsSync(join(root, 'tasks', '2026-11-21', 't-1'))).toBe(true);

        store.deleteRoom('t-1');
        expect(existsSync(join(root, 'tasks', '2026-11-21', 't-1'))).toBe(false);
        expect(existsSync(join(root, 'tasks', '_trash', '2026-11-21-t-1', 'task.md'))).toBe(true);
    });

    it('没写过文件的任务删除时不报错（没有目录可挪）', () => {
        // 直接写库、绕过 saveTask 的镜像：模拟「目录丢了 / 从没写过」
        const createdAt = new Date(2026, 10, 21, 10).getTime();
        store.db.prepare('INSERT INTO entities (id, type, created_at) VALUES (?,?,?)').run('ghost', 'task', createdAt);
        store.db
            .prepare(
                'INSERT INTO tasks (id, number, title, summary, body, project_id, workspace, status, closed_at, model_key, created_at) ' +
                    'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            )
            .run('ghost', 99, 'ghost', '', '', null, null, 'open', null, 'm', createdAt);
        expect(() => store.deleteRoom('ghost')).not.toThrow();
    });

    it(':memory: 没有磁盘产物，也不去碰文件系统', () => {
        const memory = openStore(':memory:');
        try {
            const task = memory.saveTask(input('t-1'));
            expect(memory.taskDirOf(task.id)).toBeUndefined();
            expect(memory.taskOf(task.id)?.title).toBe('t-1');
        } finally {
            memory.db.close();
        }
    });

    it('Room 投影带只读的 number 与 taskDir；回写不会把它们存回 DB', () => {
        const createdAt = new Date(2026, 10, 21, 10).getTime();
        store.saveTask(input('t-1', { createdAt, body: '正文' }));
        const room = store.listRooms().find((item) => item.id === 't-1')!;
        expect(room.data['number']).toBe(1);
        expect(room.data['taskDir']).toBe(join(root, 'tasks', '2026-11-21', 't-1'));

        store.saveRoom(room);
        // 派生字段不落库：再取一次仍然由 store 算（而不是被当成 data 存下来）
        expect(store.taskOf('t-1')?.title).toBe('t-1');
        expect(store.listRooms().find((item) => item.id === 't-1')?.data['number']).toBe(1);
    });
});
