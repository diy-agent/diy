// tests/intent.store.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 分桶 jsonl 存储「意图测试」—— 需求级（对应 ##456「存储分桶」判据）
//
//   T1  按大小切桶（不按日期）：写 20 MB 后 ≥3 个桶，每桶 ≤ maxBucketBytes
//   T2  seq 全局单调、跨桶连续：readFrom(seq) 跨桶拼接无损（前后 seq 连续）
//   T3  readFrom 只读需要的桶（不扫全量）：前面的桶被删也不会影响只读尾部
//   T4  删中间桶 ⇒ open 报 `store/missing-bucket`（不静默丢数据）
//   T5  index 坏了 / 丢了 ⇒ 扫目录重建；重建时发现缺号 ⇒ `store/gap`
//   T6  追加语义：seq 不连续 / 缺 seq 一律拒绝（半批落盘比不落更糟）
//   T7  重开后续写：lastSeq 不重号（末桶刷新）
//   T8  按时间查：readRange({from,to}) 只打开时间相交的桶（桶的 fromAt/toAt 可二分）
//
// 真文件系统（临时目录），不 mock fs —— 这层要验的就是落盘行为本身。
// ═══════════════════════════════════════════════════════════════

import { mkdtemp, readdir, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@diy/agent-session';
import { StoreError, openJsonlSessionStore } from '../src/index.js';

let dir: string;

beforeEach(async () => {
    clock = 0;
    dir = await mkdtemp(join(tmpdir(), 'diy-session-store-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 9, 29, 0, 0, 0);
let clock = 0;

/** 一条消息（带 seq；内容可控大小） */
function message(seq: number, content: string): ChatMessage {
    clock += 1;
    return { seq, role: 'user', kind: 'human', text: content, at: T0 + clock * 1000 };
}

async function bucketFiles(target = dir): Promise<string[]> {
    return (await readdir(target)).filter((name) => /^log-\d+\.jsonl$/.test(name)).sort();
}

describe('T1 按大小切桶', () => {
    it('写 20 MB 后 ≥3 个桶，每个 ≤ 8 MB（缺省上界）', async () => {
        const store = await openJsonlSessionStore({ dir });
        const chunk = 'x'.repeat(1024 * 1024); // 1 MB
        for (let seq = 1; seq <= 20; seq += 1) {
            await store.append([message(seq, `${String(seq).padStart(2, '0')}${chunk}`)]);
        }

        const files = await bucketFiles();
        expect(files.length).toBeGreaterThanOrEqual(3);
        for (const file of files) {
            const { size } = await stat(join(dir, file));
            expect(size).toBeLessThanOrEqual(8 * 1024 * 1024);
        }
        expect(store.latestSeq()).toBe(20);
    });

    it('按大小不按日期：同一毫秒的一堆消息也会切桶', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 512 });
        for (let seq = 1; seq <= 12; seq += 1) {
            await store.append([message(seq, 'y'.repeat(200))]);
        }
        expect((await bucketFiles()).length).toBeGreaterThan(1);
    });
});

describe('T2 跨桶读无损', () => {
    it('readFrom(0) 拿回全部；readFrom(k) 只拿 seq > k（跨桶连续）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 20; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        expect((await bucketFiles()).length).toBeGreaterThan(1);

        const all = await store.readFrom(0);
        expect(all.map((item) => item.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

        const tail = await store.readFrom(17);
        expect(tail.map((item) => item.seq)).toEqual([18, 19, 20]);

        // 重开（走 index.json）再读一次：结果一致
        const reopened = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        expect((await reopened.readFrom(0)).map((item) => item.seq)).toEqual(all.map((item) => item.seq));
        expect(reopened.latestSeq()).toBe(20);
    });
});

describe('T3 readFrom 只读需要的桶', () => {
    it('删掉更早的桶后，只读尾部仍然成功（不是全量扫）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 20; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        const files = await bucketFiles();
        // 删掉第一桶，并把它从 index 摘掉（模拟「很久以前的历史已归档」）
        await unlink(join(dir, files[0]));
        const index = store.index();
        const trimmed = { ...index, buckets: index.buckets.slice(1) };
        await writeIndexFile(join(dir, 'index.json'), trimmed);

        const reopened = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        const tail = await reopened.readFrom(18);
        expect(tail.map((item) => item.seq)).toEqual([19, 20]);
    });
});

describe('T4 删中间桶要报缺失', () => {
    it('open 报 store/missing-bucket（不静默跳过）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 12; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        const files = await bucketFiles();
        expect(files.length).toBeGreaterThanOrEqual(3);
        await unlink(join(dir, files[1]));

        await expect(openJsonlSessionStore({ dir, maxBucketBytes: 400 })).rejects.toMatchObject({
            code: 'store/missing-bucket',
        });
    });
});

describe('T5 index 坏了 / 丢了就重建', () => {
    it('删掉 index.json：扫目录重建，seq 仍然连续', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 12; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        await unlink(join(dir, 'index.json'));

        const reopened = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        expect(reopened.latestSeq()).toBe(12);
        expect((await reopened.readFrom(0)).map((item) => item.seq)).toEqual(
            Array.from({ length: 12 }, (_, index) => index + 1),
        );
    });

    it('删中间桶且 index 也没了 ⇒ 重建时发现缺号（store/gap）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 12; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        const files = await bucketFiles();
        await unlink(join(dir, files[1]));
        await unlink(join(dir, 'index.json'));

        await expect(openJsonlSessionStore({ dir, maxBucketBytes: 400 })).rejects.toMatchObject({ code: 'store/gap' });
    });
});

