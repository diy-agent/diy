// detach-log.test.ts —— 后台输出落盘的三条硬性质：
//   ① 路径口径（<home>/log/stdout.log，目录自动建）；
//   ② append 语义（重复打开不截断）；
//   ③ 超限滚动（>10MB → 挪成 .1，新开的空文件接手）—— 打不开退回 null 的路径不测
//      （那要模拟 fs 故障，收益不抵成本；openDetachLog 的 catch 已保证不抛）。

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDetachLog, detachLogPath, openDetachLog } from '../src/cli/detach-log';

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'diy2-detach-log-'));
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

describe('detach-log', () => {
    it('路径 = <home>/log/stdout.log；打开即建目录', () => {
        const file = detachLogPath(home);
        expect(file).toBe(join(home, 'log', 'stdout.log'));

        const fd = openDetachLog(home);
        expect(fd).not.toBeNull();
        closeDetachLog(fd);
        expect(existsSync(file)).toBe(true);
    });

    it('append：第二次打开接着写，不截断', () => {
        const file = detachLogPath(home);
        const fd1 = openDetachLog(home);
        expect(fd1).not.toBeNull();
        closeDetachLog(fd1);

        const fd2 = openDetachLog(home);
        expect(fd2).not.toBeNull();
        closeDetachLog(fd2);
        // 打开本身不写内容，但绝不能把已有内容弄丢 —— 用写入验证 append
        writeFileSync(file, '第一行\n', { flag: 'a' });
        const fd3 = openDetachLog(home);
        closeDetachLog(fd3);
        writeFileSync(file, '第二行\n', { flag: 'a' });
        expect(readFileSync(file, 'utf8')).toBe('第一行\n第二行\n');
    });

    it('超 10MB 滚动为 .1，新文件从空接手', () => {
        const file = detachLogPath(home);
        mkdirSync(dirname(file), { recursive: true }); // 目录由 openDetachLog 建，这里先摆好现场
        writeFileSync(file, 'x'.repeat(10 * 1024 * 1024 + 1));

        const fd = openDetachLog(home);
        closeDetachLog(fd);

        expect(statSync(`${file}.1`).size).toBe(10 * 1024 * 1024 + 1);
        expect(statSync(file).size).toBe(0);
    });

    it('closeDetachLog 对 null / 重复关闭都不抛', () => {
        expect(() => closeDetachLog(null)).not.toThrow();
        const fd = openDetachLog(home);
        expect(fd).not.toBeNull();
        closeDetachLog(fd);
        expect(() => closeDetachLog(fd)).not.toThrow();
    });
});
