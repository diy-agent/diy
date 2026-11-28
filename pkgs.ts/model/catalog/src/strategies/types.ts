// strategies/types.ts —— 模型策略接口（纯类型，零 IO）
//
// 与 provider 策略（`@diy-agent/llm-provider/strategies`）分家：
//   · provider 策略：按 **host** 认领的网关协议差异（header / 请求字段）；
//   · 模型策略：按 **模型身份** 认领的计价 / 行为差异（如 DeepSeek 峰谷翻倍）。
//
// 为什么计价要策略化：models.dev 收录的是**谷价**（唯一价格真源），峰时段翻倍是
// 上游模型族的规则；把峰价抄进 providers.custom.yaml 会制造第二份价目，改一处漏一处。

/** 计费倍率：1 = 按 models.dev 原价；2 = 峰价翻倍 */
export interface PricingMultiplier {
    readonly factor: number;
    /** 给人看的口径（`peak` / `off-peak`）；不知道就不填 */
    readonly label?: string;
}

/** 一条模型策略 */
export interface ModelPricingStrategy {
    /** 策略名（调试 / 测试用，不是 provider 名） */
    readonly name: string;
    /** 认领判据：只看模型身份（不按 provider 名分支） */
    matches(model: { readonly providerId?: string; readonly modelId: string }): boolean;
    /** 该时刻的倍率（缺省由调用方给 `new Date()`） */
    multiplierAt(at: Date): PricingMultiplier;
}
