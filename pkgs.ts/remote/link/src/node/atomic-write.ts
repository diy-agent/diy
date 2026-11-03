// 最小原子写（同目录临时文件 + rename）。
//
// 为什么不 import diy-app 的 atomic-write：本包要能被 serve / CLI 独立使用，不该反向依赖应用包。
// 写的是「身份文件」这种极小文本，够用即可（不追求 fsync：进程崩溃丢一次身份文件会重新生成 id，
// 与设备断电一类事故同量级，代价可接受）。

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function writeFileAtomic(file: string, content: string): void {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    try {
        writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
        renameSync(tmp, file);
    } catch (e) {
        try {
            rmSync(tmp, { force: true });
        } catch {
            /* 忽略 */
        }
        throw e;
    }
}
