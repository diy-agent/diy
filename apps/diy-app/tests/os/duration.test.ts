// tests/os/duration.test.ts
// 时长文本工具是 OS 无关的，但它是两套策略共用的数据形状 —— 跟着 os 集合跑。

import { describe, expect, it } from "vitest";
import { formatEtime, parseEtime } from "../../src/main/os/duration";

describe("parseEtime / formatEtime", () => {
    it("互逆（分钟级 / 小时级 / 天级）", () => {
        for (const ms of [0, 65_000, 3_723_000, (2 * 24 * 3600 + 3605) * 1000]) {
            expect(parseEtime(formatEtime(ms))).toBe(ms);
        }
    });

    it("格式与 ps -o etime 对齐", () => {
        expect(formatEtime(184_000)).toBe("03:04");
        expect(formatEtime(3_723_000)).toBe("01:02:03");
        expect(formatEtime((2 * 24 * 3600 + 3605) * 1000)).toBe("2-01:00:05");
    });

    it("认不出 ⇒ null；负数按 0", () => {
        expect(parseEtime("")).toBeNull();
        expect(formatEtime(-5)).toBe("00:00");
    });
});
