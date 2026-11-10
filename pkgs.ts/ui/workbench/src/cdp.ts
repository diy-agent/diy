/**
 * cdp.ts —— CDP 调试端口的**唯一真源**（##518：dev 与 diy-app 同构）。
 *
 * 为什么要有这个文件：两个 app 之前各写各的 ——
 *   · diy-app：`--remote-debugging-port=0`（系统分配）+ 读 `userData/DevToolsActivePort`
 *   · dev：写死 `--remote-debugging-port=9223`
 * 于是两个 dev 实例同时起时，第二个 `bind() failed: Address already in use`，
 * **CDP 静默不可用**（实例照常注册，人以为能 attach）。217 号任务的教训：端口不能写死。
 *
 * 约定（两 app 一致）：
 *   1. 缺省用 `0` —— 让 Chromium 自己挑空闲端口；
 *   2. 实际端口由 Chromium 写进 `<userData>/DevToolsActivePort`（首行端口、次行 path），
 *      所以「怎么连」只能从文件读，不能靠入参推；
 *   3. 需要固定端口时用 `DIY_CDP_PORT` 显式覆盖（测试 / 需要稳定 attach 的场景）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `app.commandLine.appendSwitch` 需要的值：`0`（自动）或显式端口 */
export function cdpSwitchValue(env: NodeJS.ProcessEnv = process.env): string {
    const raw = env["DIY_CDP_PORT"];
    if (raw !== undefined && /^\d+$/.test(raw)) return raw;
    return "0";
}

/**
 * 读 Chromium 写的实际 CDP 地址。
 *
 * 文件格式（Chromium 定义）：第一行 = 端口，第二行 = 浏览器级 ws path。
 * 返回 `ws://127.0.0.1:<port><path>`；文件还没出现（启动早期）/ 没开 CDP ⇒ null。
 */
export function readDevToolsUrl(userDataDir: string): string | null {
    try {
        const [port, path] = readFileSync(join(userDataDir, "DevToolsActivePort"), "utf-8")
            .split("\n")
            .map((line) => line.trim());
        if (port === undefined || path === undefined || port === "" || path === "") return null;
        return `ws://127.0.0.1:${port}${path}`;
    } catch {
        return null;
    }
}

/** 只要端口号（不拼 ws 地址的场景：写进实例记录 / 打印一行「CDP :9223」） */
export function readDevToolsPort(userDataDir: string): number | null {
    const url = readDevToolsUrl(userDataDir);
    if (url === null) return null;
    const match = /^ws:\/\/127\.0\.0\.1:(\d+)/.exec(url);
    return match === null ? null : Number(match[1]);
}

/**
 * 等实际端口出现（Chromium 是异步写这个文件的）。
 *
 * 轮询而非 `fs.watch`：文件在**目录创建之前**就开始等（watch 不存在的 inode 在部分平台直接不触发），
 * 且这里最多等 3s、50ms 一次，代价可以忽略。
 */
export async function waitDevToolsPort(userDataDir: string, timeoutMs = 3000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const port = readDevToolsPort(userDataDir);
        if (port !== null) return port;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return readDevToolsPort(userDataDir);
}
