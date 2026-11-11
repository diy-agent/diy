/**
 * api-domains/tool/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";

export const toolRoutes = RpcSchema.group({desc: `工具（文件读取：行窗口 + 续读）`,
        children: {
          read: RpcSchema.unary({
            desc: `
            读取文本文件（行窗口，可续读）

            与整文件截断的关键差别：超出上限时尾部给出 --offset 续读入口，
            可精确跳到没读过的部分，不会像「取头尾、丢中间」那样永久丢失中段。
            行/字节双限（缺省 2000 行 / 50KB，谁先到算谁）。
            不设单行字符数上限 —— 单行只受同一份字节预算约束（jsonl 这类「一行一条记录」
            的文件不会被砍半行）。
            `,
            input: {
              // resolvePath：相对路径按**敲命令的 shell 的 cwd** 解析成绝对路径（见 rpc cli/_parser.ts）。
              // 不能靠 handler 侧的 process.cwd() —— 那是 app 进程的应用目录，不是用户的目录。
              path: z.string().cliArg({ desc: "文件路径（相对路径按当前目录解析）", resolvePath: true }),
              offset: z.number().optional().cliOption({ desc: "起始行，1-based（缺省 1）" }),
              limit: z.number().optional().cliOption({ desc: "最大行数（缺省 2000）" }),
            },
            output: z.string(),
          }),
        },});

export const toolService = defineService({ name: "diy.tool", api: toolRoutes });

/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: toolApi, handlers: { tool: … } })`
 * 与上面的 `toolService` 完全等价（后者 = prefix "diy" + 模块层 "tool"）。
 */
export const toolApi = RpcSchema.group({ children: { tool: toolRoutes } });
