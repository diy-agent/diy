/**
 * api-domains/remote/impl.ts —— `remote` 域的 handler
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { remoteApi } from "./api";
import { splitListOption } from "../../remote-discover-options";
import { remoteService as remoteBiz } from "../../remote";

export function bindRemote(server: ServerBinding): void {
    /** 把「字符串或数组」的两个发现源规整成同一形状 */
    const discoverInput = (input: {
        sources?: string | string[];
        manual?: string | string[];
        mdnsTimeoutMs?: number;
    }) => ({
        sources: splitListOption(input.sources),
        manual: splitListOption(input.manual),
        mdnsTimeoutMs: input.mdnsTimeoutMs,
    });

    server.use({
        prefix: "diy",
        api: remoteApi,
        // 模块层由模块自己声明（remote）：与 defineService(name: "diy.remote") 等价
        handlers: {
            remote: {
                self: async () => remoteBiz.self(),
                rename: async ({ input }) => remoteBiz.rename(input.name),
                ping: async ({ input }) => remoteBiz.ping(input.endpoint, input.timeoutMs),
                discover: async ({ input }) => (await remoteBiz.discover(discoverInput(input))).text,
                list: async ({ input }) => {
                    const r = await remoteBiz.discover(discoverInput(input));
                    return { rows: r.rows, errors: r.errors };
                },
            },
        },
    });
}
