// tests/core/date-format.test.ts
// 🎯 时间显示的唯一入口（列表扫读用）：无效输入不产垃圾、相对时间分档正确。
import { describe, it, expect } from "vitest";
import { fmtAgo, fmtClock, fmtShortTime } from "../../src/shared/date-format";

describe("时间格式化", () => {
    const iso = new Date(2026, 8, 26, 14, 7, 9).toISOString(); // 本地 09-26 14:07:09

    it("fmtShortTime：MM-DD HH:MM（不含年份与秒）", () => {
        expect(fmtShortTime(iso)).toBe("09-26 14:07");
    });

    it("fmtClock：HH:MM:SS（同一天内比较用）", () => {
        expect(fmtClock(iso)).toBe("14:07:09");
    });

    it("空 / 无效输入 → 空串（不显示 NaN，也不抛）", () => {
        for (const bad of [undefined, null, "", "not-a-date"]) {
            expect(fmtShortTime(bad)).toBe("");
            expect(fmtClock(bad)).toBe("");
            expect(fmtAgo(bad)).toBe("");
        }
    });

    it("fmtAgo：刚刚 / 分钟 / 小时 / 天", () => {
        const now = new Date(2026, 8, 26, 14, 7, 9).getTime();
        const ago = (s: number) => fmtAgo(new Date(now - s * 1000).toISOString(), now);
        expect(ago(30)).toBe("刚刚");
        expect(ago(5 * 60)).toBe("5 分钟前");
        expect(ago(3 * 3600)).toBe("3 小时前");
        expect(ago(2 * 86400)).toBe("2 天前");
    });
});
