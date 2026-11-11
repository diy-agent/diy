/**
 * api-domains/docs/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import { DocsIndexSchema } from "../../../../shared/docs";

export const docsRoutes = RpcSchema.group({desc: `仓库文档索引（##404）：\`docs/\` 不在任何 AGENTS.md 链上，agent 不知道有哪些设计稿。上下文变量树里只有**摘要**（根 / 篇数 / 最新改动日），逐篇索引**按需**在这里取`,
        children: {
          index: RpcSchema.unary({
            desc: `列出文档索引（一行一篇：路径 / 标题 / 字节 / 状态词 / 两个日期）。缺省只扫 \`docs/plans\`。\n\n**两个日期都给**：docDate 是文档**自述**（文件名 / 标题），touched 是 git 最后改动日 —— 实测一批计划的 git 日期全被一次全局重排刷成同一天，与自述不符。**不一致本身就是信号**（"文档说 7-10，实际 7-19 改过"），只信 git 会得出假结论。\n\nstatus 是**启发式**：只认开篇引用块里「状态 / 结论 / 实现状态：…」那句，抽不到就不给 —— 编出来的状态比没有更坏。读正文用 \`diy tool read <path>\``,
            input: {
              dir: z.string().optional().cliOption({ desc: "仓库根（缺省 = 当前目录；相对路径按当前目录解析）", resolvePath: true }),
              roots: z.string().optional().cliOption({ desc: "扫描根（仓库相对，逗号分隔；缺省 docs/plans，可给 docs 扩到全量）" }),
              max: z.number().optional().cliOption({ desc: "最多返回几篇（缺省 60，按路径序截断）" }),
            },
            output: DocsIndexSchema,
          }),
        },});

export const docsService = defineService({ name: "diy.docs", api: docsRoutes });

/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: docsApi, handlers: { docs: … } })`
 * 与上面的 `docsService` 完全等价（后者 = prefix "diy" + 模块层 "docs"）。
 */
export const docsApi = RpcSchema.group({ children: { docs: docsRoutes } });
