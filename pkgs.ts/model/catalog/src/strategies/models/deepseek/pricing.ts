// strategies/models/deepseek/pricing.ts —— DeepSeek 的峰谷计价（**模型族策略**）
//
// 依据（2026-11-28 对照官方价页确认）：
//   「Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
//     06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays.
//     All other hours are off-peak, including weekends and Chinese public holidays in full.」
//
// 也就是说：
//   · models.dev 收录的是 **off-peak（谷价）**，这是唯一的价格来源；
//   · 峰时段 = 谷价 × 2（不是另一套价目，别把峰价抄进配置文件）；
//   · 峰段判定按 **UTC**：01:00–04:00 与 06:00–10:00，周一至周五，且不是中国法定假日。
//
// 为什么是模型策略而不是 provider 策略：同一模型在多家售卖（deepseek 直连 / 网关）价目
// 可以不同，但「峰谷翻倍」是 DeepSeek 这家模型族的计费规则，按模型身份认领。
//
// 假日表：`holidays.generated.ts`（由 `scripts/gen-holidays.mts` 从 chinese-days 生成）。
// 只吃「法定假日」，不吃调休补班 —— 官方口径是 Monday through Friday，补班的周六仍是 off-peak。

import { CN_HOLIDAYS, HOLIDAYS_COVERAGE } from './holidays.generated.js';
import type { ModelPricingStrategy, PricingMultiplier } from '../../types.js';

/** 峰段（UTC 分钟，闭开区间 `[start, end)`） */
const PEAK_MINUTES: readonly { readonly start: number; readonly end: number }[] = [
    { start: 1 * 60, end: 4 * 60 },
    { start: 6 * 60, end: 10 * 60 },
];

/** 假日表覆盖区间（超出只按工作日判断，不猜假日） */
const COVERAGE_START = HOLIDAYS_COVERAGE.from;
const COVERAGE_END = HOLIDAYS_COVERAGE.to;

function isPeak(at: Date): boolean {
    // 周末整日 off-peak
    const day = at.getUTCDay();
    if (day === 0 || day === 6) return false;
    // 中国法定假日整日 off-peak（只查覆盖范围内的日期；ISO 日期字符串可直接比较）
    const date = at.toISOString().slice(0, 10);
    if (date >= COVERAGE_START && date <= COVERAGE_END && CN_HOLIDAYS.has(date)) return false;
    // 峰段（UTC）
    const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
    return PEAK_MINUTES.some((window) => minutes >= window.start && minutes < window.end);
}

/** DeepSeek 模型族：按 model id 认（`deepseek-v4-flash` / `deepseek/deepseek-v4-pro` 都算） */
export const deepseekPricing: ModelPricingStrategy = {
    name: 'deepseek-peak',
    matches: ({ modelId }) => modelId.toLowerCase().includes('deepseek'),
    multiplierAt: (at): PricingMultiplier =>
        isPeak(at) ? { factor: 2, label: 'peak' } : { factor: 1, label: 'off-peak' },
};
