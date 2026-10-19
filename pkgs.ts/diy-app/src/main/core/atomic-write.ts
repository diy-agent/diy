// src/main/core/atomic-write.ts
// 🎯 唯一原子写原语：**整文件覆盖**一律走这里 —— 同目录 tmp → `rename` 覆盖。
//
// 为什么必须有（##382）：直接 `writeFileSync(目标, …)` 是**先把目标清空再写**，写失败（磁盘满
// ENOSPC、配额、权限、被中断）就留下 0 字节 / 半截文件，**原内容毫无保底**。2026-10-18 实测：
// `diy task edit` 追加 body 时 ENOSPC，`projects/4/tasks/166/AGENTS.md` 被写成 0 字节，
// 253KB / 34 章正文全靠 git blob + /tmp 段文件 + llm.jsonl 三源才拼回来。
//
// 语义（调用方可依赖的只有这三条）：
//   · 成功 = 目标内容**整体**换成新内容。rename 是 POSIX 原子操作 ⇒ 并发读者 / 崩溃都看不到半截文件。
//   · 失败 = **原样上抛**（绝不吞、绝不降级成「写成功」），且**目标文件逐字不变**（我们从头到尾
//     没写过目标本身，连它的 mtime 都不动）。
//   · 失败时自己的 tmp 已清理。清理是尽力而为：清理失败也**不掩盖原错误**（抛的仍是 e）。
//
// 边界与取舍：
//   · 父目录不存在 → 先 `mkdir -p`（与各处旧实现一致；写文件的人不该各自再写一遍 mkdir）。
//   · tmp 必须与目标**同目录** —— 跨目录 rename 退化 copy+unlink（丢原子性），跨设备直接 EXDEV。
//   · tmp 名 = `<目标>.tmp-<pid>-<rand>`，**不用固定 `${path}.tmp`**：两处代码 / 两个进程同时写
//     同一目标时固定名会互相踩（A 的 rename 可能搬走 B 的半个文件）。残留 tmp 是自家产物，可随时清。
//   · 目标已存在 → tmp **继承其权限位**再 rename（否则默认 0644 会放宽 chmod 600 的私密文件，见 inheritMode）。
//   · 缺省**不** fsync：本仓所有整文件写都是「可重建的投影 / 用户可见文本」，每次多一次磁盘同步不划算。
//     要掉电耐久（写完就必须在盘上）传 `{ fsync: true }`。目录项不 fsync（同上，代价不值当）。
//
// 收敛史（##382）：本文件是唯一实现。原先散落各处的私有版本
// （services/prompt-registry.ts · core/flow-store.ts · core/model-config.ts · core/drafts.ts ·
// services/local-agent.ts 的 llm 日志重建）已收敛到这里 —— 各写一遍必然分叉，分叉就是「有的写点
// 原子、有的不原子」，而**不原子的那些正是会毁正文的**。

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface WriteFileAtomicOptions {
    /** 写后 fsync 临时文件（掉电耐久）。缺省 false —— 与收敛前各处行为一致，只是多一次磁盘同步的代价。 */
    fsync?: boolean;
}

/**
 * 整文件覆盖写（原子）。
 *
 * @param path 目标文件路径（父目录可不存在）
 * @param content 全文内容（UTF-8）
 * @throws 目标不可写 / 磁盘满 / rename 失败等 —— **原样上抛**，调用方自己决定要不要降级
 */
export function writeFileAtomic(path: string, content: string, opts: WriteFileAtomicOptions = {}): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = tempPathFor(path);
    try {
        writeFileSync(tmp, content, "utf-8");
        inheritMode(path, tmp);
        if (opts.fsync) syncFile(tmp);
        // 覆盖目标：POSIX rename 是原子的。读者要么看到旧内容、要么看到新内容，绝无半截。
        // （Windows 上 rename 覆盖已存在文件会失败 —— 本仓只在 macOS / Linux 跑，不为它加平台分支。）
        renameSync(tmp, path);
    } catch (e) {
        // 失败路径：清掉自己的 tmp，**目标文件不碰**（它从头到尾没被写过）。清理失败也抛原错误。
        try {
            rmSync(tmp, { force: true });
        } catch {
            /* 真正的错因在 e 里；清理失败至多是 tmp 已经不在了 */
        }
        throw e;
    }
}

/**
 * 让 tmp 继承目标**既有**的权限位（##383）：
 * tmp 由 `writeFileSync` 按 umask 建成 0644，直接 rename 会把用户 `chmod 600` 的私密文件
 * （如含 API key 的 `providers.custom.yaml`）**悄悄放宽**成 644。目标不存在（新建）/ stat 失败 → 用缺省。
 */
function inheritMode(target: string, tmp: string): void {
    try {
        chmodSync(tmp, statSync(target).mode & 0o777);
    } catch {
        /* 目标不存在（新建）或不可 stat —— 保持缺省权限，不影响写入本身 */
    }
}

/** 把 tmp 的内容刷到盘上（耐久开关，见头注）；目录项不刷。 */
function syncFile(p: string): void {
    const fd = openSync(p, "r+");
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/** 目标文件的临时兄弟：**同目录** + pid + 随机后缀（见头注「为什么不用固定 .tmp」）。 */
function tempPathFor(path: string): string {
    return join(dirname(path), `${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
}
