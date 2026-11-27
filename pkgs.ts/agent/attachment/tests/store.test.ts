// tests/store.test.ts — blobs 落盘 / 取回 / 引用（本包的主行为）
//
// 断言的是**磁盘形状与 ref 语义**，不是实现细节：
//   · 目录 = <日期>/<HHMMSS>-<batch8>/<NN>-<名>.<ext>（一次发送一批）
//   · 拷（stored）与引用（linked）两条入口，判据是「能不能从别处重建」
//   · 逃逸 / 超限 / 被改过的文件 —— 一律响亮失败，不静默降级

import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AttachmentError, createBlobStore, type BlobStore, type StoredAttachment } from '../src/index.js';
import { gifBytes, jpegBytes, noiseBytes, pngBytes } from './fixtures.js';

/** 本地时间 2026-11-26 09:30:12（用本地构造，断言与 TZ 无关） */
const AT = new Date(2026, 10, 26, 9, 30, 12).getTime();

const roots: string[] = [];

/** 一个干净的 blobs 根（用完删） */
async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'diy2-attachment-'));
    roots.push(root);
    return root;
}

function store(root: string, options: { maxBytes?: number; hashLimit?: number } = {}): BlobStore {
    return createBlobStore({ root, clock: () => AT, random: () => 'abcd1234', ...options });
}

/** 断言抛的是本包错误 + 特定 code */
async function expectCode(task: Promise<unknown>, code: string): Promise<void> {
    await expect(task).rejects.toThrow(AttachmentError);
    await task.catch((error: AttachmentError) => expect(error.code).toBe(code));
}

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('拷进 blobs（stored）', () => {
    it('目录形状 = 日期 / HHMMSS-批次 / NN-原名.ext', async () => {
        const root = await tempRoot();
        const blobs = store(root);
        const batch = blobs.beginBatch();
        expect(batch.id).toBe('2026-11-26/093012-abcd1234');

        const shot = await batch.putBytes({ bytes: pngBytes(1440, 900), name: 'screenshot.png', source: 'paste' });

        expect(shot.type).toBe('stored');
        expect(shot.relPath).toBe('2026-11-26/093012-abcd1234/01-screenshot.png');
        expect(shot.id).toBe(shot.relPath);
        expect(shot.kind).toBe('image');
        expect(shot.mime).toBe('image/png');
        expect(shot.image).toEqual({ width: 1440, height: 900 });
        expect(shot.bytes).toBeGreaterThan(0);
        expect(shot.sha256).toMatch(/^[0-9a-f]{64}$/);
        // 文件真的在那个位置
        expect((await stat(join(root, shot.relPath))).isFile()).toBe(true);
    });

    it('同一批次 NN 递增；同名不覆盖（两张都留着）', async () => {
        const root = await tempRoot();
        const batch = store(root).beginBatch();
        const first = await batch.putBytes({ bytes: pngBytes(10, 5), name: 'shot.png', source: 'paste' });
        const second = await batch.putBytes({ bytes: pngBytes(20, 8), name: 'shot.png', source: 'paste' });

        expect(first.relPath.endsWith('/01-shot.png')).toBe(true);
        expect(second.relPath.endsWith('/02-shot.png')).toBe(true);
        // 两张内容不同 ⇒ 字节数不同 ⇒ 真的是两份
        expect(await readFile(join(root, first.relPath))).not.toEqual(await readFile(join(root, second.relPath)));
    });

    it('剪贴板图没有名字 ⇒ paste，扩展名仍由 mime 定', async () => {
        const root = await tempRoot();
        const shot = await store(root).putBytes({ bytes: jpegBytes(), source: 'paste' });
        expect(shot.displayName).toBe('paste.jpg');
        expect(shot.relPath.endsWith('/01-paste.jpg')).toBe(true);
        expect(shot.kind).toBe('image');
    });

    it('后缀骗人：.png 里装 jpeg ⇒ mime 与落盘扩展名都按内容', async () => {
        const root = await tempRoot();
        const shot = await store(root).putBytes({ bytes: jpegBytes(64, 32), name: 'liar.png', source: 'drop' });
        expect(shot.mime).toBe('image/jpeg');
        expect(shot.relPath.endsWith('/01-liar.jpg')).toBe(true);
        expect(shot.displayName).toBe('liar.png'); // 原名一个字不改
        expect(shot.image).toEqual({ width: 64, height: 32 });
    });

    it('非图片（未知二进制）落成 file，扩展名 bin', async () => {
        const root = await tempRoot();
        const blob = await store(root).putBytes({ bytes: noiseBytes(32), name: 'data.bin', source: 'tool' });
        expect(blob.kind).toBe('file');
        expect(blob.mime).toBe('application/octet-stream');
        expect(blob.image).toBeUndefined();
    });

    it('putFile 流式拷 = 与源文件字节一致', async () => {
        const root = await tempRoot();
        const work = await tempRoot();
        const source = join(work, 'shot.png');
        const bytes = pngBytes(800, 600);
        await writeFile(source, bytes);

        const shot = await store(root).putFile({ path: source, name: 'shot.png', source: 'drop' });
        const back = await readFile(join(root, shot.relPath));
        expect(new Uint8Array(back)).toEqual(bytes);
        expect(shot.bytes).toBe(bytes.byteLength);
    });
});

