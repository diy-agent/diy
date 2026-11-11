/**
 * api-domains/docs/impl.ts —— `docs` 域的 handler
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { findRepoRoot } from "../../../core/instance-identity";
import { buildDocsIndex, DEFAULT_DOCS_ROOTS } from "../../docs-index";
import { docsApi } from "./api";

export function bindDocs(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: docsApi,
        // 模块层由模块自己声明（docs）：与 defineService(name: "diy.docs") 等价
        handlers: {
            docs: {
            index: async ({ input }) => {
                const roots = input.roots === undefined
                    ? undefined
                    : input.roots.split(",").map((s) => s.trim()).filter((s) => s !== "");
                // 缺省根 = **app 进程 cwd 向上找到的仓库根**（不是 process.cwd() 本身）：
                // app 进程的 cwd 是包目录（`apps/diy-app`），直接拿它扫 `docs/plans` 永远是空。
                // 这也解释了为什么必须显式传 `--dir` 或依赖上溯 —— CLI 敲命令的 cwd 到不了这里。
                const idx = buildDocsIndex({
                    root: input.dir ?? findRepoRoot(process.cwd()) ?? process.cwd(),
                    ...(roots === undefined ? {} : { roots }),
                    ...(input.max === undefined ? {} : { maxEntries: input.max }),
                });
                // 没有文档 = 空索引（不是 null）：CLI 的返回形状要稳定，空 = "这个根下没扫到"，
                // 与"变量树里整节缺席"是两件事（后者是上下文层的纪律）。
                return idx ?? { roots: roots ?? [...DEFAULT_DOCS_ROOTS], entries: [] };
            },
        } },
    });
}
