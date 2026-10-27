import { describe, expect, it } from "vitest";
import {
    renderCompactHeader,
    renderSelfHeader,
    renderSummaryHeader,
    type CompactFacts,
} from "../../src/shared/context/compact-header";
import { ENVELOPE_TOP_KEYS, isEnvelopeText } from "../../src/shared/context/envelope";

const facts: CompactFacts = {
    at: "2026-10-27T09:12:04.000Z",
    droppedMessages: 14_684,
    lines: { from: 5, to: 14_688 },
    source: "/home/u/.diy/local/projects/4/tasks/266/abc/llm.jsonl",
    index: "/home/u/.diy/local/projects/4/tasks/266/abc/llmOffsets.jsonl",
    turns: "/home/u/.diy/local/projects/4/tasks/266/abc/turns.jsonl",
    maxLineBytes: 9_979_753,
};

describe("压缩头部消息（##442）：两种模式都必须是信封、且带单位", () => {
    it("self：`compact:` 事实 + `task:` 指令，首行是顶层键（不会被并进相邻 user）", () => {
        const text = renderSelfHeader(facts);
        expect(text.startsWith("compact:\n")).toBe(true);
        expect(isEnvelopeText(text)).toBe(true);
        // 事实带单位：消息条数 / 行号区间 / 最长行 / 三个路径
        expect(text).toContain("droppedMessages: 14684");
        expect(text).toContain("from: 5");
        expect(text).toContain("to: 14688");
        expect(text).toContain("maxLineBytes: 9979753");
        expect(text).toContain("llmOffsets.jsonl");
        // 指令里必须写清「先截断」——单行几 MB 整段取会撑爆窗口
        expect(text).toContain("head -c 4000");
        // 命令行里的数字**不许**带千分位（`sed -n '5,14,688p'` 会被 sed 当成多列地址 ⇒ 静默错行）
        expect(text).toContain("sed -n '5,14688p'");
        expect(text).not.toContain("14,688p");
        expect(text).toContain("tail -c +$(( $(sed -n");
        expect(text).toContain("9,979,753 字节");
        // 四类产出 + 不许抄原文
        expect(text).toContain("结论");
        expect(text).toContain("踩坑");
        expect(text).toContain("不许抄原文");
    });

    it("self：没有索引/没有 turns 时给的是能用的退路（不编路径）", () => {
        const text = renderSelfHeader({ ...facts, index: undefined, turns: undefined, maxLineBytes: undefined });
        expect(text).not.toContain("llmOffsets.jsonl");
        expect(text).toContain("sed -n '<N>p'");
        expect(text).toContain("先量长度");
    });

    it("model：`summary:` 一段，含结论正文与出处", () => {
        const text = renderSummaryHeader({ ...facts, text: "## 结论\n- 压缩改成窗口 × 0.16" });
        expect(text.startsWith("summary:\n")).toBe(true);
        expect(isEnvelopeText(text)).toBe(true);
        expect(text).toContain("压缩改成窗口 × 0.16");
        expect(text).toContain("llm.jsonl");
        expect(text).toContain("droppedMessages: 14684");
    });

    it("两种模式的顶层键都在白名单里（否则会被 normalizeUserRuns 并进相邻 user）", () => {
        expect(ENVELOPE_TOP_KEYS.has("compact")).toBe(true);
        expect(ENVELOPE_TOP_KEYS.has("summary")).toBe(true);
    });

    it("renderCompactHeader 按 mode 分派；model 缺正文时退化成 self（绝不产出空摘要冒充成功）", () => {
        expect(renderCompactHeader("self", facts).startsWith("compact:\n")).toBe(true);
        expect(renderCompactHeader("model", { ...facts, text: "结论" }).startsWith("summary:\n")).toBe(true);
        // 没有 `text` ⇒ 走 self 形态（压掉必须有替身，空摘要不算替身）
        expect(renderCompactHeader("model", facts).startsWith("compact:\n")).toBe(true);
    });

    it("头部不许带每轮会变的量（窗口占用 / 上一步花费 / 当前时间）", () => {
        const text = renderSelfHeader(facts);
        for (const bad of ["window", "cacheHit", "ratio", "cost", "steps"]) expect(text).not.toContain(bad);
        // 唯一的时刻是压缩那一刻（`at`），不是"现在"
        expect(text.match(/at:/g)?.length).toBe(1);
    });
});