describe('取回（read）', () => {
    it('字节一致；文件被改过就炸 read-failed（不悄悄返回错的东西）', async () => {
        const root = await tempRoot();
        const blobs = store(root);
        const shot = await blobs.putBytes({ bytes: pngBytes(), name: 'a.png', source: 'paste' });

        expect(new Uint8Array(await blobs.read(shot))).toEqual(pngBytes());

        // 有人在背后改了文件
        await writeFile(join(root, shot.relPath), pngBytes(99, 99));
        await expectCode(blobs.read(shot), 'attachment/read-failed');
    });

    it('文件被清掉 ⇒ not-found（不是读回空字节）', async () => {
        const root = await tempRoot();
        const blobs = store(root);
        const shot = await blobs.putBytes({ bytes: pngBytes(), name: 'a.png', source: 'paste' });
        await rm(join(root, shot.relPath));
        await expectCode(blobs.read(shot), 'attachment/not-found');
    });

    it('readHead 只取前 N 字节', async () => {
        const root = await tempRoot();
        const blobs = store(root);
        const shot = await blobs.putBytes({ bytes: pngBytes(), name: 'a.png', source: 'paste' });
        const head = await blobs.readHead(shot, 8);
        expect(head.byteLength).toBe(8);
        expect(head[0]).toBe(0x89);
    });
});

describe('安全与上限', () => {
    it('relPath 逃逸一律 unsafe-path（.. 与绝对路径都拒）', async () => {
        const root = await tempRoot();
        const blobs = store(root);
        const shot: StoredAttachment = {
            ...(await blobs.putBytes({ bytes: pngBytes(), name: 'a.png', source: 'paste' })),
        };
        await expectCode(blobs.read({ ...shot, relPath: '../../etc/passwd' }), 'attachment/unsafe-path');
        await expectCode(blobs.read({ ...shot, relPath: '/etc/passwd' }), 'attachment/unsafe-path');
        await expectCode(blobs.read({ ...shot, relPath: '' }), 'attachment/unsafe-path');
    });

    it('超过单文件上限 ⇒ too-large，且批次目录里不留临时文件', async () => {
        const root = await tempRoot();
        const blobs = store(root, { maxBytes: 16 });
        await expectCode(
            blobs.putBytes({ bytes: noiseBytes(64), name: 'big.bin', source: 'tool' }),
            'attachment/too-large',
        );

        // 空目录允许留下（批次目录在建文件前就建了，删它反而可能误删并发批次）——
        // 但**一个文件都不能留**，尤其不能有 `.tmp-*`
        const files: string[] = [];
        for (const day of await readdir(root)) {
            for (const batch of await readdir(join(root, day))) {
                files.push(...(await readdir(join(root, day, batch))));
            }
        }
        expect(files).toEqual([]);
    });

    it('目录 0700、文件 0600', async () => {
        const root = await tempRoot();
        const shot = await store(root).putBytes({ bytes: pngBytes(), name: 'a.png', source: 'paste' });
        const dirMode = (await stat(join(root, '2026-11-26'))).mode & 0o777;
        const fileMode = (await stat(join(root, shot.relPath))).mode & 0o777;
        expect(dirMode).toBe(0o700);
        expect(fileMode).toBe(0o600);
    });

    it('removeBatch 整批删掉（附件本体可以随批次一起走）', async () => {
        const root = await tempRoot();
        const blobs = store(root);
        const batch = blobs.beginBatch();
        await batch.putBytes({ bytes: pngBytes(), name: 'a.png', source: 'paste' });
        await batch.putBytes({ bytes: pngBytes(), name: 'b.png', source: 'paste' });

        expect(await blobs.removeBatch(batch.id)).toBe(2);
        expect(await blobs.exists(`${batch.id}/01-a.png`)).toBe(false);
        expect(await blobs.removeBatch(batch.id)).toBe(0); // 幂等
    });
});

