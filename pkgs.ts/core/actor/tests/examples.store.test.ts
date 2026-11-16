// examples.store.test.ts — 落盘 store 的**提交语义**（examples/lib/store-jsonl.ts）。
//
// 这里锁的不是「能存」，而是三件会悄悄坏掉的事：
//   1. 一次提交是一行：状态 + 游标 + 它产生的事件，缺一件就会出现「事件说发生过、查询说没有」；
//   2. 没 `save` 的 `append` 不算数（对读者不存在）；
//   3. 崩在写的中途只留下半行 —— 半行必须被丢掉，而不是把整个库读坏。

import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openJsonlStore } from '../examples/lib/store-jsonl.js';
import { CURSOR_ZERO, type Cursor } from '../src/index.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'actor-store-'));
    dirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const entry = (name: string, data: unknown) => ({ name, at: 1, data });

describe('提交 = 一行（状态 + 游标 + 事件）', () => {
    it('写进去、重启后读出来（状态与游标一起回来）', async () => {
        const dir = await tempDir();
        const first = await openJsonlStore<{ n: number }>({ dir });
        const [appended] = await first.append([entry('added', { by: 1 })]);
        await first.save({ state: { n: 1 }, cursor: appended!.seq });
        await first.close();

        const second = await openJsonlStore<{ n: number }>({ dir });
        expect(await second.load()).toEqual({ state: { n: 1 }, cursor: appended!.seq });
        expect(second.commits).toBe(1);
        await second.close();
    });

    it('事件阅读器只看见**已提交**的（`append` 不 `save` = 没发生过）', async () => {
        const dir = await tempDir();
        const store = await openJsonlStore<{ n: number }>({ dir });
        await store.append([entry('added', { by: 1 })]);
        expect(await store.read(CURSOR_ZERO)).toEqual([]);

        const [appended] = await store.append([entry('added', { by: 2 })]);
        await store.save({ state: { n: 3 }, cursor: appended!.seq });
        const seen = await store.read(CURSOR_ZERO);
        expect(seen.map((e) => e.data)).toEqual([{ by: 1 }, { by: 2 }]);
        await store.close();
    });

    it('seq 跨重启接着数（不从头来，否则 `after` 会把历史再吐一遍）', async () => {
        const dir = await tempDir();
        const first = await openJsonlStore<{ n: number }>({ dir });
        const [one] = await first.append([entry('added', { by: 1 })]);
        await first.save({ state: { n: 1 }, cursor: one!.seq });
        await first.close();

        const second = await openJsonlStore<{ n: number }>({ dir });
        const [two] = await second.append([entry('added', { by: 2 })]);
        expect(Number.parseInt(two!.seq.slice(1), 10)).toBe(Number.parseInt(one!.seq.slice(1), 10) + 1);
        await second.close();
    });
});

describe('崩在写的中途：半行丢掉，别把整个库读坏', () => {
    it('尾部半行 ⇒ 只认完整的那次提交，并报一条 warn', async () => {
        const dir = await tempDir();
        const first = await openJsonlStore<{ n: number }>({ dir });
        const [appended] = await first.append([entry('added', { by: 1 })]);
        await first.save({ state: { n: 1 }, cursor: appended!.seq });
        await first.close();

        // 模拟写到一半断电：追加一段没有换行的 JSON
        const file = path.join(dir, 'commits.jsonl');
        await appendFile(file, '{"cursor":"e9","state":{"n":99', 'utf8');

        const warnings: string[] = [];
        const reopened = await openJsonlStore<{ n: number }>({ dir, onWarn: (m) => warnings.push(m) });
        expect(await reopened.load()).toEqual({ state: { n: 1 }, cursor: appended!.seq as Cursor });
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('半行');
        await reopened.close();
    });

    it('半行之后的提交照常生效（丢掉的是那一行，不是整个文件）', async () => {
        const dir = await tempDir();
        const store = await openJsonlStore<{ n: number }>({ dir });
        const [one] = await store.append([entry('added', { by: 1 })]);
        await store.save({ state: { n: 1 }, cursor: one!.seq });
        await store.close();

        const file = path.join(dir, 'commits.jsonl');
        await appendFile(file, '{"cursor":"e9","state"', 'utf8');

        const reopened = await openJsonlStore<{ n: number }>({ dir });
        const [two] = await reopened.append([entry('added', { by: 2 })]);
        await reopened.save({ state: { n: 2 }, cursor: two!.seq });
        await reopened.close();

        const again = await openJsonlStore<{ n: number }>({ dir });
        expect(await again.load()).toEqual({ state: { n: 2 }, cursor: two!.seq });
        // 半行被截掉了：文件里只剩两次完整提交（不截的话新提交会接在半行后面，变成一行非法 JSON，
        // 那一次提交就跟着一起没了 —— 这条断言锁的就是这个）
        expect((await readFile(file, 'utf8')).trimEnd().split('\n')).toHaveLength(2);
        await again.close();
    });
});
