// src/shared/model-config.ts
// 🎯 LLM provider 配置的**唯一契约源**：纯 zod，无 node 依赖（renderer 也引用）。
//
// 两个文件、两层数据，**谁也不覆盖谁**（按 id 关联）：
//   · $DIY_HOME/model.yaml          配置层 —— provider 连接信息 + 模型选择规则（本文件上半）
//   · $DIY_HOME/providers.custom.yaml spec 层 —— models.dev 没有的 provider 的模型规格
//                                     （结构 = models.dev api.json 的 provider 条目，字段对齐）
//   · snapshot（src/main/data/models.dev.json）内置 spec —— models.dev npm 白名单产物，
//     与 api.json 完全同构，「models.dev 为唯一真源」。
//
// 配置层零 models.dev 字段：UI 词汇（accounts/filter/models 覆盖），与 spec 按 id 关联。
//
// 限定名（personas.yaml 的 `model` 字段形状，RFC 3986 `userinfo@host/path` 形）：
//   `0@opencode-go/mimo-v2.6-flash`        account 段缺省 = 序号
//   `work@opencode-go/deepseek-v4.1-flash` account 段有 name 时显示 name
//   `0@custom:goat/xiaomi/mimo-v2.6-flash` custom 恒带 `custom:` 前缀 → 永不与 models.dev 撞
// 切分规则：按**第一个** `/` 分 provider 段与 model 段（模型 id 自带 `/`），
//           provider 段按**最后一个** `@` 分 account 与 provider。

import { z } from "zod";

/** 账号名字符集：禁 `@` `/`（保证限定名唯一切点） */
const ACCOUNT_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * 账号（provider 连接凭证）。多账号一等公民（同 provider 开多个订阅）。
 * 本轮 type 只有 apiKey（schema 预留 type 判别键，见 AGENTS discriminated-union 约定）。
 */
export const AccountSchema = z.object({
    type: z.literal("apiKey"),
    /** 账号名；缺省 = 序号（"0"/"1"/…）→ 限定名 `0@provider/model` */
    name: z.string().regex(ACCOUNT_NAME_RE, "账号名只许 [A-Za-z0-9._-]（禁 @ 和 /）").optional(),
    data: z.object({
        /**
         * 明文或 `$VAR`/`${VAR}` 环境变量插值。**允许空**（= 还没填，UI 显示占位提示；
         * 运行时该账号不可用，不是错误）。未定义的 `$VAR` = fail-fast 报错（你制定了环境变量却不提供）。
         */
        value: z.string(),
    }),
});
export type Account = z.infer<typeof AccountSchema>;

/**
 * 模型启用规则（include/exclude 二态，不是逐模型 enabled）：
 *   include=[] + exclude=[] → 全开（默认：无任何配置时都启用）
 *   include 非空            → 白名单（新模型不自动进来）
 *   exclude 非空            → 黑名单（= 将来「自动包含新模型」选项的形态）
 *   两者都非空              → include ∩ ¬exclude（exclude 优先）
 */
export const FilterSchema = z.object({
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
});
export type Filter = z.infer<typeof FilterSchema>;

