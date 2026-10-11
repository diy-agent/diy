// tests/core/date-format.test.ts
// 🎯 时间显示的唯一入口（列表扫读用）：无效输入不产垃圾、相对时间分档正确。
import { describe, it, expect } from "vitest";
import { fmtAgo, fmtClock, fmtShortTime, fmtTurnFull, fmtTurnStamp, turnTimeOf } from "../../src/shared/date-format";

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

describe("turnId 时刻（对话流时间真源）", () => {
    // 真源契约：turnId = `t` + 13 位 epoch 毫秒（main 侧 local-agent 用 `t${Date.now()}` 造）
    const at = new Date(2026, 8, 26, 14, 7, 9);
    const turnId = `t${at.getTime()}`;

    it("合法 id → 该时刻；展示格式与精确格式同源", () => {
        expect(turnTimeOf(turnId)?.getTime()).toBe(at.getTime());
        expect(fmtTurnStamp(turnId)).toBe("09-26 14:07");
        expect(fmtTurnFull(turnId)).toBe("2026-09-26 14:07:09");
    });

    it("旧格式 / 非法 id → null（不编时间，也不显示占位）", () => {
        for (const bad of ["", "t1", "t12345", "abc", `x${at.getTime()}`, `t${at.getTime()}1`, undefined, null]) {
            expect(turnTimeOf(bad)).toBeNull();
            expect(fmtTurnStamp(bad)).toBeNull();
            expect(fmtTurnFull(bad)).toBeNull();
        }
    });

    it("后缀型 id（step/tool 块）不当成 turn：只有纯 turnId 才有时刻", () => {
        // step/tool 块 id 以 turnId 为前缀（`<turnId>_s1`）——它们是**同一个时刻**的从属块，
        // 本身不该被当作"一轮的起点"解析（本函数只认纯 turnId，避免张冠李戴）
        expect(fmtTurnStamp(`${turnId}_s1`)).toBeNull();
    });
});
