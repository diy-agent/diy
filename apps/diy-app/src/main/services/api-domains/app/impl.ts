/**
 * api-domains/app/impl.ts —— `app` 域的 handler
 *
 * 合并自原 `getAppStatus` + `getAppInfo` 两个顶层 unary。
 */
import { arch, platform, release, totalmem, freemem } from "node:os";
import type { ServerBinding } from "@diy-agent/rpc";
import { readDevToolsUrl } from "@diy-agent/workbench";
import { AppConfig } from "../../../core/app-config";
import * as state from "../../../core/state";
import { currentGitBranch, homeDisplayOf, repoDisplayOf } from "../../../core/instance-identity";
import { appService } from "./api";

/** `rpcPort` 由 `setRpcPort()` 写入 —— 1 个模块级变量，故意不进 state */
let rpcPort = 0;
export function setRpcPort(port: number): void {
    rpcPort = port;
}

export function bindApp(server: ServerBinding): void {
    appService.bind(server, {
        info: async () => {
            const ac = new AppConfig(state.diyHome());
            const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(1);
            // CDP 连接地址：Electron 以 `--remote-debugging-port=0` 启动，实际端口写进
            // `userData/DevToolsActivePort`（首行端口、次行 path）—— renderer 读不到文件系统，
            // 只能由 main 侧读出来回给「复制调试信息」（口径与 CLI 的 printCdpHint 同源）。
            // CDP 连接地址：口径收在 `@diy-agent/workbench` 的 cdp.ts（与 dev 同一份实现）——
            // Electron 以 `--remote-debugging-port=0` 启动，实际端口由 Chromium 写进
            // `userData/DevToolsActivePort`；renderer 读不到文件系统，只能 main 侧读了回给 UI。
            const cdp = readDevToolsUrl(ac.electronUserData) ?? "";
            return {
                    pid: process.pid,
                    uptime: process.uptime(),
                    heapUsed: process.memoryUsage().heapUsed,
                    port: rpcPort,
                    diyHome: ac.diyHome,
                    diyHomeDisplay: homeDisplayOf(ac.diyHome),
                    repoDisplay: repoDisplayOf(),
                    env: process.env["DIY_ENV"] ?? "production",
                    branch: currentGitBranch() ?? "",
                    cache: ac.cache,
                    userData: ac.electronUserData,
                    cdp,
                    electron: process.versions.electron ?? "—（非 Electron）",
                    node: process.versions.node,
                    chrome: process.versions.chrome ?? "—（非 Electron）",
                    platform: `${platform()} ${arch()} (${release()})`,
                systemMemory: { totalGb: `${gb(totalmem())} GB`, freeGb: `${gb(freemem())} GB` },
            };
        },
    });
}