/**
 * models.dev `reasoning_options` → diy 的档位表（effort 词表）。
 *
 * **哨兵值 `DEFAULT_EFFORT`（"default" = 平台默认）**：代表「不发送任何推理参数」，
 * 交上游按自己的默认行为处理。传输层据此**省略** reasoning/providerOptions（见 local-agent.ts）。
 * 它**恒为每个模型的首选项** —— 允许用户不强制档位（declared 模型也可选平台默认）。
 *
 * 映射规则（fixture 与 diy 逐模型**实测**集为真源；models.dev 只作声明来源）：
 *   · 有 `{type:"effort",values:[…]}` → 用**上游声明的词表**（精确档位；default 优先 medium→high→首项）
 *   · `reasoning:false`              → 模型不支持推理 → 只有平台默认（不发送）
 *   · `reasoning:true` 但**未给出任何 reasoning_options**（空数组 / 缺字段）→ **通用兜底档位**
 *     （`GENERIC_REASONING_EFFORTS`，declared:false）。理由：models.dev 对此类模型（如 zen/go 的
 *     mimo-v2.6-flash，opts=[]）只标了「会推理」却没登记枚举，而 diy 实测该模型认
 *     none/low/medium/high —— 若一律坍缩成「平台默认」，存量 personas（effort=high/low）编辑即被拒。
 *     精确档位可在 model.yaml 的 `models[id].reasoning` 覆盖登记。
 *   · `reasoning:true` 且**明示了非 effort 选项**（toggle / budget_tokens）→ 只有平台默认
 *     （上游声明了推理，但不是 effort 语义，我们的传输只发 effort 字符串 → 不假装有档位）。
 *   · `reasoning` 字段缺失（custom provider 的 /models 不给推理信息）→ 只有平台默认（declared:false）
 * `toggle`（推理开关）/`budget_tokens`（思考预算）**不是 effort 语义** → 不映射成档位
 * （opencode 对 @ai-sdk/openai-compatible 的 toggle 也是返回空变体）。
 */
export const DEFAULT_EFFORT = "default";

/**
 * **通用兜底档位**：模型声明了 `reasoning:true`、但 spec 没给出 effort 词表时用。
 * 取 OpenAI 兼容 reasoning 模型最普遍接受的子集（diy 对 zen/go 的实测集恰为此四档）；
 * 上游若拒（400），说明该模型档位更窄 → 用 model.yaml 的模型覆盖登记精确集。default=medium。
 */
export const GENERIC_REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
export const GENERIC_REASONING_DEFAULT = "medium";

/** 解析结果：declared=false = spec 未登记 effort 词表（值为通用兜底集，或只有平台默认） */
export const ReasoningSupportSchema = z.object({
    supported: z.array(z.string()),
    default: z.string(),
    declared: z.boolean(),
});
export type ReasoningSupport = z.infer<typeof ReasoningSupportSchema>;

export function reasoningFromSpec(
    reasoning: boolean | undefined,
    options: Array<{ type?: string; values?: unknown }> | undefined,
): ReasoningSupport {
    const values = new Set<string>();
    for (const o of options ?? []) {
        if (o?.type === "effort" && Array.isArray(o.values)) {
            for (const v of o.values) if (typeof v === "string") values.add(v);
        }
    }
    if (values.size > 0) {
        const supported = [DEFAULT_EFFORT, ...values];
        const declaredValues = [...values];
        const def = declaredValues.includes("medium")
            ? "medium"
            : declaredValues.includes("high")
              ? "high"
              : declaredValues[0];
        return { supported, default: def, declared: true };
    }
    // 声明会推理、却没登记任何 reasoning_options（空/缺字段）→ 通用兜底档位。
    // 反例：明示了 toggle/budget（非 effort 语义）→ 不当成有档位，交平台默认。
    const declaredNonEffort = (options ?? []).length > 0;
    if (reasoning === true && !declaredNonEffort) {
        return { supported: [DEFAULT_EFFORT, ...GENERIC_REASONING_EFFORTS], default: GENERIC_REASONING_DEFAULT, declared: false };
    }
    // 其余（reasoning:false / 明示非 effort / 缺字段）→ 只有平台默认。
    return { supported: [DEFAULT_EFFORT], default: DEFAULT_EFFORT, declared: false };
}

/** 模型运行时的档位能力（与 shared/models.LocalModelReasoning 同形，供 runtime 直用） */
export function reasoningSupportOf(s: ReasoningSupport): { supported: string[]; default: string } {
    return { supported: s.supported, default: s.default };
}

/** 单价字段（spec 的 snake_case；单位 $/1M tokens）—— base 档与各阶档共用同一组键 */
export const COST_PRICE_FIELDS = ["input", "output", "cache_read", "cache_write"] as const;
export type CostPriceField = (typeof COST_PRICE_FIELDS)[number];

