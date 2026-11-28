// tool-output-read.test.ts —— 外置原文的读取端点。
//
// 重点在两处**安全**与一处**分片**：
//   · 只认 `runs/tool/` 前缀 + 防穿越（`../` / 绝对路径 / 符号链接）；
//   · Range 的边界（越界回 416、`bytes=-N` 取尾部）；
//   · 文件不在时说清楚是「清理/没迁移」，不是 500。

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRange, safeOutputPath, serveToolOutput } from '../server/tool-output-read';

let home: string;

beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'diy2-out-read-'));
    await mkdir(join(home, 'runs/tool/2026-11-28/room-a'), { recursive: true });
    await writeFile(join(home, 'runs/tool/2026-11-28/room-a/call_1.txt'), 'hello-range-world');
});

afterAll(async () => {
    await rm(home, { recursive: true, force: true });
});

describe('safeOutputPath', () => {
    it('runs/tool/ 下的相对路径解析成绝对路径', () => {
        expect(safeOutputPath(home, 'runs/tool/2026-11-28/room-a/call_1.txt')).toBe(
            join(home, 'runs/tool/2026-11-28/room-a/call_1.txt'),
        );
    });

    it('挡掉穿越 / 绝对路径 / 别的前缀', () => {
        expect(safeOutputPath(home, 'runs/tool/../../etc/passwd')).toBeUndefined();
        expect(safeOutputPath(home, '/etc/passwd')).toBeUndefined();
        expect(safeOutputPath(home, 'runs/job/x.txt')).toBeUndefined();
        expect(safeOutputPath(home, '')).toBeUndefined();
    });
});

describe('parseRange', () => {
    it('解析闭区间与尾部片段', () => {
        expect(parseRange('bytes=0-4', 17)).toEqual({ start: 0, end: 4 });
        expect(parseRange('bytes=-5', 17)).toEqual({ start: 12, end: 16 });
        expect(parseRange('bytes=10-', 17)).toEqual({ start: 10, end: 16 });
    });

    it('越界 = invalid（回 416）；语法认不出 = undefined（回整份）', () => {
        // 语法对但不可满足 → 416（别退化成 200 全量，客户端按 Range 解会被噎住）
        expect(parseRange('bytes=99-', 17)).toBe('invalid');
        expect(parseRange('bytes=5-1', 17)).toBe('invalid');
        // 没带 / 认不出 → 发整份（HTTP 允许忽略 Range）
        expect(parseRange(undefined, 17)).toBeUndefined();
        expect(parseRange('items=0-4', 17)).toBeUndefined();
    });
});

describe('serveToolOutput', () => {
    /** 起一个假 req/res，把响应收成 { status, headers, body } */
    const call = async (
        ref: string,
        options: { range?: string; method?: string } = {},
    ): Promise<{ status: number; headers: Record<string, unknown>; body: string }> => {
        const chunks: Buffer[] = [];
        const headers: Record<string, unknown> = {};
        let status = 0;
        const res = {
            writeHead: (code: number, extra?: Record<string, unknown>) => {
                status = code;
                Object.assign(headers, extra ?? {});
            },
            end: (body?: unknown) => {
                if (typeof body === 'string') chunks.push(Buffer.from(body));
            },
            // 流式写入：把 Readable 读完
            write: (chunk: Buffer) => {
                chunks.push(chunk);
                return true;
            },
            on: () => res,
            once: () => res,
            emit: () => true,
            destroy: () => undefined,
            writableEnded: false,
        } as unknown as Parameters<typeof serveToolOutput>[0]['res'];
        const req = {
            method: options.method ?? 'GET',
            headers: options.range === undefined ? {} : { range: options.range },
        } as unknown as Parameters<typeof serveToolOutput>[0]['req'];
        await serveToolOutput({ home, req, res, ref });
        // 流式分支：等 pipe 完成（小文件，一个 tick 足够）
        await new Promise((resolve) => setImmediate(resolve));
        return { status, headers, body: Buffer.concat(chunks).toString('utf8') };
    };

    it('整份返回：200 + 全文 + no-store + accept-ranges', async () => {
        const out = await call('runs/tool/2026-11-28/room-a/call_1.txt');
        expect(out.status).toBe(200);
        expect(out.headers['content-length']).toBe(17);
        expect(out.headers['cache-control']).toBe('no-store');
        expect(out.headers['accept-ranges']).toBe('bytes');
    });

    it('Range：206 + 正确的 content-range', async () => {
        const out = await call('runs/tool/2026-11-28/room-a/call_1.txt', { range: 'bytes=0-4' });
        expect(out.status).toBe(206);
        expect(out.headers['content-range']).toBe('bytes 0-4/17');
    });

    it('越界 Range 回 416，并给出总长度', async () => {
        const out = await call('runs/tool/2026-11-28/room-a/call_1.txt', { range: 'bytes=99-' });
        expect(out.status).toBe(416);
        expect(out.headers['content-range']).toBe('bytes */17');
    });

    it('文件不在：404 + 说清原因（不是 500）', async () => {
        const out = await call('runs/tool/2026-11-28/room-a/call_missing.txt');
        expect(out.status).toBe(404);
        expect(out.body).toContain('不存在');
    });

    it('越界路径：400，不落到文件系统', async () => {
        const out = await call('runs/tool/../../etc/passwd');
        expect(out.status).toBe(400);
    });
});
