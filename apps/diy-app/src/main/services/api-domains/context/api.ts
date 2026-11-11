/**
 * api-domains/context/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema } from "@diy-agent/rpc";
import {
    ContextDiffSchema,
    ContextLabSchema,
    ContextPlaceCandidateSchema,
    CtxLogSchema,
    StatsSchema,
    StepsSchema,
} from "../../../../shared/context/schema";

export const contextRoutes = RpcSchema.group({
    desc: `上下文树（当前任务的真实系统上下文；只组装不发送）`,
    children: {
        candidates: RpcSchema.unary({
            desc: `列出候选投递单元`,
            input: {},
            output: z.object({
                candidates: ContextPlaceCandidateSchema,
            }),
        }),
        lab: RpcSchema.unary({
            desc: `上下文树数据：变量树 + 信封全文（help + vars）+ 合成消息`,
            input: {
                project: z.string().cliArg({ desc: "project id" }),
                taskUri: z.string().optional().cliOption({ desc: "任务 URI（缺省则只有项目级上下文）" }),
                model: z.string().optional().cliOption({ desc: "模型 id（请求体预览用；缺省取默认模型）" }),
            },
            output: ContextLabSchema,
        }),
        steps: RpcSchema.unary({
            desc: `每轮真发的投递快照（step）：值变化 + 两份容器的 diff（默认只给统计，--diff 给行内容）`,
            input: {
                taskUri: z.string().cliArg({ desc: "任务 URI" }),
                limit: z.number().optional().cliOption({ desc: "只看最近 N 步（缺省全部）" }),
                diff: z
                    .boolean()
                    .optional()
                    .cliOption({ desc: "带上行级 diff 内容（默认只有增删统计，避免下发整份文本）" }),
            },
            output: StepsSchema,
        }),
        stats: RpcSchema.unary({
            desc: `节点变更统计（按项目累计；回答"用了几天，某节点变了几次"）`,
            input: {
                project: z.string().cliArg({ desc: "project id" }),
                taskUri: z.string().optional().cliOption({ desc: "只算某个任务（缺省：整个项目累计）" }),
                limit: z.number().optional().cliOption({ desc: "只看最近 N 轮（缺省全部）" }),
            },
            output: StatsSchema,
        }),
        changelog: RpcSchema.unary({
            desc: `变更历史：每步**有变才写**（每段会话起点给一条 baseline 整棵树）；变更单位 = 原子单元，before/after 自带；附 ref（当轮划分 / 缓存率 / 金额）`,
            input: {
                taskUri: z.string().cliArg({ desc: "任务 URI" }),
                limit: z.number().optional().cliOption({ desc: "只看最近 N 轮（缺省全部）" }),
            },
            output: CtxLogSchema,
        }),
        rebaseline: RpcSchema.unary({
            desc: `重置变更历史的起点：该任务**下一步真发**时写一条新 baseline（整棵树）。临时手工入口 —— 会话注册表/关停启动机制落地后改由「会话启动」自动触发，本命令留作调试`,
            input: {
                taskUri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: z.object({
                ok: z.boolean().describe("是否已置位（true = 下一步真发落新起点）"),
                message: z.string().describe("给用户看的一句话（本轮下次真发生效；当轮已开跑则下一轮）"),
            }),
        }),
        diff: RpcSchema.unary({
            desc: `某步 vs 上一步的 diff；不给 --step 则是「当前变量树 vs 最后一步」（main 侧算完）`,
            input: {
                project: z.string().cliArg({ desc: "project id" }),
                taskUri: z.string().cliArg({ desc: "任务 URI" }),
                step: z.number().optional().cliOption({ desc: "第几步（1 基）；缺省 = 当前 vs 最后一步" }),
            },
            output: ContextDiffSchema.nullable(),
        }),
    },
});


/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: contextApi, handlers: { context: … } })`
 * 与上面的 `contextService` 完全等价（后者 = prefix "diy" + 模块层 "context"）。
 */
export const contextApi = RpcSchema.group({ children: { context: contextRoutes } });
