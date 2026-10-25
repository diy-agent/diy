import { describe, expect, it } from "vitest";
import {
    compactResultSentence,
    compactWhenRows,
    compactWhenSummary,
    fmtTtl,
    windowRatio,
    type CompactWhenInput,
} from "../../src/shared/context/compact-when";

const base: CompactWhenInput = {
    mode: "auto",
    triggers: { systemContextChanged: true, cacheExpired: true, contextWindowOver: 200_000 },
    ttlMs: 300_000,
    budgetBytes: 60 * 1024,
    lastStepTokens: 50_000,
    windowLimit: 200_000,
};

const rowOf = (i: CompactWhenInput, key: string) => compactWhenRows(i).find((r) => r.key === key)!;

describe("compact-when · 「什么时候会压」的文案", () => {
    it("三触发器 + 手动，四行齐全（顺序 = 判据优先级）", () => {
        expect(compactWhenRows(base).map((r) => r.key)).toEqual([
            "systemContextChanged",
            "cacheExpired",
            "contextWindowOver",
            "manual",
        ]);
    });

    it("窗口超限：给出**当前阈值 + 实测值 + 占比**（用户要知道离撞墙还有多远）", () => {
        const r = rowOf(base, "contextWindowOver");
        expect(r.state).toBe("on");
        expect(r.text).toContain("≥ 200000 tok");
        expect(r.text).toContain("本会话最后一步 50000 tok");
        expect(r.text).toContain("占窗口 25%");
    });

    it("窗口超限阈值 0 = 关（不是「阈值为 0 所以一直压」）", () => {
        const r = rowOf({ ...base, triggers: { ...base.triggers, contextWindowOver: 0 } }, "contextWindowOver");
        expect(r.state).toBe("off");
        expect(r.text).toContain("阈值 0");
    });

    it("mode=off：三个触发器全部标 off，并说清「全局 off」", () => {
        const rows = compactWhenRows({ ...base, mode: "off" });
        expect(rows[0].state).toBe("off");
        expect(rows[1].state).toBe("off");
        expect(rows[2].state).toBe("off");
        expect(rows[0].text).toContain("mode=off");
        expect(rows[3].state).toBe("manual"); // 手动不受 mode 影响
    });

    it("缓存过期：TTL 无实测时不写时长（不编数字）", () => {
        expect(rowOf({ ...base, ttlMs: null }, "cacheExpired").text).toContain("无实测时长");
        expect(rowOf(base, "cacheExpired").text).toContain("5 分钟");
        expect(fmtTtl(3_600_000)).toBe("1.0 小时");
        expect(fmtTtl(45_000)).toBe("45 秒");
    });

    it("没有实测用量 ⇒ 说「还没有实测」，不写 0", () => {
        const r = rowOf({ ...base, lastStepTokens: null }, "contextWindowOver");
        expect(r.text).toContain("还没有实测用量");
        expect(windowRatio(null, 200_000)).toBeNull();
        expect(windowRatio(50_000, null)).toBeNull();
    });

    it("hover 里写明：没有「溢出后收紧重试」这条路径（别让用户以为会发生）", () => {
        expect(rowOf(base, "contextWindowOver").hint).toContain("没有「溢出重试」");
    });

    it("summary：off 只剩手动；auto 列出在跑的触发器", () => {
        expect(compactWhenSummary({ ...base, mode: "off" })).toContain("只有手动");
        const s = compactWhenSummary({ ...base, mode: "notify" });
        expect(s).toContain("只提示");
        expect(s).toContain("系统上下文变");
        expect(s).toContain("窗口超限");
        // 三个都关
        const none = compactWhenSummary({
            ...base,
            triggers: { systemContextChanged: false, cacheExpired: false, contextWindowOver: 0 },
        });
        expect(none).toContain("只剩手动");
    });

    it("「压成什么样」：上限 0 要说明是清零，不是「0 字节上限」", () => {
        expect(compactResultSentence(0)).toContain("清零");
        expect(compactResultSentence(60 * 1024)).toContain("60 KB");
    });
});
