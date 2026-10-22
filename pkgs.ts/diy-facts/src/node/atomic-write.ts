// src/node/atomic-write.ts — 事实库落盘的**原子写原语**（##404 / ##5 第 11 轮 A）
//
// 与 `pkgs.ts/diy-app/src/main/core/atomic-write.ts` 是**同范式、两份实现**，不是抄漏：
// 依赖方向是 `diy-app → diy-facts`（内核与存储层不许反向依赖 UI 层），所以这里自持一份。
// **改语义时两处一起改**（`scripts/check-atomic-write.mjs` 把两个文件都列为原语豁免，
// 别把这条豁免当成"随便写都行"）。
//
// 为什么必须原子：直接 `writeFileSync(目标, …)` 是**先把目标清空再写** —— ENOSPC / 配额 / 被中断
// 就留下 0 字节或半截文件。事实库的 yaml 是**唯一真源**（没有数据库兜底），写坏一章 = 那一批
// 知识凭空消失。做法与 diy-app 相同：同目录 tmp → `rename` 覆盖。
//
// 本文件比 diy-app 那份多一件事：**多文件两阶段**。
// 一次 `facts submit` 会同时重写 N 个 `facts/*.yaml` + `subjects.yaml` + `expose.yaml`。
// 逐个「写 tmp → rename」的话，第 5 个失败时前 4 个已经换掉了 —— 校验层刚做成的
// 「全过才写」在 IO 层漏成半截。两阶段：
//   ① 把 N 份 tmp **全部**写出来（此时目标一个字没动）；
//   ② 再逐个 rename（只做目录项替换，窗口小到可忽略；失败也只影响自身）。
// 任一阶段失败 ⇒ **清掉本批所有 tmp**，目标保持原样，原错误原样上抛。
// 跨文件严格原子（要么全换要么全不换）在 POSIX 上没有廉价实现（需要目录交换 / 日志），
// 这里买到的是：**每个文件要么全旧要么全新**，且**不留残骸**。
//
// tmp 名 = `<目标>.tmp-<pid>-<rand>`：
//   · 带 rand —— 同进程两批 submit 并发时，固定名会互相踩（A 的 rename 搬走 B 的内容）；
//   · 后缀不是 `.yaml` —— 加载侧按扩展名筛文件，残留 tmp 不会被当成一章事实读进来。
// 目标已存在 ⇒ tmp 继承其权限位（否则默认 0644 会把 chmod 600 的库文件放宽）。

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 本原语用到的文件系统面（**依赖注入口**：测试在真盘上做确定性故障注入）。 */
export interface FsLike {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
    renameSync: typeof renameSync;
    rmSync: typeof rmSync;
    statSync: typeof statSync;
    chmodSync: typeof chmodSync;
}

/** 缺省实现 = 真 `node:fs`（生产调用点一律不传）。 */
export const realFs: FsLike = { mkdirSync, writeFileSync, renameSync, rmSync, statSync, chmodSync };

/** 一份待写文件（`text` 是**全文**，本原语只做整文件覆盖）。 */
export interface AtomicWrite {
    file: string;
    text: string;
}

/** 某个目标的 tmp 落点（测试用它断言"没有残骸"）。 */
export function tempPathOf(file: string, nonce = randomBytes(4).toString('hex')): string {
    return path.join(path.dirname(file), `${path.basename(file)}.tmp-${process.pid}-${nonce}`);
}

/**
 * 整批覆盖写（两阶段）。
 *
 * 契约（调用方可依赖的只有这三条）：
 *   · 成功 = **每个**目标文件内容整体换成新的。
 *   · 失败 = **原样上抛**；每个目标文件要么保持旧内容、要么是完整新内容（绝无半截）。
 *   · 失败时本批 tmp 已清理（尽力而为，清理失败也不掩盖原错误）。
 */
export function writeFilesAtomic(writes: readonly AtomicWrite[], opts: { fs?: FsLike } = {}): void {
    if (writes.length === 0) return;
    const fs = opts.fs ?? realFs;
    const nonce = randomBytes(4).toString('hex');
    // 一个目标一份 tmp：nonce 全批共享，但文件名里还带目标 basename ⇒ 不会撞
    const legs = writes.map((w) => ({ target: w.file, tmp: tempPathOf(w.file, nonce), text: w.text }));
    const written: string[] = [];

    // ① 先写全部 tmp（目标此刻一个字没动）
    try {
        for (const leg of legs) {
            fs.mkdirSync(path.dirname(leg.target), { recursive: true });
            fs.writeFileSync(leg.tmp, leg.text, 'utf-8');
            written.push(leg.tmp);
            inheritMode(fs, leg.target, leg.tmp);
        }
    } catch (e) {
        cleanup(fs, written);
        throw e;
    }

    // ② 再逐个 rename（只换目录项）
    let done = 0;
    try {
        for (const leg of legs) {
            fs.renameSync(leg.tmp, leg.target);
            done += 1;
        }
    } catch (e) {
        // 已 rename 的收不回来（它们内容是完整的，允许），未 rename 的 tmp 一并清掉
        cleanup(fs, written.slice(done));
        throw e;
    }
}

/** 让 tmp 继承目标**既有**的权限位（目标不存在 = 新建，用缺省；stat 失败同样不阻断）。 */
function inheritMode(fs: FsLike, target: string, tmp: string): void {
    try {
        fs.chmodSync(tmp, fs.statSync(target).mode & 0o777);
    } catch {
        /* 目标不存在（新建）或不可 stat —— 保持缺省权限，不影响写入本身 */
    }
}

function cleanup(fs: FsLike, tmps: readonly string[]): void {
    for (const tmp of tmps) {
        try {
            fs.rmSync(tmp, { force: true });
        } catch {
            /* 真正的错因在调用方上抛的那个 e 里；残骸清不掉不该盖住它 */
        }
    }
}
