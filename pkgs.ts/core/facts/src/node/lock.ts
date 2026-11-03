// src/node/lock.ts — 事实库写入的**跨进程互斥**（##404 / ##9 review P0）
//
// 为什么需要（实测事故）：两个进程各跑一次 `facts submit`，两边都报 `added`，磁盘上只剩后者
// —— `writeFilesAtomic` 只保证「**单批**两阶段」（每文件要么全旧要么全新），它管不了
// **批与批之间**：B 在 A 之前读了库、在 A 之后 rename，A 的条目就被整篇盖掉，且两边都不报错。
// 三个 agent 在同一个仓里并行改 knowledge/ 是常态（本轮两个 worktree 就同时在改），
// 丢的又是唯一真源 —— 所以「读-改-写」必须整体是个临界区。
//
// 判据（调用方只能依赖这三条）：
//   · `fn` 期间**本机**没有别的进程在同一 `knowledgeDir` 上跑 `fn`；
//   · 放弃等待 ⇒ 抛 `facts/write-busy`，**不是**"照写"（宁可让它重试，不许静默丢更新）；
//   · 无论 `fn` 抛不抛，锁都会被释放（异常 / 进程被杀都不留死锁）。
//
// 锁的落点为什么在**系统临时目录**而不是库里：
//   · 库可能还不存在（懒建，「读不产生副作用」是硬判据）—— 抢锁不该顺手把 `knowledge/` 建出来；
//   · 锁不是知识资产，不该进 git、也不该被 `git status` 看见。
//   代价：锁是**本机**语义（同一台机器上的多进程），跨机共享目录不在射程内 —— 事实库是本地库，
//   `git merge` 那条路（P1②）另行治理。
//
// 锁的形态 = **原子 mkdir**（`mkdir` 在已存在时抛 EEXIST，是 POSIX 上最便宜的互斥原语），
// 目录里放 `pid` 文件供**陈旧检测**：持有者崩了（pid 不在了）⇒ 后来者接管，不必等超时。
// 本文件是同步实现（`submit` 全链路同步，加一个异步入口等于把临界区劈成两半）。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 抢锁失败（等到超时仍未拿到）。code 与全仓 error 口径一致：`<域>/<kebab-case>`。 */
export class FactsLockError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'FactsLockError';
    }
}

export interface LockOptions {
    /** 最多等多久（缺省 20s）。持有者活着就一直等 —— 活着的进程手里的锁是**真锁**，不许抢 */
    timeoutMs?: number;
    /** 重试间隔（缺省 25ms）。同步等待，故取值要小；也不为 0（空转会烧满一个核） */
    retryMs?: number;
    /** 锁根目录（缺省 `os.tmpdir()/diy-facts-locks`；测试用它隔离） */
    root?: string;
    /** 时钟 / 睡眠注入（测试用；生产不传） */
    now?: () => number;
    sleep?: (ms: number) => void;
}

