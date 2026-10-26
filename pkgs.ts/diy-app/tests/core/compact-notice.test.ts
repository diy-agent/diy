import { describe, it, expect } from "vitest";
import { COMPACT_ASK, renderCompactNotice, withCompactNotice } from "../../src/shared/context/compact-notice";
import { ENVELOPE_TOP_KEYS, hasTopLevelKey, isEnvelopeText, stripRuntimeSections } from "../../src/shared/context/envelope";

describe("compact-notice 渲染（##442 刀2 后半）", () => {
    const sample = {
        at: "2026-10-26T02:18:00.000Z",
        dropped: 1514,
        range: "14393-15906",
        source: "/Users/ccc/.diy/local/projects/4/tasks/266-abc/turns.jsonl",
        more: "/Users/ccc/.diy/local/projects/4/tasks/266-abc/ops.jsonl",
        ask: COMPACT_ASK,
    };
    const yaml = renderCompactNotice(sample);

    it("自占一条 envelope 消息：首行即 from，且含 compact 段", () => {
        expect(yaml.startsWith("from:")).toBe(true);
        expect(yaml).toContain("compact:");
        expect(yaml).toContain("at: 2026-10-26T02:18:00.000Z");
        expect(yaml).toContain("dropped: 1514");
        expect(yaml).toContain("range: 14393-15906");
        expect(yaml).toContain("source: /Users/ccc/.diy");
        expect(yaml).toContain("more: /Users/ccc/.diy");
        expect(yaml).toContain("ask:");
    });

    it("ENVELOPE_TOP_KEYS 含 compact，且 isEnvelopeText 判真", () => {
        expect(ENVELOPE_TOP_KEYS.has("compact")).toBe(true);
        expect(isEnvelopeText(yaml)).toBe(true);
        expect(hasTopLevelKey(yaml, "compact")).toBe(true);
        expect(hasTopLevelKey(yaml, "from")).toBe(true);
    });

    it("判据⑥：不含 runtime / runtimeDiff", () => {
        expect(yaml).not.toContain("runtime:");
        expect(yaml).not.toContain("runtimeDiff:");
    });

    it("判据⑦：source/more 是绝对路径", () => {
        expect(sample.source.startsWith("/")).toBe(true);
        expect(sample.more.startsWith("/")).toBe(true);
        expect(yaml).toContain(sample.source);
        expect(yaml).toContain(sample.more);
    });

    it("stripRuntimeSections 保留 compact/from（线索不丢）", () => {
        const msg = `${yaml}\nuser:\n  message: hello`;
        expect(stripRuntimeSections(msg)).toBe(msg);
        // 含 runtime 时只剥 runtime，compact 仍在
        const withRuntime = `runtime:\n  a: 1\n${yaml}\nuser:\n  message: hi`;
        // 该消息首行是 runtime，故 isEnvelope 且含 user，但 strip 后 compact 仍在
        const stripped = stripRuntimeSections(withRuntime);
        expect(stripped).toContain("compact:");
        expect(stripped).not.toContain("runtime:");
    });

    it("withCompactNotice：空串不注入，非空前置一条且 role=user", () => {
        expect(withCompactNotice([{ role: "user", content: "hi" } as any], "")).toEqual([
            { role: "user", content: "hi" },
        ]);
        const out = withCompactNotice([{ role: "user", content: "hi" } as any], yaml);
        expect(out.length).toBe(2);
        expect(out[0]!.role).toBe("user");
        expect(out[0]!.content).toBe(yaml);
        expect(out[1]!.content).toBe("hi");
    });

    it("判据⑧：COMPACT_ASK 含重建指令关键词", () => {
        expect(COMPACT_ASK).toContain("turns.jsonl");
        expect(COMPACT_ASK).toContain("ops.jsonl");
        expect(COMPACT_ASK).toContain("不许抄原文");
    });
});
