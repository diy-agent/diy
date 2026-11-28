#!/usr/bin/env node
// gen-holidays.mts —— 从 `chinese-days` 生成**中国法定假日表**（产物 holidays.generated.ts）。
//
// 为什么生成而不是装依赖：假日表是**纯数据**，运行时不需要第三方包（供应链 / 打包体积 /
// 跨端一致）。生成一次随仓库走，排班更新后重跑本脚本即可。
//
// 数据源：chinese-days（MIT）的 `dist/chinese-days.json`：
//   { holidays: {"2026-01-01":"New Year's Day,元旦,1"}, workdays: {…}, inLieuDays: {…} }
// 我们只取 `holidays` 的日期（这里只需要「是不是法定假日」；名称不参与计算）。
//
// ⚠️ 只取法定假日，**不取调休补班（workdays）**：DeepSeek 官方峰段口径是
//    「Monday through Friday, excluding Chinese public holidays」—— 补班的周六
//    仍是 off-peak（旧实现见 `apps/diy-app/src/main/data/models.dev.diy.json`）。
//
// 用法：
//   npx tsx scripts/gen-holidays.mts [源]     # 源 = 本地文件路径 或 URL
//   缺省源 = CDN 上的 chinese-days 全量 JSON
//
// ⚠️ fail-soft：抓取/解析失败 → **不写文件**（保留已提交的产物）+ 非零退出码。
//    写出半截假日表 = 峰谷价静默算错，比报错严重。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] ?? 'https://unpkg.com/chinese-days/dist/chinese-days.json';
const SOURCE_NAME = 'chinese-days';
const DEST = join(PKG, 'src/strategies/models/deepseek/holidays.generated.ts');

function isDateKey(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function main(): Promise<void> {
    const raw = SRC.startsWith('http') ? await (await fetch(SRC)).text() : await readFile(SRC, 'utf-8');
    const parsed = JSON.parse(raw) as { holidays?: Record<string, unknown> };
    const dates = Object.keys(parsed.holidays ?? {})
        .filter(isDateKey)
        .sort();
    if (dates.length === 0) throw new Error('源里没有 holidays 数据（形状变了？）');

    const body = [
        '// holidays.generated.ts —— **自动生成，勿手改**。',
        '//',
        '// 生成：`npx tsx scripts/gen-holidays.mts [源]`',
        `// 数据源：${SOURCE_NAME}（MIT）的 \`dist/chinese-days.json\``,
        '// 只含中国**法定假日**；调休补班日不在内（DeepSeek 峰段口径：Mon–Fri 排除法定假日）。',
        '',
        `export const HOLIDAYS_SOURCE = '${SOURCE_NAME}' as const;`,
        `export const HOLIDAYS_GENERATED_AT = '${new Date().toISOString()}' as const;`,
        '/** 覆盖区间；超出范围的日期只按工作日判断（不猜假日） */',
        `export const HOLIDAYS_COVERAGE = { from: '${dates[0]!}', to: '${dates[dates.length - 1]!}' } as const;`,
        '/** 中国法定假日（YYYY-MM-DD） */',
        'export const CN_HOLIDAYS: ReadonlySet<string> = new Set([',
        ...dates.map((date) => `    '${date}',`),
        ']);',
        '',
    ].join('\n');

    await writeFile(DEST, body, 'utf-8');
    console.log(
        `holidays: ${SOURCE_NAME} · ${dates.length} 天 · coverage=${dates[0]}→${dates[dates.length - 1]} → ${DEST}`,
    );
}

main().catch((error: unknown) => {
    console.error(
        `gen-holidays 失败（**未写文件**，保留现有产物）: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});
