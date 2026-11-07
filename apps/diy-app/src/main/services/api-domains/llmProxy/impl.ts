/**
 * api-domains/llmProxy/impl.ts —— `llmProxy` 域的 handler
 *
 * 用 `RawBindings`：**路径显式写死**，不依赖 `bindNames` 回写的 `meta.name`。
 * 这样 grep `diy.llmProxy.status` 能直接找到这里。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { RawBindings } from "@diy-agent/rpc";
import { app } from "../../api-def";
import { getLlmProxy } from "../../../core/llm-proxy-instance";

export function bindLlmProxy(binding: ServerBinding): void {
    const api = new RawBindings(binding);

    api.on("diy.llmProxy.status", app.llmProxy.status, async () => {
        const proxy = await getLlmProxy();
        return { running: proxy.isRunning, port: 8000 };
    });

    api.on("diy.llmProxy.start", app.llmProxy.start, async () => {
        const proxy = await getLlmProxy();
        proxy.start();
        return { status: "ok" };
    });

    api.on("diy.llmProxy.stop", app.llmProxy.stop, async () => {
        const proxy = await getLlmProxy();
        proxy.stop();
        return { status: "ok" };
    });
}
