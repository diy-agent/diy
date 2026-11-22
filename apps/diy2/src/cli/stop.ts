// src/cli/stop.ts —— 停一个进程（SIGTERM → 等 → SIGKILL）。
//
// 单独一个文件的理由只有一个：**断开循环依赖**。`instance.ts`（命令树）与 `web.ts`
// （进程生命周期）都要用它，而 web.ts 又要被 instance.ts 引用（`diy2 web` 是顶层命令）——
// 放在任一侧都会成环（实测：instance 顶层求值时 webProcedure 还在 TDZ 里）。
// 判据：谁都不依赖、只被两边 import 的东西，单独成模块。

import { isPidAlive } from '../../server/registry';

const STOP_TIMEOUT_MS = 3000;
const STOP_POLL_MS = 100;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/** SIGTERM → 等 → 仍在则 SIGKILL；返回是否真的发过信号（已经没了 = false） */
export async function stopOne(pid: number): Promise<boolean> {
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        return false;
    }
    const startedAt = Date.now();
    while (isPidAlive(pid) && Date.now() - startedAt < STOP_TIMEOUT_MS) await delay(STOP_POLL_MS);
    if (isPidAlive(pid)) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            /* 刚好自己退了 */
        }
    }
    return true;
}