/** 单条覆盖里的档位（配置层 models[id].reasoning，白名单字段） */
export const ReasoningOverrideSchema = z.object({ supported: z.array(z.string()), default: z.string() });

/**
 * 逐模型覆盖（可整个缺省）。**白名单字段**，同构 models.dev 对应字段；
 * 不是整体 merge —— 只有列在这里的字段能改，其余永远跟 spec 走。
 */
/** `01:00:00+08:00`：ISO 8601 时刻 + **必填** UTC 偏移（无偏移 = 歧义 → 拒，不默认本地时区） */
export const TIME_OF_DAY_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 阶梯价条目的**触发条件**（写侧严格 schema；判别键 `type`，**分支私有数据进 `data`**）。
 *
 *   · `context`   —— `{type:"context", size: N}`（**models.dev 原生形状，原样保留**；
 *                    diy 写侧也可用自相似的 `{type:"context", data:{size}}`）
 *   · `utc-range` —— `{type:"utc-range", data:{start, end, calendar?, label?}}`
 *                    `start`/`end` = 带 UTC 偏移的 ISO 8601 时刻（如 `01:00:00+08:00`）；
 *                    `end < start` = **跨零点**；`offset` 必须两者一致（不一致 = 歧义 → 拒）。
 *                    `calendar` = `calendars.json` 里的日历 id（工作日定义，见 shared/calendars.ts）。
 *
 * 运行时的两段规则见 shared/usage.ts `ratesOf`：时段价「按序首个命中」，上下文阶梯「最大阈值」。
 */
export const TierWhenSchema = z.discriminatedUnion("type", [
    z
        .object({
            type: z.literal("context"),
            /** models.dev 原生位置（顶层） */
            size: z.number().int().positive().optional(),
            /** diy 自相似位置（`data`） */
            data: z.object({ size: z.number().int().positive() }).optional(),
        })
        .refine((v) => v.size !== undefined || v.data?.size !== undefined, {
            message: "context 档必须给 size（顶层或 data.size）",
        }),
    z.object({
        type: z.literal("utc-range"),
        data: z.object({
            start: z.string().regex(TIME_OF_DAY_RE, "须为带 UTC 偏移的 ISO 8601 时刻，如 01:00:00+08:00"),
            end: z.string().regex(TIME_OF_DAY_RE, "同上"),
            /** 日历 id（工作日定义）；缺省 = 时段内每天都算 */
            calendar: z.string().optional(),
            /** 该时段展示名（如 "peak"）；缺省 = cost.baseLabel */
            label: z.string().optional(),
        }),
    }),
]);
export type TierWhenSpec = z.infer<typeof TierWhenSchema>;

/**
 * models.dev 的**阶梯价条目**（snake_case，与 api.json 同构）：
 *   `tiers: [{ input, output, cache_read, cache_write, tier: { type: "context", size: 272000 } }]`
 * 不映射就会丢整档 —— 长上下文高价模型会按基础档静默少算（同 cache_read 那类坑）。
 */
export const CostTierSchema = z
    .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        tier: TierWhenSchema.optional(),
    })
    .passthrough();
export type CostTier = z.infer<typeof CostTierSchema>;

/** 价目块（spec / override / 视图三处复用同一形状） */
export const CostSchema = z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    /** 时段档「未命中任何窗」时的展示名（如 "off-peak"）；缺省 "base" */
    baseLabel: z.string().optional(),
    tiers: z.array(CostTierSchema).optional(),
});
export type Cost = z.infer<typeof CostSchema>;

export const ModelOverrideSchema = z.object({
    name: z.string().optional(),
    // API 面**不可覆盖**：与 models.dev 对齐，面由 npm 解析（provider.npm 默认 + model.provider.npm
    // 覆写，见 shared/models.ts faceOfNpm）。要改面就改 spec 的 npm，不在配置层另造字段。
    limit: z
        .object({
            context: z.number().int().positive().optional(),
            output: z.number().int().positive().optional(),
        })
        .optional(),
    /** 档位表（models.dev 未声明 effort 词表时，在此登记精确档位） */
    reasoning: ReasoningOverrideSchema.optional(),
    cost: CostSchema.optional(),
});
export type ModelOverride = z.infer<typeof ModelOverrideSchema>;

