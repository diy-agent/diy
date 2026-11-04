// fs-lock.test.ts — 文件锁的获取/释放/过期接管
//
// ⚠️ 原来的版本用 `diyHome()` 拼锁路径 —— 测试会往**用户的真实数据根**写（碰生产数据）。
// 迁到公共包时一并改成 mkdtemp 隔离目录，这是这次迁移顺手修掉的一个隐患。

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryLock } from '../src/fs-lock.js';

let dir: string | undefined;
const tempDir = (): string => {
    dir = mkdtempSync(join(tmpdir(), 'diy-fs-lock-'));
    return dir;
};

afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
});

describe('tryLock', () => {
    it('获取成功返回 release，release 后目录消失', async () => {
        const lockPath = join(tempDir(), 'test-lock');
        const lock = await tryLock(lockPath, 1000);
        expect(lock).not.toBeNull();
        expect(lock!.release).toBeTypeOf('function');
        await lock!.release();
        expect(existsSync(lockPath)).toBe(false);
    });

    it('释放后可以重新获取', async () => {
        const lockPath = join(tempDir(), 'test-lock-2');
        const lock1 = await tryLock(lockPath, 1000);
        expect(lock1).not.toBeNull();
        await lock1!.release();
        const lock2 = await tryLock(lockPath, 1000);
        expect(lock2).not.toBeNull();
        await lock2!.release();
    });

    it('同进程重复获取会超时（锁被自己占着）', async () => {
        const lockPath = join(tempDir(), 'test-lock-3');
        const lock = await tryLock(lockPath, 1000);
        expect(lock).not.toBeNull();
        const second = await tryLock(lockPath, 200); // 短超时，别等 1 秒
        expect(second).toBeNull();
        await lock!.release();
    });

    it('持锁进程已死 ⇒ 接管（pid 文件里的进程不存在就清掉重试）', async () => {
        const lockPath = join(tempDir(), 'test-lock-stale');
        mkdirSync(lockPath, { recursive: true });
        // 一个几乎不可能存在的 pid（Linux/macOS 的 pid_max 通常远小于它）
        writeFileSync(join(lockPath, 'pid'), '999999', 'utf-8');
        const lock = await tryLock(lockPath, 1000);
        expect(lock, '死进程留下的锁应该能被接管').not.toBeNull();
        await lock!.release();
    });
});
