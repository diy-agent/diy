// tests/run-status.test.ts —— 呈现口径里**与着色有关**的那一条。
//
// 为什么补这一条：2026-11-23 实测的 `job-done` 通知整段是 `\u001b[38;5;255;48;5;66;1m`
// 这样的色码（sha.sh 在终端里上的色）。tail 的去处是聊天记录 / 模型上下文 —— 那里它只是
// 乱码，还占 token。判据：取尾部时去掉，`out.log` 原文件不动。

import { describe, expect, it } from 'vitest';

import { stripAnsi, tailOf } from '../src/run-status.js';

describe('stripAnsi', () => {
    it('去掉色码、保留正文', () => {
        expect(stripAnsi('\u001b[38;5;255;48;5;66;1m./sha.sh check\u001b[0m')).toBe('./sha.sh check');
    });

    it('没有色码时原样返回', () => {
        expect(stripAnsi('退出码 0')).toBe('退出码 0');
    });
});

describe('tailOf', () => {
    it('交给上层的尾部已经不含色码（否则通知文案会整段是乱码）', () => {
        const raw = '\u001b[1m[1] 心跳\u001b[0m\n\u001b[38;5;66m[2] 心跳\u001b[0m\n';
        expect(tailOf(raw, 10).text).toBe('[1] 心跳\n[2] 心跳');
    });

    it('截断字节数照实报（色码也占字节：报告的是原文被砍了多少）', () => {
        const raw = `${'\u001b[38;5;66m'}x${'\u001b[0m'}`.repeat(2000);
        expect(tailOf(raw, 10_000, 64).droppedBytes).toBeGreaterThan(0);
    });
});
