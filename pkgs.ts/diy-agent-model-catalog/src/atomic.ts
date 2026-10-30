// atomic.ts — 本包唯一的整文件写原语：同目录 tmp → rename 覆盖。
//
// 为什么必须有：直接 `writeFileSync(目标, …)` 是先清空再写，写失败（磁盘满 / 中断）会留下
// 半截文件，而 model.yaml / providers.custom.yaml 是用户手编的**唯一真源**，写坏就是丢配置。
// 语义与 pkgs.ts/diy-app/src/main/core/atomic-write.ts 对齐（那是 diy-app 的实现，本包不依赖
// diy-app，故按同一口径留一份最小实现）：
//   · 成功 = 目标整体换成新内容；rename 是 POSIX 原子操作，读者看不到半截。
//   · 失败 = 原样上抛，目标文件逐字不变；自己的 tmp 尽力清掉。
//   · tmp 必须与目标同目录（跨目录 rename 退化 copy+unlink，丢原子性）。
//   · tmp 名带 pid + 随机串，避免两个进程同时写互相踩。
//   · 目标已存在则继承其权限位（配置文件常是 600，别被 rename 悄悄放宽成 644）。

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function writeFileAtomic(path: string, content: string): void {
    const tmp = join(dirname(path), `${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, content, 'utf-8');
        inheritMode(path, tmp);
        renameSync(tmp, path);
    } catch (e) {
        try {
            rmSync(tmp, { force: true });
        } catch {
            /* 真正的错因在 e 里 */
        }
        throw e;
    }
}

function inheritMode(target: string, tmp: string): void {
    try {
        chmodSync(tmp, statSync(target).mode & 0o777);
    } catch {
        /* 目标不存在（新建）或不可 stat —— 保持缺省权限 */
    }
}
