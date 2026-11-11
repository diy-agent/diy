/**
 * api-domains/llmProxy/impl.ts —— `llmProxy` 域的 handler
 *
 * 用 `llmProxyService.bind`：**路径由 service 自己拼**（`diy.llmProxy.*`），
 * 不依赖 `bindNames` 回写的 `meta.name`，也不需要额外工具。
 *
 * 为什么不是 `binding.on(meta, handler)`：那样得先 `bindNames(整棵树)`，
 * 路径是隐式的。`bind` 把「模块名 + 树内路径」拆开给，各司其职。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { getLlmProxy } from "../../../core/llm-proxy-instance";
import { llmProxyApi } from "./api";

export function bindLlmProxy(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: llmProxyApi,
        // 模块层由模块自己声明（llmProxy）：与 defineService(name: "diy.llmProxy") 等价
        handlers: {
            llmProxy: {
                status: async () => {
                    const proxy = await getLlmProxy();
                    return { running: proxy.isRunning, port: 8000 };
                },
                start: async () => {
                    const proxy = await getLlmProxy();
                    proxy.start();
                    return { status: "ok" };
                },
                stop: async () => {
                    const proxy = await getLlmProxy();
                    proxy.stop();
                    return { status: "ok" };
                },
            },
        },
    });
}
