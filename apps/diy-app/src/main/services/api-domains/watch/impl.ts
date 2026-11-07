/**
 * api-domains/watch/impl.ts —— `watch` 域的 handler
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { watchService } from "./api";

export function bindWatch(server: ServerBinding): void {
    watchService.bind(server, {
        fileChange: async function* ({ signal }) {
            const { fileWatcher } = await import("../../file-watcher");
            for await (const change of fileWatcher.subscribe(signal)) {
                yield change;
            }
        },
    });
}
