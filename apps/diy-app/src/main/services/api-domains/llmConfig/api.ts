/**
 * api-domains/llmConfig/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
/** 与 api-def.ts 的同名局部常量同形（那边没导出） */
const StatusOk = z.object({ status: z.string() });
import { CostUpdateResultSchema, ImportEnvResultSchema, LlmConfigViewSchema, ModelConfigFileSchema, ModelsRefreshResultSchema, ProbeResultSchema, ProviderCostsViewSchema, ScanEnvResultSchema, SpecProviderSchema, TierWriteSchema } from "../../../../shared/model-config";

export const llmConfigRoutes = RpcSchema.group({desc: `模型 provider 配置（$DIY_HOME/model.yaml + providers.custom.yaml）`,
        children: {
          read: RpcSchema.unary({
            desc: `读全量视图（spec + 配置 + 可见模型）`,
            input: {},
            output: LlmConfigViewSchema,
          }),
          write: RpcSchema.unary({
            desc: `整份回写 model.yaml（原子写；结构非法抛错）`,
            input: { modelFile: ModelConfigFileSchema },
            output: StatusOk,
          }),
          writeSpec: RpcSchema.unary({
            desc: `写/删 providers.custom.yaml 单条（spec=null 删除）`,
            input: { id: z.string().cliArg({ desc: "custom provider 裸 id" }), spec: SpecProviderSchema.nullable() },
            output: StatusOk,
          }),
          costs: RpcSchema.unary({
            desc: `列出 provider 的模型与生效价目（登记前先跑：拿 model id / 现价 / 可写落点）`,
            input: {
              provider: z.string().cliArg({ desc: "provider（裸 id 或 custom:<id>，如 custom:goat）" }),
            },
            output: ProviderCostsViewSchema,
          }),
          setCost: RpcSchema.unary({
            desc: `登记/更新模型单价（$ / 1M tokens；合并语义，只改给出的字段）`,
            input: {
              provider: z.string().cliArg({ desc: "provider（裸 id 或 custom:<id>）" }),
              model: z.string().cliArg({ desc: "模型 id（见 llmConfig costs）" }),
              target: z.enum(["auto", "spec", "override"]).default("auto").cliOption({ desc: "落点：spec=providers.custom.yaml · override=model.yaml" }),
              input: z.number().nonnegative().optional().cliOption({ desc: "非缓存 $/1M" }),
              output: z.number().nonnegative().optional().cliOption({ desc: "输出 $/1M" }),
              cacheRead: z.number().nonnegative().optional().cliOption({ desc: "缓存读 $/1M" }),
              cacheWrite: z.number().nonnegative().optional().cliOption({ desc: "缓存写 $/1M" }),
              baseLabel: z.string().optional().cliOption({ desc: "未命中时段档时的档名（如 off-peak）" }),
              clear: z.boolean().optional().cliOption({ desc: "删除整个 cost 块（含时段档）" }),
              clearFields: z.array(z.enum(["input", "output", "cache_read", "cache_write", "baseLabel"])).optional().cliOption({ desc: `清指定字段（JSON 数组，如 '["cache_write"]'）` }),
            },
            output: CostUpdateResultSchema,
          }),
          setTiers: RpcSchema.unary({
            desc: `登记/更新时段档（utc-range 峰谷价；--tiers / --drop / --clear 三选一）`,
            input: {
              provider: z.string().cliArg({ desc: "provider（裸 id 或 custom:<id>）" }),
              model: z.string().cliArg({ desc: "模型 id（见 llmConfig costs）" }),
              target: z.enum(["auto", "spec", "override"]).default("auto").cliOption({ desc: "落点：auto=custom→spec、std→override" }),
              tiers: z.array(TierWriteSchema).optional().cliOption({ desc: `时段档 JSON 数组，如 '[{"input":0.5,"output":3,"tier":{"type":"utc-range","data":{"start":"01:00:00+08:00","end":"04:00:00+08:00","calendar":"CN-business-day","label":"peak"}}}]'` }),
              append: z.boolean().optional().cliOption({ desc: "与 --tiers 合用：追加，不改既有档" }),
              drop: z.number().int().nonnegative().optional().cliOption({ desc: "删第 n 条时段档（0-based，只数 utc-range）" }),
              clear: z.boolean().optional().cliOption({ desc: "删光全部时段档（context 上下文档不动）" }),
            },
            output: CostUpdateResultSchema,
          }),
          scanEnv: RpcSchema.unary({
            desc: `扫环境变量得到可导入的 provider 候选（models.dev 声明的 env ∩ process.env，再与现有配置比对）`,
            input: {},
            output: ScanEnvResultSchema,
          }),
          importEnv: RpcSchema.unary({
            desc: `导入环境变量命中的 provider（写 $VAR 引用；已配置/密钥重复的跳过）`,
            input: {
              providers: z
                .array(z.string())
                .optional()
                .cliOption({ desc: "只导入这些 provider id（缺省 = 全部可导入项）" }),
            },
            output: ImportEnvResultSchema,
          }),
          /**
           * 模型目录刷新（##385）：抓 models.dev 上游 → 校验 → 有 diff 才写 `$DIY_HOME/data/models.dev.json`。
           * 手工按钮（模型页 / 模型不可用 bar）与定时任务共用同一实现（core/models-sync.ts）。
           * **失败不抛**：`ok=false` + `error`，本地快照逐字不变（fail-soft，§3.4）。
           */
          syncModels: RpcSchema.unary({
            desc: `刷新模型目录（抓 models.dev → 结构校验 → 有 diff 才写 $DIY_HOME；失败保留旧文件）`,
            input: {},
            output: ModelsRefreshResultSchema,
          }),
          probe: RpcSchema.unary({
            desc: `探测 provider 连通性并拉 ${"${baseUrl}"}/models（UI「测试/获取模型」共用）`,
            input: {
              baseUrl: z.string().cliArg({ desc: "provider baseUrl" }),
              apiKey: z.string().cliArg({ desc: "密钥原始值（明文或 $VAR，服务端展开）" }),
            },
            output: ProbeResultSchema,
          }),
        },});

export const llmConfigService = defineService({ name: "diy.llmConfig", api: llmConfigRoutes });
