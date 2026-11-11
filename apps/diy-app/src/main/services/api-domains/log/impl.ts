/**
 * api-domains/log/impl.ts —— `log` 域的 handler（从 api-impl.ts 拆出）。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { logApi } from "./api";
import * as state from "../../../core/state";

export function bindLog(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: logApi,
        // 模块层由模块自己声明（log）：与 defineService(name: "diy.log") 等价
        handlers: {
            log: {
          read: async ({ input }) => {
            const { existsSync, readFileSync } = await import("node:fs");
            const { join } = await import("node:path");
            const logPath = join(state.diyHome(), "app.log");
            if (!existsSync(logPath)) return [];
            const raw = readFileSync(logPath, "utf-8");
            return raw
              .split("\n")
              .filter(Boolean)
              .reverse()
              .slice(0, input.limit ?? 200)
              .map((line: string) => {
                try {
                  return JSON.parse(line) as Record<string, unknown>;
                } catch {
                  return { raw: line };
                }
              });
          },
        } },
    });
}
