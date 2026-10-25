// tests/lock.test.ts — 并发写不丢条目的判据（##404 / ##9 review P0）
//
// 压的是**丢失更新**这件事本身，所以每条都在真盘 + 真子进程上跑：
//   · 同一进程里两次 `submit` 天然串行（同步函数），永远豁不出这个 bug —— 只能真开进程；
//   · mock 锁的测试证明不了"两个 agent 同时写会不会丢"，那是本文件存在的唯一理由。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FactsLockError, lockPathOf, withLibraryLock } from '../src/node/lock';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src/node');
/** 仓库根的 tsx（子进程直接跑 TS 源；不依赖构建产物 —— 测试不该要求先 build） */
const TSX = path.resolve(here, '../../..', 'node_modules/.bin/tsx');

const tmp: string[] = [];
function tempDir(prefix = 'facts-lock-'): string {
    const d = mkdtempSync(path.join(os.tmpdir(), prefix));
    tmp.push(d);
    return d;
}
afterEach(() => {
    for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 起一个子进程跑给定 TS 源（源写在临时文件里，import 绝对路径指向本包 src）。 */
function runScript(script: string, args: readonly string[]): Promise<{ code: number | null; stderr: string; pid?: number }> {
    const dir = tempDir('facts-child-');
    const file = path.join(dir, 'child.ts');
    writeFileSync(file, script);
    return new Promise((resolve, reject) => {
        const child = spawn(TSX, [file, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (b: Buffer) => {
            stderr += b.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr, pid: child.pid }));
    });
}

describe('withLibraryLock', () => {
    it('拿到锁执行 fn，结束后释放（下一个能立刻取到）', () => {
        const kb = path.join(tempDir(), 'knowledge');
        const lock = lockPathOf(kb);
        expect(withLibraryLock(kb, () => (existsSync(lock) ? 'held' : 'missing'))).toBe('held');
        expect(existsSync(lock)).toBe(false);
    });

    it('fn 抛异常也释放锁（异常不许变成死锁）', () => {
        const kb = path.join(tempDir(), 'knowledge');
        expect(() =>
            withLibraryLock(kb, () => {
                throw new Error('boom');
            }),
        ).toThrow(/boom/);
        expect(existsSync(lockPathOf(kb))).toBe(false);
        expect(withLibraryLock(kb, () => 1)).toBe(1);
    });

    it('持有者是**活着的别的进程** ⇒ 等到超时后报 facts/write-busy，而不是照写', async () => {
        const kb = path.join(tempDir(), 'knowledge');
        const holder = runScript(
            `import { withLibraryLock } from ${JSON.stringify(path.join(SRC, 'lock.ts'))};
             withLibraryLock(process.argv[2], () => {
                 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
             });
             process.stdout.write('done');`,
            [kb],
        );
        // 等子进程真的把锁建出来再抢（轮询的是"锁目录存在"，不是固定 sleep）
        for (let i = 0; i < 200 && !existsSync(lockPathOf(kb)); i += 1) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        expect(existsSync(lockPathOf(kb))).toBe(true);
        let caught: unknown;
        try {
            withLibraryLock(kb, () => 'never', { timeoutMs: 120 });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(FactsLockError);
        expect((caught as FactsLockError).code).toBe('facts/write-busy');
        // 子进程释放后，本进程能正常取到 —— 不许留下"永久锁"
        await holder;
        expect(existsSync(lockPathOf(kb))).toBe(false);
        expect(withLibraryLock(kb, () => 'ok')).toBe('ok');
    });

    it('持有者已死 ⇒ 接管残骸，不等超时', async () => {
        const kb = path.join(tempDir(), 'knowledge');
        // 拿一个**确定已退出**的进程号当残骸（pid 复用概率可忽略，且判据只看"在不在"）
        const ghost = await runScript('process.exit(0);', []);
        expect(ghost.code).toBe(0);
        const lock = lockPathOf(kb);
        mkdirSync(lock, { recursive: true });
        expect(ghost.pid).toBeTypeOf('number');
        writeFileSync(path.join(lock, 'pid'), `${ghost.pid} 0\n`);
        expect(withLibraryLock(kb, () => 'took-over', { timeoutMs: 100 })).toBe('took-over');
    });

    it('pid 是本进程但本进程并未持锁 ⇒ 判残骸（同 pid 残留不许把自己锁死）', () => {
        const kb = path.join(tempDir(), 'knowledge');
        const lock = lockPathOf(kb);
        mkdirSync(lock, { recursive: true });
        writeFileSync(path.join(lock, 'pid'), `${process.pid} ${Date.now()}\n`);
        expect(withLibraryLock(kb, () => 'ok', { timeoutMs: 100 })).toBe('ok');
    });

    it('不同库用不同的锁（同名 knowledge 目录不许假冲突）', () => {
        const a = path.join(tempDir(), 'a', 'knowledge');
        const b = path.join(tempDir(), 'b', 'knowledge');
        expect(lockPathOf(a)).not.toBe(lockPathOf(b));
    });
});

describe('提交并发（真场景：N 个进程各写一条，一条都不许丢）', () => {
    const SUBMIT_CHILD = `import { submit } from ${JSON.stringify(path.join(SRC, 'index.ts'))};
const [kb, id] = process.argv.slice(2);
const aspect = id.slice(id.lastIndexOf('.') + 1);
const { problems } = submit(kb, {
    facts: [{
        id,
        subject: 'kb.conc',
        aspect,
        value: 'value of ' + id,
        review: 'accepted',
        lifecycle: 'active',
        evidence: { source: 'code', at: 'README.md:1', verifiedAt: '2026-10-21' },
    }],
    subjects: [{ key: 'kb.conc', description: '并发写自检主题' }],
});
// 判据只有一条：**没写进去就必须吵**（否则"静默失败"会让并发测试假绿）
const errors = problems.filter((p) => p.level === 'error');
if (errors.length > 0) {
    process.stderr.write(JSON.stringify(errors));
    process.exit(1);
}
process.stdout.write('ok');`;

    function factIds(kb: string): string[] {
        const factsDir = path.join(kb, 'facts');
        if (!existsSync(factsDir)) return [];
        const text = readdirSync(factsDir)
            .filter((f) => f.endsWith('.yaml'))
            .map((f) => readFileSync(path.join(factsDir, f), 'utf8'))
            .join('\n');
        return [...text.matchAll(/^\s+id:\s*'?([\w.]+)'?\s*$/gm)].map((m) => m[1] as string);
    }

    it('8 个进程并行各提交一条 ⇒ 8 条全在（无静默丢失更新）', async () => {
        const parent = tempDir();
        const kb = path.join(parent, 'knowledge');
        // 证据文件真的存在（库里的事实必须给得可校验的锚，这是库自己的判据，测试不该绕过）
        writeFileSync(path.join(parent, 'README.md'), 'lock test\n');
        const ids = Array.from({ length: 8 }, (_, i) => `kb.conc.a${i}`);
        const runs = await Promise.all(ids.map((id) => runScript(SUBMIT_CHILD, [kb, id])));
        for (const r of runs) {
            expect(r.code, r.stderr).toBe(0);
        }
        const onDisk = factIds(kb);
        expect(onDisk.sort()).toEqual([...ids].sort());
    }, 60_000);
});