/** 同步睡眠：`Atomics.wait` 是唯一不烧 CPU 的同步等待（`execFileSync('sleep')` 贵得多）。 */
function syncSleep(ms: number): void {
    // sync-io-ok: 同步等待本身（不碰磁盘 / 不 fork），且被 timeoutMs 严格封顶
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 某个库的锁目录路径。
 *
 * 用 `<sha1(绝对路径)>.lock` 而不是 `<basename>.lock`：两个库同名（`knowledge`）是常态，
 * 按名字会在它们之间制造假冲突。sha1 只做**目录名归一**，不承担任何安全职责。
 */
export function lockPathOf(knowledgeDir: string, opts: LockOptions = {}): string {
    const root = opts.root ?? path.join(os.tmpdir(), 'diy-facts-locks');
    const key = createHash('sha1').update(path.resolve(knowledgeDir)).digest('hex').slice(0, 16);
    return path.join(root, `${key}.lock`);
}

interface Holder {
    readonly pid: number;
    readonly at: number;
}

function readHolder(lockDir: string): Holder | null {
    const file = path.join(lockDir, 'pid');
    if (!existsSync(file)) return null;
    const [pidRaw, atRaw] = readFileSync(file, 'utf8').trim().split(/\s+/);
    const pid = Number.parseInt(pidRaw ?? '', 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const at = Number.parseInt(atRaw ?? '', 10);
    return { pid, at: Number.isFinite(at) ? at : 0 };
}

/** 持有者还活着吗（`kill(pid, 0)` 不发送信号、只做存在性探测）。 */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM = 进程在、只是不是我们能动它 ⇒ 活着
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * 这把锁是不是**残骸**（持有者已不在）而不是**真锁**。
 *
 * 三种情形：
 *   · 锁目录存在但 `pid` 还没写进来 —— 之间只有「mkdir 成功 → writeFileSync」这一瞬，
 *     超过 2s 还这样就是当年崩在这条缝里了（mkdir 已成、pid 未落）⇒ 残骸；
 *   · `pid` 就是**本进程** —— 本进程此刻并没有持锁（持锁期间不会再进这里），
 *     说明是上一次同 pid 的残骸（或 pid 被复用）⇒ 残骸；
 *   · `pid` 指向的进程不在了 ⇒ 残骸。
 *
 * 活着且不是自己的进程 ⇒ **永不判残骸**（会等到 timeoutMs 报 `facts/write-busy`）：
 * 抢一个活进程手里的锁，等于把这条锁的意义整个取消（丢失更新立刻复发）。
 */
function isStale(lockDir: string): boolean {
    const holder = readHolder(lockDir);
    if (holder === null) {
        try {
            return Date.now() - statSync(lockDir).mtimeMs > 2000;
        } catch {
            return false;
        }
    }
    if (holder.pid === process.pid) return true;
    return !alive(holder.pid);
}

function tryAcquire(lockDir: string): boolean {
    try {
        // 原子创建（已存在 ⇒ EEXIST）：整个互斥就靠这一行
        mkdirSync(lockDir, { recursive: false });
    } catch {
        return false;
    }
    try {
        // 目标文件刚由本进程独占创建（`mkdir` 成功那一刻起没人能写它）；就算崩在写一半，
        // 读到坏 pid 也只会被判残骸接管 —— 没有第三方会读这份 pid，故不需要 tmp+rename。
        // non-atomic-ok: 独占新建的一次性标记文件，读者只可能是"接管残骸"的那条路径
        writeFileSync(path.join(lockDir, 'pid'), `${process.pid} ${Date.now()}\n`, 'utf8');
    } catch {
        // pid 写不进去（几乎不可能）：锁已建成但不可读 ⇒ 直接放弃这一把，别占着坑
        rmSync(lockDir, { recursive: true, force: true });
        return false;
    }
    return true;
}

/**
 * 在「本库独占」的前提下执行 `fn`。
 *
 * ⚠️ `fn` 必须把**读库**也包进来（读-改-写整体是临界区）。只把写包进来等于没加锁：
 * 读到的仍是别人写之前的旧内容，rename 照样覆盖。
 */
export function withLibraryLock<T>(knowledgeDir: string, fn: () => T, opts: LockOptions = {}): T {
    const lockDir = lockPathOf(knowledgeDir, opts);
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const retryMs = opts.retryMs ?? 25;
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? syncSleep;
    mkdirSync(path.dirname(lockDir), { recursive: true });
    const start = now();
    for (;;) {
        if (tryAcquire(lockDir)) break;
        if (isStale(lockDir)) {
            rmSync(lockDir, { recursive: true, force: true });
            continue;
        }
        if (now() - start >= timeoutMs) {
            const holder = readHolder(lockDir);
            throw new FactsLockError(
                'facts/write-busy',
                `另一个进程正在写这个库（pid ${holder?.pid ?? '?'}），等了 ${Math.round((now() - start) / 1000)}s 仍未被释放：${knowledgeDir}\n` +
                    '并发写是允许的（本锁会串行化），但持有者超过 20s 没结束通常意味着它卡住了。' +
                    '确认那个进程后重试；真要放弃就删掉这把锁：' + lockDir,
            );
        }
        sleep(retryMs);
    }
    try {
        return fn();
    } finally {
        rmSync(lockDir, { recursive: true, force: true });
    }
}
