/**
 * api-domains/context/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import { ContextDiffSchema, ContextLabSchema, ContextPlaceCandidateSchema, CtxLogSchema, StatsSchema, StepsSchema } from "../../../../shared/context/schema";

export const contextRoutes = RpcSchema.group({desc: `上下文树（当前任务的真实系统上下文；只组装不发送）`,
        children: {
          config: RpcSchema.unary({
            desc: `读划分规则（$DIY_HOME/context.yaml；真发与页面共用这一份）`,
            input: {},
            output: z.object({
              systemPlaces: z.array(z.string()).describe("当前生效的 system 单元（其余自动 runtime）"),
              defaults: z.array(z.string()).describe("推荐名单（文件缺失/清空时用它）"),
              fromFile: z.boolean().describe("是否来自 context.yaml（false = 用推荐名单）"),
              inputLimitChars: z.number().describe("用户单条消息的字符上限（##426 B）"),
            }),
          }),
          setConfig: RpcSchema.unary({
            desc: `写划分规则（非法路径或互为祖先/后代一律拒绝；下一轮真发生效）`,
            input: {
              systemPlaces: z.array(z.string()).cliOption({ desc: "进 system 的单元（JSON 数组）" }),
              inputLimitChars: z.number().optional().cliOption({ desc: "用户单条消息的字符上限（##426 B）" }),
            },
            output: z.object({
              systemPlaces: z.array(z.string()),
              inputLimitChars: z.number().nullable().describe("当前输入上限（本次没改 = 原值）"),
            }),
          }),
          candidates: RpcSchema.unary({
            desc: `列出候选投递单元与默认 system 名单`,
            input: {},
            output: z.object({
              candidates: ContextPlaceCandidateSchema,
              defaultSystem: z.array(z.string()),
            }),
          }),
          lab: RpcSchema.unary({
            desc: `上下文树数据：变量树 + 划分规则 + system/runtime 两份 + 合成消息`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              taskUri: z.string().optional().cliOption({ desc: "任务 URI（缺省则只有项目级上下文）" }),
              systemPlaces: z
                .array(z.string())
                .optional()
                .cliOption({ desc: "划入 system 的投递单元（JSON 数组；缺省用推荐名单，其余自动 runtime）" }),
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
              systemPlaces: z
                .array(z.string())
                .optional()
                .cliOption({ desc: "当前投递的 system 名单（缺省用推荐名单）" }),
            },
            output: ContextDiffSchema.nullable(),
          }),
        },});

export const contextService = defineService({ name: "diy.context", api: contextRoutes });
