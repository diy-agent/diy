/**
 * api-domains/env/impl.ts —— `env` 域的 handler（从 api-impl.ts 拆出）。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { envApi } from "./api";
import { renderEnvList } from "../../env-list";
import { ensureDiskPoller, envWatchHub, realStatfs, simulateEnvFact } from "../../env-watch";
import { envNoticeFromDisk } from "../../../../shared/env-watch";
import { readRuntimeConfig } from "../../../../runtime";

export function bindEnv(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: envApi,
        // 模块层由模块自己声明（env）：与 defineService(name: "diy.env") 等价
        handlers: {
            env: {
                // 首次访问顺手起轮询器（懒加载：Electron / serve / 测试三条入口都走 api-impl，不漏一处）。
                list: async () => {
                    ensureDiskPoller();
                    return envWatchHub.list();
                },
                ls: async () => {
                    ensureDiskPoller();
                    return renderEnvList(envWatchHub.list());
                },
                dismiss: async ({ input }) => {
                    envWatchHub.dismiss(input.id);
                    return { status: "ok" };
                },
                watch: async function* ({ signal }) {
                    ensureDiskPoller();
                    for await (const ev of envWatchHub.subscribe(signal)) yield ev;
                },
                simulate: async ({ input }) => {
                    if (readRuntimeConfig().env === "production") {
                        throw new Error("env simulate 是探针命令，生产环境一律拒绝（DIY_ENV=production）");
                    }
                    if (input.diskAvail !== undefined) {
                        const notice = await simulateEnvFact({
                            kind: "disk",
                            availBytes: input.diskAvail,
                            totalBytes: input.diskTotal ?? 500 * 1024 ** 3,
                            mount: input.diskMount,
                        });
                        return { notice };
                    }
                    if (input.netCode !== undefined) {
                        const notice = await simulateEnvFact({
                            kind: "network",
                            code: input.netCode,
                            streak: input.netStreak,
                            message: input.netMessage,
                        });
                        return { notice };
                    }
                    throw new Error("至少给一个事实：--disk-avail <bytes> 或 --net-code <code>");
                },
                probe: async ({ input }) => {
                    const target = input.path ?? process.env["DIY_ENV_WATCH_TARGET"] ?? "/";
                    const sample = await realStatfs(target);
                    const notice = envNoticeFromDisk(sample, "poll");
                    if (notice) envWatchHub.push(notice);
                    else envWatchHub.resolveDisk(sample);
                    return { sample, notice };
                },
            },
        },
    });
}