describe('T6 追加语义', () => {
    it('缺 seq ⇒ store/message-without-seq；seq 不连续 ⇒ store/gap（先校验再写）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        await store.append([message(1, '一')]);

        const noSeq: ChatMessage = { role: 'user', text: '没有 seq' };
        await expect(store.append([noSeq])).rejects.toMatchObject({ code: 'store/message-without-seq' });

        await expect(store.append([message(3, '跳号')])).rejects.toMatchObject({ code: 'store/gap' });

        // 失败的追加没写进去
        expect(store.latestSeq()).toBe(1);
        expect((await store.readFrom(0)).map((item) => item.seq)).toEqual([1]);
    });

    it('一批消息中途造成的半批也不落盘（先全量校验）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        await expect(store.append([message(1, '一'), message(3, '三')])).rejects.toBeInstanceOf(StoreError);
        expect(store.latestSeq()).toBe(0);
        expect(await store.readFrom(0)).toEqual([]);
    });
});

describe('T8 按时间读', () => {
    it('readRange 只返回时间相交的消息（跨桶按 at 排序）', async () => {
        const store = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 20; seq += 1) {
            await store.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }
        // 每条相隔 1 秒（见 message()）；取第 5~9 秒
        const range = await store.readRange({ from: T0 + 5 * 1000, to: T0 + 9 * 1000 });
        expect(range.map((item) => item.seq)).toEqual([5, 6, 7, 8, 9]);
        expect(range.map((item) => item.at)).toEqual([
            T0 + 5 * 1000,
            T0 + 6 * 1000,
            T0 + 7 * 1000,
            T0 + 8 * 1000,
            T0 + 9 * 1000,
        ]);

        // 空区间 / 越界
        expect(await store.readRange({ from: T0 - 10000, to: T0 - 1 })).toEqual([]);
        await expect(store.readRange({ from: 5, to: 1 })).rejects.toMatchObject({ code: 'store/invalid-options' });
    });
});

describe('T7 重开后续写', () => {
    it('lastSeq 从末桶恢复，不重号', async () => {
        const first = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        for (let seq = 1; seq <= 6; seq += 1) {
            await first.append([message(seq, `第${seq}句`.padEnd(100, '。'))]);
        }

        const second = await openJsonlSessionStore({ dir, maxBucketBytes: 400 });
        expect(second.latestSeq()).toBe(6);
        await second.append([message(7, '继续'.padEnd(100, '。'))]);
        expect(second.latestSeq()).toBe(7);
        expect((await second.readFrom(6)).map((item) => item.seq)).toEqual([7]);
    });
});

/** 测试里直接改 index.json（模拟外部归档 / 手工修复） */
async function writeIndexFile(path: string, value: unknown): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
}
