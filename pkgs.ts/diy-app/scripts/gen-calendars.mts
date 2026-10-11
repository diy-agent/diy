#!/usr/bin/env node
// 从 chinese-days 数据生成**内置日历表**（产物 src/main/data/calendars.json）。
//
// 为什么要生成而不是装依赖：diy 运行时不引第三方包（renderer 打包体积 / 供应链），
// 而日历只是**纯数据** —— 生成一次、随仓库走，更新走定时工作流（见 ##107）。
//
// 数据源（chinese-days 的 `dist/chinese-days.json`，MIT）形状：
//   { holidays: {"2026-01-01":"New Year's Day,元旦,1"}, workdays: {…}, inLieuDays: {…} }
// 我们只取「日期 → 中文名」，并把 `base` 周规则（周一至周五）显式写进产物 ——
// 判定优先级 `workdays > holidays > base.days`（见 shared/calendars.ts）。
//
// 用法：
//   npx tsx scripts/gen-calendars.mts [源]      # 源 = 本地文件路径 或 URL
//   缺省源 = CDN 上的 chinese-days 全量 JSON
//
// ⚠️ **fail-soft**：抓取/解析失败 → **不写文件**（保留已 commit 的产物）+ 非零退出码，
//    绝不写出半成品（半成品 = 静默丢掉调休表 = 计价用错档）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.argv[2] ?? "https://cdn.jsdelivr.net/npm/chinese-days/dist/chinese-days.json";
const PINNED = "chinese-days";

/** `"New Year's Day,元旦,1"` → `"元旦"`（取中文段；无逗号则原样） */
const zh = (v: unknown): string => {
    if (typeof v !== "string") return "";
    const parts = v.split(",");
    return (parts.length > 1 ? parts[1] : parts[0])!.trim();
};

/** `{date:"EN,中文,N"}` → `{date:"中文"}`（丢元数据，保留可解释的名字） */
const pick = (m: Record<string, unknown> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m ?? {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
        out[k] = zh(v);
    }
    return out;
};

async function main(): Promise<void> {
    const raw = SRC.startsWith("http") ? await (await fetch(SRC)).text() : readFileSync(SRC, "utf-8");
    const all = JSON.parse(raw) as {
        holidays?: Record<string, unknown>;
        workdays?: Record<string, unknown>;
    };
    const holidays = pick(all.holidays);
    const workdays = pick(all.workdays);
    const dates = [...Object.keys(holidays), ...Object.keys(workdays)].sort();
    if (dates.length === 0) throw new Error("源里没有节假日/调休数据（形状变了？）");

    // 版本：本地装过 chinese-days 就取 package.json，否则记源 URL
    let version = PINNED;
    try {
        const pkg = JSON.parse(readFileSync(join(APP, "node_modules/chinese-days/package.json"), "utf-8")) as { version?: string };
        if (pkg.version) version = `${PINNED}@${pkg.version}`;
    } catch {
        /* 没装依赖（正常：本脚本走 CDN）→ 只记包名 */
    }

    const out = {
        version: 1,
        source: version,
        generatedAt: new Date().toISOString(),
        calendars: {
            "weekend-sat-sun": {
                label: { zh: "周一至周五", en: "Mon–Fri" },
                base: { days: [1, 2, 3, 4, 5] },
            },
            // ① 中国**上班日**：周一至周五，法定假日不上班、调休补班的周末要上班。
            //    判据 = 政府/市场的作息（含调休）。「周中的法定假日」与「周末补班」算法推不出，
            //    只能靠公告表 —— 这就是本表的 holidays/workdays 两个覆盖层。
            "CN-business-day": {
                label: { zh: "中国上班日（含调休补班）", en: "CN working day (incl. makeup)" },
                base: { days: [1, 2, 3, 4, 5] },
                coverage: { from: dates[0]!, to: dates[dates.length - 1]! },
                holidays,
                workdays,
            },
            // ② 中国**周一至周五（排除法定假日）**：与 ① 只差 `workdays` —— 调休上班的周末
            //    **仍是周末**。这是 DeepSeek 官方价页的峰段口径原文：
            //    「Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
            //     excluding Chinese public holidays.」——「Monday through Friday」即周规则，
            //    调休的周六不属于它。同一地域两套作息是常态，故日历按语义分 id（不是按国家）。
            "CN-mon-fri-ex-holiday": {
                label: { zh: "周一至周五（排除中国法定假日）", en: "CN Mon–Fri, excl. public holidays" },
                base: { days: [1, 2, 3, 4, 5] },
                coverage: { from: dates[0]!, to: dates[dates.length - 1]! },
                holidays,
            },
        },
    };
    const dest = join(APP, "src/main/data/calendars.json");
    writeFileSync(dest, JSON.stringify(out) + "\n", "utf-8");
    console.log(
        `calendars: ${version} · holidays=${Object.keys(holidays).length} workdays=${Object.keys(workdays).length} ` +
            `coverage=${dates[0]}→${dates[dates.length - 1]} → ${dest}`,
    );
}

main().catch((e: unknown) => {
    console.error(`gen-calendars 失败（**未写文件**，保留现有产物）: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
