/**
 * api-domains/tool/impl.ts —— `tool` 域的 handler（从 api-impl.ts 拆出）。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { resolve as resolvePath } from "node:path";
import { toolService } from "./api";
import { formatReadOutput, readFileWindow, ReadWindowError } from "../../../core/file-read";

export function bindTool(server: ServerBinding): void {
    toolService.bind(server, {
      read: async ({ input }) => {
        const raw = (input.path ?? "").trim();
        if (!raw) throw new Error("path 不能为空");
        if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 1)) {
          throw new Error(`offset 必须是 >= 1 的整数（收到 ${input.offset}）`);
        }
        if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
          throw new Error(`limit 必须是 >= 1 的整数（收到 ${input.limit}）`);
        }
        const abs = resolvePath(raw);
        try {
          const window = await readFileWindow(abs, abs, { offset: input.offset, limit: input.limit });
          return formatReadOutput(window);
        } catch (e) {
          if (e instanceof ReadWindowError) throw new Error(e.message);
          const code = (e as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") throw new Error(`文件不存在：${abs}`);
          if (code === "EISDIR") throw new Error(`${abs} 是目录（本命令只读文本文件；列目录请用 ls）`);
          throw e;
        }
      },
    });
}
