// strategies/models/deepseek/pricing.ts —— DeepSeek 的峰谷计价（**模型族策略**）
//
// 依据（2026-11-28 对照官方价页确认；旧实现见 `apps/diy-app/src/main/data/models.dev.diy.json`）：
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
// 假日表：只用于「该日算不算工作日」，与调休补班无关（官方口径是 Monday through Friday，
// 补班的周六仍是 off-peak）。覆盖 2025–2026；2027 以后暂未发布，按工作日兜底（见下 COVERAGE）。

import type { ModelPricingStrategy, PricingMultiplier } from '../../types.js';

/** 峰段（UTC 分钟，闭开区间 `[start, end)`） */
const PEAK_MINUTES: readonly { readonly start: number; readonly end: number }[] = [
    { start: 1 * 60, end: 4 * 60 },
    { start: 6 * 60, end: 10 * 60 },
];

/**
 * 中国法定假日（只影响「工作日」判断）。
 *
 * 数据源：`apps/diy-app/src/main/data/calendars.json` 的 `CN-mon-fri-ex-holiday`
 * （chinese-days，生成于 2026-10-11）。官方价页只排假日、不补班，故这里**不含调休上班日**。
 */
const CN_HOLIDAYS: ReadonlySet<string> = new Set([
    // 2025
    '2025-01-01',
    '2025-01-28',
    '2025-01-29',
    '2025-01-30',
    '2025-01-31',
    '2025-02-01',
    '2025-02-02',
    '2025-02-03',
    '2025-02-04',
    '2025-04-04',
    '2025-04-05',
    '2025-04-06',
    '2025-05-01',
    '2025-05-02',
    '2025-05-03',
    '2025-05-04',
    '2025-05-05',
    '2025-05-31',
    '2025-06-01',
    '2025-06-02',
    '2025-10-01',
    '2025-10-02',
    '2025-10-03',
    '2025-10-04',
    '2025-10-05',
    '2025-10-06',
    '2025-10-07',
    '2025-10-08',
    // 2026
    '2026-01-01',
    '2026-01-02',
    '2026-01-03',
    '2026-02-15',
    '2026-02-16',
    '2026-02-17',
    '2026-02-18',
    '2026-02-19',
    '2026-02-20',
    '2026-02-21',
    '2026-02-22',
    '2026-02-23',
    '2026-04-04',
    '2026-04-05',
    '2026-04-06',
    '2026-05-01',
    '2026-05-02',
    '2026-05-03',
    '2026-05-04',
    '2026-05-05',
    '2026-06-19',
    '2026-06-20',
    '2026-06-21',
    '2026-09-25',
    '2026-09-26',
    '2026-09-27',
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
]);

/** 假日表覆盖到哪一年（超出 = 只按工作日判断，不会把假日误当峰段的风险没有兜底） */
const HOLIDAY_COVERAGE_LAST_YEAR = 2026;

function isPeak(at: Date): boolean {
    // 周末整日 off-peak
    const day = at.getUTCDay();
    if (day === 0 || day === 6) return false;
    // 中国法定假日整日 off-peak（只查覆盖范围内的年份）
    const date = at.toISOString().slice(0, 10);
    if (at.getUTCFullYear() <= HOLIDAY_COVERAGE_LAST_YEAR && CN_HOLIDAYS.has(date)) return false;
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
