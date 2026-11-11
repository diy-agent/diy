/**
 * api-domains/watch/impl.ts —— `watch` 域的 handler
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { watchApi } from "./api";

export function bindWatch(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: watchApi,
        // 模块层由模块自己声明（watch）：与 defineService(name: "diy.watch") 等价
        handlers: {
            watch: {
            fileChange: async function* ({ signal }) {
                const { fileWatcher } = await import("../../file-watcher");
                for await (const change of fileWatcher.subscribe(signal)) {
                    yield change;
                }
            },
        } },
    });
}