describe('引用（linked，不拷贝）', () => {
    it('工作区文件：只记路径，blobs 里一个字节都不落', async () => {
        const root = await tempRoot();
        const work = await tempRoot();
        const file = join(work, 'report.pdf');
        await writeFile(file, Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d])); // %PDF-

        const linked = await store(root).adopt({ path: file });

        expect(linked.type).toBe('linked');
        expect(linked.path).toBe(file);
        expect(linked.mime).toBe('application/pdf');
        expect(linked.kind).toBe('file');
        expect(linked.bytes).toBe(5);
        expect(linked.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(linked.id.startsWith('ref-')).toBe(true);
        expect(await readdir(root)).toEqual([]); // 没写盘
    });

    it('目录：kind=dir + 有概览（count / 样例，且剔除 .DS_Store）', async () => {
        const root = await tempRoot();
        const work = await tempRoot();
        await mkdir(join(work, 'sub'));
        await writeFile(join(work, 'a.png'), pngBytes());
        await writeFile(join(work, 'sub', 'b.png'), pngBytes());
        await writeFile(join(work, '.DS_Store'), Uint8Array.from([0]));

        const dir = await store(root).adopt({ path: work });

        expect(dir.kind).toBe('dir');
        expect(dir.mime).toBe('inode/directory');
        expect(dir.listing?.count).toBe(2);
        expect(dir.listing?.sample).toContain('a.png');
        expect(dir.listing?.sample).toContain('sub/b.png');
        expect(dir.sha256).toBeUndefined(); // 目录指纹不是 sha256（树会变）
    });

    it('路径不存在 ⇒ not-found', async () => {
        const root = await tempRoot();
        await expectCode(store(root).adopt({ path: join(root, 'nope.png') }), 'attachment/not-found');
    });

    it('大文件不算 sha256（超过 hashLimit 就只记大小）', async () => {
        const root = await tempRoot();
        const work = await tempRoot();
        const file = join(work, 'big.bin');
        await writeFile(file, noiseBytes(64));

        const linked = await store(root, { hashLimit: 16 }).adopt({ path: file });
        expect(linked.bytes).toBe(64);
        expect(linked.sha256).toBeUndefined();
    });
});

describe('嗅探的三种来源都落到同一个 ref 形状', () => {
    it('png / jpeg / gif 的尺寸都读得出来', async () => {
        const root = await tempRoot();
        const batch = store(root).beginBatch();
        const png = await batch.putBytes({ bytes: pngBytes(1440, 900), name: 'a.png', source: 'paste' });
        const jpeg = await batch.putBytes({ bytes: jpegBytes(100, 45), name: 'b.jpg', source: 'paste' });
        const gif = await batch.putBytes({ bytes: gifBytes(320, 200), name: 'c.gif', source: 'paste' });
        expect(png.image).toEqual({ width: 1440, height: 900 });
        expect(jpeg.image).toEqual({ width: 100, height: 45 });
        expect(gif.image).toEqual({ width: 320, height: 200 });
    });
});
