// output-store.test.ts —— 工具输出原文外置（2026-11-28）。
//
// 锁三件事：
//   1. 小输出**不外置**（条目不搬家，读路径不变）；
//   2. 超阈值 ⇒ 正文进文件、条目只留 ref + 头尾预览；
//   3. 写盘失败 ⇒ 返回 undefined（调用方退回「正文留在条目里」），绝不假装成功。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OUTPUT_OFFLOAD_BYTES, createOutputStore, toolOutputRelPath } from '../src/output-store';

let roots: string[] = [];

function tmpRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diy-output-'));
    roots.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
    roots = [];
});

/** 造一段确定大小的文本（带换行，方便数行数） */
function bigText(bytes: number): string {
    const line = 'x'.repeat(99) + '\n';
    return line.repeat(Math.ceil(bytes / line.length));
}

describe('output-store', () => {
    it('小输出不外置（阈值以内一切留在条目里）', () => {
        const root = tmpRoot();
        const store = createOutputStore({ dataRoot: root });

        expect(store.put('task-a', 1000, 'call_1', 'hello')).toBeUndefined();
    });

    it('超阈值 ⇒ 正文落文件，ref 可读回原文', () => {
        const root = tmpRoot();
        const store = createOutputStore({ dataRoot: root });
        const text = bigText(OUTPUT_OFFLOAD_BYTES + 1024);

        const ref = store.put('task-a', 1000, 'call_1', text);

        expect(ref).toBeDefined();
        expect(ref?.ref).toBe(toolOutputRelPath('task-a', 1000, 'call_1'));
        expect(ref?.ref.startsWith('runs/tool/')).toBe(true);
        expect(ref?.truncated).toBe(true);
        expect(ref?.bytes).toBe(Buffer.byteLength(text, 'utf8'));
        expect(ref?.lines).toBe(text.split('\n').length);
        // 全文真的在文件里（不是只存了头尾）
        expect(readFileSync(join(root, ref!.ref), 'utf8')).toBe(text);
    });

    it('preview 是头尾各 40 行（不是整段复制）', () => {
        const root = tmpRoot();
        const store = createOutputStore({ dataRoot: root });
        const text = bigText(OUTPUT_OFFLOAD_BYTES + 1024);

        const ref = store.put('task-a', 1000, 'call_1', text);

        expect(ref?.preview.head.split('\n')).toHaveLength(40);
        expect(ref?.preview.tail.split('\n')).toHaveLength(40);
        // 头尾不重叠：最大的那份预览也只是原文的零头
        expect(ref!.preview.head.length + ref!.preview.tail.length).toBeLessThan(ref!.bytes / 2);
    });

    it('单行超长时 preview 截断到上限（防止 preview 自己变成大字段）', () => {
        const root = tmpRoot();
        const store = createOutputStore({ dataRoot: root });
        const oneLine = 'y'.repeat(OUTPUT_OFFLOAD_BYTES + 1024);

        const ref = store.put('task-a', 1000, 'call_1', oneLine);

        expect(ref?.preview.head.length).toBeLessThan(9000);
        expect(ref?.preview.head.endsWith('…')).toBe(true);
    });

    it('没有数据根（:memory: / 测试宿主）⇒ 一律不外置', () => {
        const store = createOutputStore({});
        expect(store.put('task-a', 1000, 'call_1', bigText(OUTPUT_OFFLOAD_BYTES + 10))).toBeUndefined();
    });

    it('写盘失败 ⇒ undefined（调用方把正文留在条目里，不丢内容）', () => {
        // 用「数据根是个文件」造一个必然失败的写路径
        const root = tmpRoot();
        const blocker = join(root, 'runs'); // 目录位置被一个普通文件占住 → mkdir 必失败
        const store = createOutputStore({ dataRoot: join(blocker, 'nested') });
        writeFileSync(blocker, 'x');

        expect(store.put('task-a', 1000, 'call_1', bigText(OUTPUT_OFFLOAD_BYTES + 10))).toBeUndefined();
    });
});
