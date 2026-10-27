import { describe, expect, it } from "vitest";
import { renderCompactHeader, type CompactFacts } from "../../src/shared/context/compact-header";
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

describe("压缩头部消息（##442）：**一份结构**，只有 summary 来源不同", () => {
    it("两种来源的字段完全一样：at / droppedMessages / lines / source / index / turns / summary / task", () => {
        const model = renderCompactHeader({ ...facts, summary: "## 结论\n- 改成窗口 × 0.16" });
        const self = renderCompactHeader({ ...facts, summary: "" });
        const keys = (t: string): string[] =>
            t.split("\n").filter((l) => /^ {2}[a-zA-Z]/.test(l)).map((l) => l.trim().split(":")[0]!);
        expect(keys(model)).toEqual(keys(self));
        // 恒在的两个键（不管来源）：summary / task
        expect(keys(model)).toContain("summary");
        expect(keys(model)).toContain("task");
        expect(keys(self)).toContain("summary");
        expect(keys(self)).toContain("task");
    });

    it("是信封（首行 = 顶层键 compact:）⇒ 不会被并进相邻 user 正文", () => {
        const t = renderCompactHeader({ ...facts, summary: "x" });
        expect(t.startsWith("compact:\n")).toBe(true);
        expect(isEnvelopeText(t)).toBe(true);
        expect(ENVELOPE_TOP_KEYS.has("compact")).toBe(true);
    });

    it("`task` 在 `compact` 里面（不是第二个顶层键）", () => {
        const t = renderCompactHeader({ ...facts, summary: "" });
        const topKeys = t
            .split("\n")
            .filter((l) => /^[a-zA-Z]/.test(l))
            .map((l) => l.split(":")[0]);
        expect(topKeys).toEqual(["compact"]);
    });

    it("summary 非空 ⇒ 照着结论干；空 ⇒ 明确说「你自己查」并给出四类产出", () => {
        const withSummary = renderCompactHeader({ ...facts, summary: "## 结论\n- a" });
        expect(withSummary).toContain("summary` 是那段对话的结论");
        expect(withSummary).not.toContain("你自己查出来");

        const without = renderCompactHeader({ ...facts, summary: "" });
        expect(without).toContain("你需要自己查出来");
        for (const k of ["结论", "决策", "未完成", "踩坑"]) expect(without).toContain(k);
        expect(without).toContain("不许抄原文");
    });

    it("检索命令：命令行不带千分位；单行长度显式告警", () => {
        const t = renderCompactHeader({ ...facts, summary: "" });
        expect(t).toContain("sed -n '5,14688p'");
        expect(t).not.toContain("14,688p"); // 逗号会被 sed 当成多列地址 ⇒ 静默错行
        expect(t).toContain("tail -c +$(( $(sed -n");
        expect(t).toContain("head -c 4000");
        expect(t).toContain("9,979,753 字节");
    });

    it("没索引 / 没 turns 时给能用的退路（不编路径）", () => {
        const t = renderCompactHeader({ ...facts, index: undefined, turns: undefined, maxLineBytes: undefined, summary: "" });
        expect(t).not.toContain("llmOffsets.jsonl");
        expect(t).toContain("sed -n '<N>p'");
        expect(t).toContain("单行可能很长");
    });

    it("task 可覆盖（调用方要给更具体的指导时）", () => {
        const t = renderCompactHeader({ ...facts, summary: "x", task: "照未完成项继续" });
        expect(t).toContain("照未完成项继续");
    });

    it("头部不许带每轮会变的量（窗口占用 / 上一步花费 / 当前时间）", () => {
        const t = renderCompactHeader({ ...facts, summary: "" });
        for (const bad of ["window", "cacheHit", "ratio", "cost", "steps"]) expect(t).not.toContain(bad);
        expect(t.match(/at:/g)?.length).toBe(1); // 只有压缩那一刻
    });
});

describe("上一次摘要的处置（##442 追问）：继承 + 增量合并", () => {
    it("继承来的结论要在 task 里标明「可能已过时」（别当本轮结论）", () => {
        const t = renderCompactHeader({ ...facts, summary: "## 结论\n- 旧结论", summaryCarried: true });
        expect(t).toContain("上一次压缩");
        expect(t).toContain("可能已经过时");
        // 不是继承来的就不许出现这句
        const fresh = renderCompactHeader({ ...facts, summary: "## 结论\n- 新结论" });
        expect(fresh).not.toContain("可能已经过时");
    });
});

describe("摘要抽取提示词：有无旧结论两种形态（##442）", () => {
    it("无旧结论 ⇒ 不含合并段；有旧结论 ⇒ 明确三条合并规则 + 原文块", async () => {
        const { summaryExtractionPrompt } = await import("../../src/shared/context/summary");
        const plain = summaryExtractionPrompt("历史正文", 3);
        expect(plain).not.toContain("上一次压缩的结论");

        const merged = summaryExtractionPrompt("历史正文", 3, "## 旧结论\n- 保留这条");
        expect(merged).toContain("上一次压缩的结论");
        expect(merged).toContain("仍然成立的事实**保留**");
        expect(merged).toContain("已经过时 / 已被推翻的**丢掉**");
        expect(merged).toContain("不要写成第二份");
        expect(merged).toContain("保留这条"); // 旧结论原文进输入
        expect(merged).toContain("历史正文"); // 新被压段也在
    });
});
