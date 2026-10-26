// tests/core/compact-when.test.ts
// 🎯 「什么时候会压」的文案真源（##423 块 2）—— ##432 刀 2 之后是**事件制**，
// 这里钉的是新判据：首次全量超上限 / 保留段自己重新顶过上限 / 每步按已落盘边界切 / 手动。

import { describe, expect, it } from "vitest";
import {
    autoAuditSentence,
    compactResultSentence,
    compactWhenRows,
    compactWhenSummary,
    fmtStamp,
    fmtTokens,
    fmtTtl,
    windowRatio,
    type CompactWhenInput,
} from "../../src/shared/context/compact-when";

const base: CompactWhenInput = {
    mode: "auto",
    limitTokens: 20_000,
    boundary: { at: "2026-10-25T10:00:00.000Z", dropped: 12, limitTokens: 20_000 },
    retainedTokens: 12_000,
    lastStepTokens: 50_000,
    windowLimit: 200_000,
};

const rowOf = (i: CompactWhenInput, key: string) => compactWhenRows(i).find((r) => r.key === key)!;

describe("compact-when · 「什么时候会压」的判据（事件制）", () => {
    it("四行齐全，顺序 = 判据的时间顺序（首次 → 再压 → 每步 → 手动）", () => {
        expect(compactWhenRows(base).map((r) => r.key)).toEqual(["first", "retained", "reuse", "manual"]);
    });

    it("从没压过 → 只有「第一次压」是开着的，并给出**阈值**（上限）", () => {
        const i = { ...base, boundary: null, retainedTokens: null };
        expect(rowOf(i, "first").state).toBe("on");
        expect(rowOf(i, "first").text).toContain("20,000 tok");
        expect(rowOf(i, "first").text).toContain("发请求之前");
        expect(rowOf(i, "retained").state).toBe("off");
        expect(rowOf(i, "retained").text).toContain("还没有边界");
    });

    it("已有边界 → 「第一次压」关掉并说明哪次事件写的；再压只盯**保留段**", () => {
        expect(rowOf(base, "first").state).toBe("off");
        expect(rowOf(base, "first").text).toContain("丢 12 条");
        expect(rowOf(base, "retained").state).toBe("on");
        expect(rowOf(base, "retained").text).toContain("保留段 12,000 tok / 上限 20,000 tok");
        // 还差多少才再压一次 = 上限 − 保留段（这是「什么时候会压」的答案）
        expect(rowOf(base, "retained").text).toContain("再涨 8,000 tok");
        // 判据只说保留段，不提「全量」（拿全量判会每步都超限）
        expect(rowOf(base, "retained").hint).toContain("不把被丢掉那段算进来");
    });

    it("保留段已经顶过上限 → 明说「下一步就再压一次」", () => {
        const r = rowOf({ ...base, retainedTokens: 25_000 }, "retained");
        expect(r.text).toContain("已顶过上限");
        expect(r.text).toContain("下一步就再压一次");
    });

    it("保留段没有实测 → 如实说，不写 0（0 会被读成「离上限远得很」）", () => {
        expect(rowOf({ ...base, retainedTokens: null }, "retained").text).toContain("还没有实测");
    });

    it("每步投递那一行必须说「按已落盘边界切、不重算」（投递 ≠ 压缩）", () => {
        const r = rowOf(base, "reuse");
        expect(r.state).toBe("on");
        expect(r.text).toContain("已落盘边界");
        expect(r.text).toContain("不重算");
        expect(r.hint).toContain("投递与压缩是两件事");
    });

    it("手动不受 mode / 上限是否顶过影响", () => {
        expect(rowOf({ ...base, mode: "off", boundary: null }, "manual").state).toBe("manual");
    });
});

describe("compact-when · 三触发器只写审计（与投递划清界线）", () => {
    it("mode 三态都说清「只另记一条审计、不改投递切点」", () => {
        for (const m of ["off", "notify", "auto"] as const) {
            const s = autoAuditSentence({ mode: m });
            expect(s).toContain(`mode=${m}`);
            expect(s).toContain("compact.jsonl");
            expect(s).toContain("不改投递切点");
        }
    });
});

describe("compact-when · 人读小件", () => {
    it("fmtTokens：千位分隔 + tok 单位（与上限同一个数域）", () => {
        expect(fmtTokens(20_000)).toBe("20,000 tok");
        expect(fmtTokens(820)).toBe("820 tok");
    });

    it("windowRatio：量不到就是 null（不写 0）", () => {
        expect(windowRatio(50_000, 200_000)).toBe(25);
        expect(windowRatio(null, 200_000)).toBeNull();
        expect(windowRatio(50_000, null)).toBeNull();
        expect(windowRatio(50_000, 0)).toBeNull();
    });

    it("fmtStamp：ISO → MM-DD HH:mm（坏输入原样返回，不吞）", () => {
        expect(fmtStamp("2026-10-25T10:30:00.000Z")).toMatch(/^10-2\d* \d\d:\d\d$/);
        expect(fmtStamp("not-a-date")).toBe("not-a-date");
    });

    it("fmtTtl 仍用于其他面板（实测优先，无实测说无实测）", () => {
        expect(fmtTtl(null)).toBe("无实测时长");
        expect(fmtTtl(300_000)).toBe("5 分钟");
        expect(fmtTtl(3_600_000)).toBe("1.0 小时");
        expect(fmtTtl(45_000)).toBe("45 秒");
    });

    it("压成什么样：上限 + 累加规则 + 保头 + 配对 + 算一次", () => {
        const s = compactResultSentence(20_000);
        expect(s).toContain("20,000 tok");
        expect(s).toContain("从最后一步往前累加");
        expect(s).toContain("保头 600 tok");
        expect(s).toContain("tool 配对平衡");
        expect(s).toContain("只在压缩事件时算一次");
    });

    it("一句话总结：压过 / 没压过 + 上限", () => {
        expect(compactWhenSummary(base)).toContain("已压过");
        expect(compactWhenSummary({ ...base, boundary: null })).toContain("还没压过");
    });
});
