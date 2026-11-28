// session-file.test.ts —— 会话快照正文落库外（2026-11-28）。
//
// 锁的是判据本身：表里 `entries` 为空串 ⇒ 正文在文件；非空 ⇒ 老数据 / 回退，直接用表里的。
// 文件丢了必须退化成「没有快照」（全量回放），不能抛、不能当成空上下文。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openStore } from '../src/db';
import { readSessionEntries, sessionFilePath, writeSessionEntries } from '../src/session-file';

let roots: string[] = [];

function tmpRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diy-session-'));
    roots.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
    roots = [];
});

const ENTRY = {
    message: { role: 'user' as const, content: [{ type: 'text' as const, text: '你好' }] },
} as never;

describe('session-file', () => {
    it('写读往返（正文不进表）', () => {
        const file = sessionFilePath(tmpRoot(), 'task-a', 'bot:a');
        writeSessionEntries(file, [ENTRY]);

        expect(readSessionEntries(file)).toEqual([ENTRY]);
    });

    it('坏 JSON / 文件不存在 ⇒ undefined（调用方当作没有快照，走全量回放）', () => {
        const root = tmpRoot();
        const file = sessionFilePath(root, 'task-a', 'bot:a');
        expect(readSessionEntries(file)).toBeUndefined();

        mkdirSync(join(root, 'sessions'), { recursive: true });
        writeFileSync(file, '{ 不是 JSON', 'utf8');
        expect(readSessionEntries(file)).toBeUndefined();
    });

    it('原子写：写完只留目标文件，没有 .tmp 残留', () => {
        const root = tmpRoot();
        const file = sessionFilePath(root, 'a:b', 'bot:x');
        writeSessionEntries(file, [ENTRY]);

        expect(readdirSync(join(root, 'sessions'))).toEqual([`a_b__bot_x.json`]);
        expect(readFileSync(file, 'utf8').startsWith('[')).toBe(true);
    });
});

describe('db.saveSession / loadSession（外置接线）', () => {
    it('保存后表里 entries 是空串、正文在文件里；读回等价', () => {
        const root = tmpRoot();
        const store = openStore(join(root, 'diy2.db'));

        store.saveSession('task-a', 'bot-a', { turn: 3, collapsed: 1, entries: [ENTRY], logSeq: 7 });
        const back = store.loadSession('task-a', 'bot-a');

        expect(back?.entries).toEqual([ENTRY]);
        expect(back?.turn).toBe(3);
        expect(back?.logSeq).toBe(7);
        // 正文不在表里
        const file = sessionFilePath(root, 'task-a', 'bot-a');
        expect(readFileSync(file, 'utf8').includes('你好')).toBe(true);
    });

    it('正文文件丢了 ⇒ 当没有快照（不抛）', () => {
        const root = tmpRoot();
        const store = openStore(join(root, 'diy2.db'));
        store.saveSession('task-a', 'bot-a', { turn: 3, collapsed: 0, entries: [ENTRY] });

        rmSync(sessionFilePath(root, 'task-a', 'bot-a'));
        expect(store.loadSession('task-a', 'bot-a')).toBeUndefined();
    });
});