/** model.yaml 里一个 provider 段（std 与 custom 同构） */
export const ProviderConfigSchema = z.object({
    /** 必填：无 env 回退（env 情况就写成 `$VAR`） */
    accounts: z.array(AccountSchema).min(1, "至少一个账号（无 env 回退）"),
    filter: FilterSchema.optional(),
    /** 按模型 id 的覆盖登记；键 = spec 里的模型 id */
    models: z.record(z.string(), ModelOverrideSchema).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** $DIY_HOME/model.yaml 全文 */
export const ModelConfigFileSchema = z.object({
    /** key = models.dev 的 provider id（snapshot 白名单内） */
    stdProviders: z.record(z.string(), ProviderConfigSchema).default({}),
    /** key = 裸 provider id；限定名时恒拼 `custom:` 前缀 */
    customProviders: z.record(z.string(), ProviderConfigSchema).default({}),
});
export type ModelConfigFile = z.infer<typeof ModelConfigFileSchema>;

// ── spec 层（providers.custom.yaml）：结构 = models.dev api.json 条目 ──

/** models.dev 的 model 条目（宽松：字段对齐 + 允许上游加字段） */
export const SpecModelSchema = z
    .object({
        id: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        reasoning: z.boolean().optional(),
        tool_call: z.boolean().optional(),
        attachment: z.boolean().optional(),
        temperature: z.boolean().optional(),
        release_date: z.string().optional(),
        /** models.dev 的档位词表：`[{type:"effort",values:[...]}|{type:"toggle"}|{type:"budget_tokens",…}]` */
        reasoning_options: z.array(z.object({ type: z.string() }).passthrough()).optional(),
        /** models.dev 的**模型级 npm 覆写**（面在此精修；provider 级 npm 是粗默认） */
        provider: z.object({ npm: z.string().optional() }).passthrough().optional(),
        limit: z.object({ context: z.number(), output: z.number() }).partial().optional(),
        cost: CostSchema.optional(),
    })
    .passthrough();
export type SpecModel = z.infer<typeof SpecModelSchema>;

/** models.dev 的 provider 条目（扁平：npm = 字符串，api = baseUrl —— 与 api.json 同构） */
export const SpecProviderSchema = z.object({
    id: z.string(),
    name: z.string().optional(),
    /** ai-sdk 包名（= API 面定面者） */
    npm: z.string(),
    /** baseUrl */
    api: z.string(),
    env: z.array(z.string()).optional(),
    doc: z.string().optional(),
    models: z.record(z.string(), SpecModelSchema).default({}),
});
export type SpecProvider = z.infer<typeof SpecProviderSchema>;

/** $DIY_HOME/providers.custom.yaml 全文：裸 id → 条目 */
export const CustomSpecsFileSchema = z.record(z.string(), SpecProviderSchema).default({});
export type CustomSpecsFile = z.infer<typeof CustomSpecsFileSchema>;

// ── RPC 视图（llmConfig.read 下发形状；UI 渲染 + 就地编辑的基线） ──

/** 账号视图：原始字段 + 展开结果（$VAR 未定义不炸页，标红提示；运行时仍 fail-fast） */
export const AccountViewSchema = z.object({
    /** 序号（缺省名 = String(index)） */
    index: z.number().int(),
    /** 限定名 account 段：`0` 或 `work` */
    label: z.string(),
    account: AccountSchema,
    /** $VAR 展开后的值；失败 = null */
    expanded: z.string().nullable(),
    /** 展开失败原因（如「环境变量 $GOAT_KEY 未定义」）；成功 = null */
    error: z.string().nullable(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

/** 模型视图 = spec ⊕ override（白名单字段覆盖后的展示态） */
export const ModelViewSchema = z.object({
    id: z.string(),
    name: z.string(),
    context: z.number().nullable(),
    output: z.number().nullable(),
    /** 生效 API 面（由 npm 解析；见 shared/models.ts faceOfNpm） */
    api: z.enum(["chat", "responses"]),
    /** 生效 npm（provider.npm 或模型级 provider.npm 覆写） */
    npm: z.string(),
    /** 生效档位表（spec 的 reasoning_options ⊕ 配置覆盖；declared=false = 兜底通用集） */
    reasoning: ReasoningSupportSchema,
    cost: CostSchema.nullable(),
    /** filter（include/exclude）判定结果 —— UI 勾选框的状态 */
    enabled: z.boolean(),
    /** spec 里没有此模型（只有覆盖登记）→ UI 提示 id 打错或 snapshot 已变 */
    specMissing: z.boolean(),
});
export type ModelView = z.infer<typeof ModelViewSchema>;

/** provider 视图：spec（只读数据）+ config（可编辑）+ 解析态 */
export const ProviderViewSchema = z.object({
    /** map key（std = models.dev id；custom = 裸 id） */
    key: z.string(),
    kind: z.enum(["std", "custom"]),
    /** 限定名 provider 段（custom 恒带 `custom:` 前缀） */
    limited: z.string(),
    /** provider 级 spec；缺失（snapshot 改版/未写 custom spec）= null */
    spec: z
        .object({
            id: z.string(),
            name: z.string().nullable(),
            npm: z.string(),
            api: z.string(),
            env: z.array(z.string()),
        })
        .nullable(),
    /** 可编辑配置（缺省化：filter 恒存在、models 恒为 record） */
    config: z.object({
        accounts: z.array(AccountSchema),
        filter: FilterSchema,
        models: z.record(z.string(), ModelOverrideSchema),
    }),
    accounts: z.array(AccountViewSchema),
    models: z.array(ModelViewSchema),
    /** 至少一个账号成功展开 → 运行时可用（否则 UI 打「无可用密钥」徽章） */
    usable: z.boolean(),
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;

/** 可添加的 std provider 目录项（snapshot 投影，不含 models —— 6315 个不下发） */
export const CatalogEntrySchema = z.object({
    id: z.string(),
    name: z.string().nullable(),
    npm: z.string(),
    api: z.string(),
    /** env[0] —— UI 添加账号时的 $VAR 占位提示 */
    env: z.array(z.string()),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

/**
 * `/models` 返回的单条模型（OpenAI 形状 + 常见扩展）：
 *   `{ id, object, created, owned_by, name?, context_length?, supported_endpoints? }`
 * `object`/`created`/`owned_by` 我们不用；`name`/`context_length`/`supported_endpoints` 是
 * 事实上的通用扩展（vLLM 等也发；commandcode 全量提供）。**standard OpenAI /models 只保证
 * `id`** —— 那时 name=null、context=null、endpoints=[]，面则回退到 provider 级 npm。
 */
export const ProbeModelSchema = z.object({
    id: z.string(),
    name: z.string().nullable(),
    /** `context_length`（扩展；缺省 null）→ spec.limit.context */
    context: z.number().nullable(),
    /** `supported_endpoints`（扩展；缺省 []）→ 解析成模型级 npm（面） */
    endpoints: z.array(z.string()),
});
export type ProbeModel = z.infer<typeof ProbeModelSchema>;

/** `llmConfig.probe` 输出：拉 `${baseUrl}/models`（连通性 + 模型清单 + 可用元数据） */
export const ProbeResultSchema = z.object({
    ok: z.boolean(),
    /** HTTP 状态；网络层失败 = null */
    status: z.number().nullable(),
    /** 上游返回的模型；不支持 `/models` 时为空 */
    models: z.array(ProbeModelSchema),
    error: z.string().nullable(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

/**
 * `/models` 的 `supported_endpoints` → diy 的 npm 包名（`faceOfNpm` 的逆）。
 * 同 support 两个端点时优先 chat（更通用的 openai-compatible）；只支持 anthropic `/messages`
 * 等未支持面 → null（调用方跳过该模型）。
 */
export function npmOfEndpoints(endpoints: string[]): string | null {
    if (endpoints.includes("/chat/completions")) return "@ai-sdk/openai-compatible";
    if (endpoints.includes("/responses")) return "@ai-sdk/openai";
    return null;
}

/**
 * 日历选项（价格时段档的「工作日扩展」下拉用）：只是 id + 展示名。
 * 日历**定义**（holidays/workdays 表）在 main 侧（`src/main/data/calendars.json`），
 * renderer 不需要、也不该拿到整表 —— 它只把 id 写进档位。
 */
export const CalendarChoiceSchema = z.object({ id: z.string(), label: z.string() });
export type CalendarChoice = z.infer<typeof CalendarChoiceSchema>;

// ── 价目登记（CLI `llmConfig costs/setCost/setTiers`）的输入/输出契约 ──

/** 价目**落点**：spec（`providers.custom.yaml` / models.dev 内置 spec）vs override（`model.yaml` 覆盖） */
export const CostTargetSchema = z.enum(["spec", "override"]);
export type CostTarget = z.infer<typeof CostTargetSchema>;

/** 生效价目**来自哪**：`override` > `spec` > `none`（与 registryView 的取值同源） */
export const CostSourceSchema = z.enum(["override", "spec", "none"]);
export type CostSource = z.infer<typeof CostSourceSchema>;

/**
 * CLI 写入的档条目：**必须带 `tier` 触发条件** —— 没有触发条件的档会被运行时静默丢弃
 * （`toTierWhen` 返回 undefined），所以宁可在入口拒收，也不留一条"看起来写了其实没用"的档。
 */
export const TierWriteSchema = CostTierSchema.refine((t) => t.tier !== undefined, {
    message: "每条档必须给 tier 触发条件，如 tier:{type:'utc-range', data:{start,end,calendar,label}}",
});
export type TierWrite = z.infer<typeof TierWriteSchema>;

/** `--clear-fields` 可清的字段（比单价字段多一个展示名 `baseLabel`） */
export const CostClearFieldSchema = z.enum(["input", "output", "cache_read", "cache_write", "baseLabel"]);
export type CostClearField = z.infer<typeof CostClearFieldSchema>;

/** `llmConfig costs`：单个模型的价目态（agent 发现 model id / 现价 / 可写落点） */
export const ModelCostViewSchema = z.object({
    id: z.string(),
    name: z.string(),
    /** filter 判定（false = 不参与运行时目录，填价也白填） */
    enabled: z.boolean(),
    /** spec 里没此模型（只有覆盖登记）→ 提示 id 打错或 snapshot 已变 */
    specMissing: z.boolean(),
    /** 生效价目（override > spec）；null = 无价 → usage 金额为 null */
    cost: CostSchema.nullable(),
    costSource: CostSourceSchema,
    /** 可写落点（spec：仅 custom 且该模型在 spec 里；override：该 provider 已配在 model.yaml） */
    writable: z.array(CostTargetSchema),
});
export type ModelCostView = z.infer<typeof ModelCostViewSchema>;

/** `llmConfig costs` 输出 */
export const ProviderCostsViewSchema = z.object({
    /** 限定名（custom 恒带 `custom:` 前缀） */
    provider: z.string(),
    kind: z.enum(["std", "custom"]),
    /** `--target` 缺省（auto）会落的点：custom → spec、std → override */
    target: CostTargetSchema,
    /** provider 段是否已在 model.yaml（false → override 不可写：无账号无从落） */
    configured: z.boolean(),
    /** 时段档可引用的日历（id + 展示名；整表在 main 侧） */
    calendars: z.array(CalendarChoiceSchema),
    models: z.array(ModelCostViewSchema),
});
export type ProviderCostsView = z.infer<typeof ProviderCostsViewSchema>;

/** `llmConfig setCost/setTiers` 的回执（agent 据此核对「写了什么 / 生效什么 / 有什么坑」） */
export const CostUpdateResultSchema = z.object({
    provider: z.string(),
    kind: z.enum(["std", "custom"]),
    model: z.string(),
    target: CostTargetSchema,
    /** 落盘文件绝对路径（spec → providers.custom.yaml；override → model.yaml） */
    file: z.string(),
    /** 该**落点**的价目（null = 该落点无价） */
    cost: CostSchema.nullable(),
    /** 写后**生效**价目（override > spec）；与 `cost` 不同 = 有回退，别只看 `cost` */
    effective: CostSchema.nullable(),
    /** 时段档条数（编号口径同 `--drop`） */
    tierCount: z.number().int().nonnegative(),
    /** override 首次写入时以 spec 价为基线（避免"只填 output"丢掉 models.dev 的缓存价） */
    seededFromSpec: z.boolean(),
    warnings: z.array(z.string()),
});
export type CostUpdateResult = z.infer<typeof CostUpdateResultSchema>;

/** llmConfig.read 全量输出 */
export const LlmConfigViewSchema = z.object({
    /** 内置日历清单（时段档的日历下拉项；空 = calendars.json 缺失 → 时段档只能「不限日历」） */
    calendars: z.array(CalendarChoiceSchema),
    /** model.yaml 原样（编辑基线；保存时整份回写） */
    modelFile: ModelConfigFileSchema,
    /** providers.custom.yaml 全文 */
    customSpecs: CustomSpecsFileSchema,
    /** snapshot 全部 provider（供「添加」；UI 过滤掉已配置的） */
    catalog: z.array(CatalogEntrySchema),
    /** 已配置 provider 视图（std + custom） */
    providers: z.array(ProviderViewSchema),
    /**
     * 读配置时的降级原因（model.yaml / providers.custom.yaml 结构非法）。非 null 时上面各字段为
     * 空视图 —— UI 仍能打开并提示，而不是 RPC 抛错锁死页面（##275 R1-6）。
     */
    error: z.string().nullable().optional(),
});
export type LlmConfigView = z.infer<typeof LlmConfigViewSchema>;

// ── 限定名切分（personas.yaml `model` 字段的解析规则，纯函数） ──

/** 切分结果：model 段保留自带的 `/`（模型 id 可如 `xiaomi/mimo-v2.6-flash`） */
export interface QualifiedRef {
    /** account 段（`0` 或 `work`） */
    account: string;
    /** provider 段（`opencode-go` / `custom:goat`） */
    provider: string;
    /** 模型 id（原样，含内部 `/`） */
    model: string;
}

/**
 * `account@provider/model` → 三段。规则（见文件头）：
 * 第一个 `/` 切 provider|model；provider 段最后一个 `@` 切 account|provider。
 * 不合形状（缺 `/` 或缺 `@`）返回 null —— 调用方决定报错（存量裸名迁移需人工，不自动猜）。
 */
export function splitQualified(ref: string): QualifiedRef | null {
    const i = ref.indexOf("/");
    if (i < 0) return null;
    const providerSeg = ref.slice(0, i);
    const model = ref.slice(i + 1);
    const at = providerSeg.lastIndexOf("@");
    if (at < 0) return null;
    return { account: providerSeg.slice(0, at), provider: providerSeg.slice(at + 1), model };
}

/**
 * filter 判定（UI 勾选态与 registry 同源）：
 * 全开 / include∩¬exclude（exclude 优先）。返回该模型是否可见。
 */
export function filterAllows(f: Filter, id: string): boolean {
    if (f.include.length === 0 && f.exclude.length === 0) return true;
    if (f.include.length > 0) return f.include.includes(id) && !f.exclude.includes(id);
    return !f.exclude.includes(id);
}
