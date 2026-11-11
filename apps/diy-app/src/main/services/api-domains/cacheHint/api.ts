/**
 * api-domains/cacheHint/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { StatusOk } from "../../../../shared/status";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import { CacheChannelViewSchema, CacheHintEventSchema, CacheHintSchema } from "../../../../shared/cache-hint";

export const cacheHintRoutes = RpcSchema.group({desc: `冷缓存提示（safePoint / failPoint 自适应边界；顶栏一行 + 用量面板缓存时效柱）`,
        children: {
          current: RpcSchema.unary({
            desc: `当前要显示的那一行「缓存可能已冷」提示（null = 不显示）`,
            input: {},
            output: CacheHintSchema.nullable(),
          }),
          stats: RpcSchema.unary({
            desc: `某模型（按当前 provider 解析）的缓存边界（safePoint / failPoint）+ 某会话距上次请求的时刻`,
            input: {
              model: z.string().cliArg({ desc: "模型完全限定名（account@provider/model）或唯一 id" }),
              session: z
                .string()
                .optional()
                .cliOption({ desc: "会话（任务 uri）；给了才返回「本会话距上次请求」，不给 = null" }),
            },
            output: CacheChannelViewSchema.nullable(),
          }),
          /**
           * **探针**：造一次（或 N 次）首步请求 + 可选结果，**仅非生产环境**。
           *
           * 为什么要有：这六条契约（保护值 / P90 / 只降不升 / safePoint 优先 / 安全区内忽略 /
           * 单行不叠加）真验证只能靠跑真模型几百次 —— 不可复现且要钱。探针走与真发**同一条**
           * noteRequest / noteFirstStepResult，只换事实来源（同 `diy env simulate` 的取舍）。
           *   `diy cacheHint simulate --model deepseek-v4.1-flash --gap-ms 300000 --hit success --repeat 100`
           */
          simulate: RpcSchema.unary({
            desc: `探针：造首步请求/结果（真实边界推进；仅非生产环境）`,
            input: {
              provider: z.string().default("probe").cliOption({ desc: "provider 段（缺省 probe，利于与真实渠道隔离）" }),
              model: z.string().cliOption({ desc: "模型 id（维度 = provider × model）" }),
              gapMs: z.number().cliOption({ desc: "距上次请求的间隔（ms）" }),
              hit: z.enum(["success", "miss", "none"]).default("none").cliOption({
                desc: "首步结果：success（命中 >0.9）/ miss（≈0）/ none（只发请求不回填）",
              }),
              repeat: z.number().default(1).cliOption({ desc: "重复次数（造 P90 的 100 个样本用）" }),
              taskUri: z.string().optional().cliOption({ desc: "提示上携带的任务 uri（缺省 probe）" }),
            },
            output: z.object({
              channel: z.string(),
              provider: z.string(),
              model: z.string(),
              safePointMs: z.number(),
              failPointMs: z.number().nullable(),
              lastRequestAt: z.number().nullable(),
              session: z.string().nullable(),
              samples: z.number(),
              hintsToday: z.number(),
              hint: CacheHintSchema.nullable(),
            }),
          }),
          dismiss: RpcSchema.unary({
            desc: `关闭提示（不给 id = 关掉当前那一条）`,
            input: { id: z.string().optional().cliArg({ desc: "提示 id（缺省 = 当前那一条）" }) },
            output: StatusOk,
          }),
          watch: RpcSchema.serverStream({
            desc: `提示流（订阅回放当前 + 增量：show 出现/更新那一行，clear 撤掉）`,
            input: {},
            output: CacheHintEventSchema,
          }),
        },});

export const cacheHintService = defineService({ name: "diy.cacheHint", api: cacheHintRoutes });

/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: cacheHintApi, handlers: { cacheHint: … } })`
 * 与上面的 `cacheHintService` 完全等价（后者 = prefix "diy" + 模块层 "cacheHint"）。
 */
export const cacheHintApi = RpcSchema.group({ children: { cacheHint: cacheHintRoutes } });
