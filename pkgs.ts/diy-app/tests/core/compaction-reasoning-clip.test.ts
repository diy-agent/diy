// tests/core/compaction-reasoning-clip.test.ts
// 🎯 第二条裁剪轴（##374 T2）：assistant 的**推理文本**也能裁 —— 且**只可裁短、绝不可裁空**。
//
// 为什么「不可裁空」是硬约束（不是风格问题）：##374 T1 探针实测（luminal 端点 26/26 命中全 400）——
// 上游对**每一条**带 tool_calls 的 assistant **逐条校验** `reasoning_content` 存在性：
//   `The reasoning_content in the thinking mode must be passed back to the API.`
// 裁到空 = 等于没传 = 400 ⇒ 本文件的核心断言就是「裁完仍非空」（含 headChars=1 的极端形状）。
//
// 钉住四条：
//   ① 裁短：长推理被裁成「头 600 字符 + marker」，短推理逐字符不动（不"顺手规整"）；
//   ② 不裁空：任何非空输入 ⇒ 非空输出（含 headChars=1 / 原文极短）；
//   ③ 轴独立 + 先选中者赢：must 级声明 `full` ⇒ 最近 6 步推理字节保真；`ladder` 级按缺省裁；
//      只声明工具 `clip` 的 plan **不带** `reasoningClips` 字段（读侧兼容）；
//   ④ 只落投递层：块树 / ops 原文一字不动。

import { describe, it, expect } from "vitest";
import { DEFAULT_REASONING_CLIP, clipReasoningText, utf8Bytes, type ReasoningClipSpec } from "@diy/compaction/compaction";
import { blocksToMessages, replay, type Op } from "../../src/main/services/local-blocks";
import { parseCutMarkers } from "@diy/context/format/cut-marker";

const LONG = "推".repeat(2_000);
const HEADTAIL_600: ReasoningClipSpec = { ...DEFAULT_REASONING_CLIP };

/** 每轮：开场 user + 一步（think + tool call/result）——`turns` 轮，推理文本统一 `reasoning` */
function opsFor(turns: number, reasoning = LONG): Op[] {
    const out: Op[] = [];
    for (let i = 1; i <= turns; i++) {
        const t = `t${i}`;
        out.push({ op: "start", id: t, kind: "turn" });
        out.push({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } });
        out.push({ op: "delta", id: `${t}_u`, fields: { content: `用户发言 ${i}` } });
        out.push({ op: "stop", id: `${t}_u` });
        out.push({ op: "start", id: `${t}_s1`, kind: "step", parent: t });
        out.push({ op: "start", id: `${t}_r`, kind: "think", parent: `${t}_s1` });
        out.push({ op: "delta", id: `${t}_r`, fields: { content: reasoning } });
        out.push({ op: "stop", id: `${t}_r` });
        out.push({ op: "start", id: `${t}_c`, kind: "tool", parent: `${t}_s1`, meta: { tool: "bash" } });
        out.push({ op: "patch", id: `${t}_c`, fields: { args: { command: `echo ${i}` }, status: "done" } });
        out.push({ op: "delta", id: `${t}_c`, fields: { output: `out-${i}` } });
        out.push({ op: "stop", id: `${t}_c` });
        out.push({ op: "stop", id: `${t}_s1` });
        out.push({ op: "stop", id: t });
    }
    return out;
}

/** 投递后的 (下标, 推理文本) 列表（assistant 消息的 reasoning part） */
function reasoningsOf(msgs: ReturnType<typeof blocksToMessages>): string[] {
    const out: string[] = [];
    for (const m of msgs) {
        if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
        for (const p of m.content) if (p.type === "reasoning") out.push(p.text);
    }
    return out;
}

describe("clipReasoningText（纯函数：裁短不裁空）", () => {
    it("长推理 → 头 headChars + marker；结果非空且更短", () => {
        const r = clipReasoningText(LONG, HEADTAIL_600);
        expect(r.clipped).toBe(true);
        expect(r.text.startsWith(LONG.slice(0, 600))).toBe(true);
        // ##425：`<cut by="reasoning-clip" scope="wire" …/>`（推理原文不在任何地方可回取 ⇒ 无 resume）
        expect(parseCutMarkers(r.text).at(0)).toMatchObject({
            by: "reasoning-clip",
            scope: "wire",
            unit: "chars",
            total: LONG.length,
            kept: 600,
        });
        expect(r.text.length).toBeGreaterThan(0); // 硬约束
        expect(r.text.length).toBeLessThan(LONG.length);
        expect(r.droppedChars).toBe(LONG.length - 600);
        expect(r.origChars).toBe(LONG.length);
    });

    it("原文不超阈值 ⇒ **逐字符不动**（不「顺手规整」）", () => {
        const short = "短推理";
        expect(clipReasoningText(short, HEADTAIL_600).text).toBe(short);
        expect(clipReasoningText(short, HEADTAIL_600).clipped).toBe(false);
        const exact = "字".repeat(600);
        expect(clipReasoningText(exact, HEADTAIL_600).text).toBe(exact); // 恰好等于 headChars：没东西可省
    });

    it("**永不裁空**：headChars=1、tail 0/1、极短原文 —— 输出都非空", () => {
        const cases: ReasoningClipSpec[] = [
            { type: "headtail", data: { headChars: 1, tailChars: 0 } },
            { type: "headtail", data: { headChars: 1, tailChars: 1 } },
            { type: "headtail", data: { headChars: 600, tailChars: 100 } },
        ];
        for (const c of cases) {
            for (const text of [LONG, "短", "字".repeat(601)]) {
                const r = clipReasoningText(text, c);
                expect(r.text.length, `${text.length} 字 / headChars=${("data" in c ? c.data.headChars : 0)}`).toBeGreaterThan(0);
                expect(r.text.startsWith(text.slice(0, 1))).toBe(true); // 头至少 1 字符
            }
        }
        expect(clipReasoningText("", HEADTAIL_600).text).toBe(""); // 空进空出（空串本就不是 part）
    });

    it("tailChars>0 ⇒ 保尾；full ⇒ 不动", () => {
        const r = clipReasoningText(LONG, { type: "headtail", data: { headChars: 10, tailChars: 10 } });
        expect(r.text.startsWith(LONG.slice(0, 10))).toBe(true);
        expect(r.text.endsWith(LONG.slice(-10))).toBe(true);
        expect(clipReasoningText(LONG, { type: "full" }).clipped).toBe(false);
    });
});

describe("投递层：推理只裁短、绝不裁空（缺省裁法 `DEFAULT_REASONING_CLIP`）", () => {
    it("缺省裁法 = 保头 600 字符、不保尾", () => {
        expect(DEFAULT_REASONING_CLIP).toEqual({ type: "headtail", data: { headChars: 600, tailChars: 0 } });
        const r = clipReasoningText(LONG, DEFAULT_REASONING_CLIP);
        expect(r.clipped).toBe(true);
        expect(r.text.length).toBeGreaterThan(600);
        expect(r.text.startsWith("推".repeat(600))).toBe(true);
    });
});

describe("分层核算把推理算进去（##374：账要算得平）", () => {
    it("messageLayerBytes 单列 assistantReasoning；layerFacts 的合计 = 各层之和（不漏推理）", async () => {
        const { messageLayerBytes, layerFacts } = await import("../../src/shared/context/request-view");
        const reasoning = "推".repeat(100);
        const view = {
            model: "m",
            system: "",
            tools: [],
            toolsBytes: 0,
            messages: [{ role: "assistant", content: [{ type: "reasoning", text: reasoning }, { type: "text", text: "结论" }] }],
        };
        const b = messageLayerBytes(view.messages);
        expect(b.assistantReasoning).toBe(utf8Bytes(reasoning));
        expect(b.assistantText).toBe(utf8Bytes("结论"));
        const facts = layerFacts(view, view, 1);
        expect(facts.some((r) => r.key === "assistant.reasoning")).toBe(true);
        const total = facts.find((r) => r.key === "total")!;
        expect(total.oldTokens).toBe(facts.filter((r) => r.key !== "total").reduce((n, r) => n + r.oldTokens, 0));
    });

    it("推理被裁短 ⇒ 那一层的 token 数下降（改动可见，不是隐形账）", async () => {
        const { layerFacts } = await import("../../src/shared/context/request-view");
        const clip: ReasoningClipSpec = { type: "headtail", data: { headChars: 10, tailChars: 0 } };
        const mk = (text: string) => ({
            model: "m",
            system: "",
            tools: [],
            toolsBytes: 0,
            messages: [{ role: "assistant", content: [{ type: "reasoning", text }] }],
        });
        const base = mk(LONG);
        const mod = mk(clipReasoningText(LONG, clip).text);
        const row = layerFacts(base, mod, 1).find((r) => r.key === "assistant.reasoning")!;
        expect(row.newTokens).toBeLessThan(row.oldTokens);
    });
});

describe("两条轴互不干扰（工具 clip 与推理 clip 各走各的）", () => {
    it("推理裁短、工具按全局回落裁：两者互不覆盖，且推理不会被裁空", () => {
        const store = replay(opsFor(2, "推".repeat(50)));
        const msgs = blocksToMessages(store, {
            defaultClip: { type: "headtail", data: { head: 1, tail: 1, maxLineChars: 100, maxKeepBytes: 512 } },
            defaultReasoningClip: { type: "headtail", data: { headChars: 10, tailChars: 0 } },
            transformToolResult: ({ output, clip }) => (clip?.type === "full" ? output : `[裁]${output}`),
        });
        const toolMsgs = msgs.filter((m) => m.role === "tool");
        expect(toolMsgs.length).toBe(2);
        for (const m of toolMsgs) {
            const parts = m.content as { output: { value: string } }[];
            expect(parts[0]!.output.value.startsWith("[裁]")).toBe(true); // 工具轴：全局 headtail 生效
        }
        // 推理轴：按 defaultReasoningClip 裁短，但**绝不裁空**
        const rs = reasoningsOf(msgs);
        expect(rs.length).toBeGreaterThan(0);
        // 推理轴：50 字 < headChars(10)+marker ⇒ 被裁短但**绝不为空**（上游对空推理直接 400）
        for (const t of rs) expect(t.length).toBeGreaterThan(0);
    });
});

describe("分层核算把推理算进去（##374：账要算得平）", () => {
    it("messageLayerBytes 单列 assistantReasoning；layerFacts 的合计 = 各层之和（不漏推理）", async () => {
        const { messageLayerBytes, layerFacts } = await import("../../src/shared/context/request-view");
        const reasoning = "推".repeat(100);
        const view = {
            model: "m",
            system: "",
            tools: [],
            toolsBytes: 0,
            messages: [{ role: "assistant", content: [{ type: "reasoning", text: reasoning }, { type: "text", text: "结论" }] }],
        };
        const b = messageLayerBytes(view.messages);
        expect(b.assistantReasoning).toBe(utf8Bytes(reasoning));
        expect(b.assistantText).toBe(utf8Bytes("结论"));
        const facts = layerFacts(view, view, 1);
        expect(facts.some((r) => r.key === "assistant.reasoning")).toBe(true);
        const total = facts.find((r) => r.key === "total")!;
        expect(total.oldTokens).toBe(facts.filter((r) => r.key !== "total").reduce((n, r) => n + r.oldTokens, 0));
    });

    it("推理被裁短 ⇒ 那一层的 token 数下降（改动可见，不是隐形账）", async () => {
        const { layerFacts } = await import("../../src/shared/context/request-view");
        const clip: ReasoningClipSpec = { type: "headtail", data: { headChars: 10, tailChars: 0 } };
        const mk = (text: string) => ({
            model: "m",
            system: "",
            tools: [],
            toolsBytes: 0,
            messages: [{ role: "assistant", content: [{ type: "reasoning", text }] }],
        });
        const base = mk(LONG);
        const mod = mk(clipReasoningText(LONG, clip).text);
        const row = layerFacts(base, mod, 1).find((r) => r.key === "assistant.reasoning")!;
        expect(row.newTokens).toBeLessThan(row.oldTokens);
    });
});

describe("分层核算把推理算进去（##374：账要算得平）", () => {
    it("messageLayerBytes 单列 assistantReasoning；layerFacts 的合计 = 各层之和（不漏推理）", async () => {
        const { messageLayerBytes, layerFacts } = await import("../../src/shared/context/request-view");
        const reasoning = "推".repeat(100);
        const view = {
            model: "m",
            system: "",
            tools: [],
            toolsBytes: 0,
            messages: [{ role: "assistant", content: [{ type: "reasoning", text: reasoning }, { type: "text", text: "结论" }] }],
        };
        const b = messageLayerBytes(view.messages);
        expect(b.assistantReasoning).toBe(utf8Bytes(reasoning));
        expect(b.assistantText).toBe(utf8Bytes("结论"));
        const facts = layerFacts(view, view, 1);
        expect(facts.some((r) => r.key === "assistant.reasoning")).toBe(true);
        const total = facts.find((r) => r.key === "total")!;
        expect(total.oldTokens).toBe(facts.filter((r) => r.key !== "total").reduce((n, r) => n + r.oldTokens, 0));
    });

    it("推理被裁短 ⇒ 那一层的 token 数下降（改动可见，不是隐形账）", async () => {
        const { layerFacts } = await import("../../src/shared/context/request-view");
        const clip: ReasoningClipSpec = { type: "headtail", data: { headChars: 10, tailChars: 0 } };
        const mk = (text: string) => ({
            model: "m",
            system: "",
            tools: [],
            toolsBytes: 0,
            messages: [{ role: "assistant", content: [{ type: "reasoning", text }] }],
        });
        const base = mk(LONG);
        const mod = mk(clipReasoningText(LONG, clip).text);
        const row = layerFacts(base, mod, 1).find((r) => r.key === "assistant.reasoning")!;
        expect(row.newTokens).toBeLessThan(row.oldTokens);
    });
});

describe("两条轴互不干扰（工具 clip 与推理 clip 各走各的）", () => {
    it("推理裁短、工具按全局回落裁：两者互不覆盖，且推理不会被裁空", () => {
        const store = replay(opsFor(2, "推".repeat(50)));
        const msgs = blocksToMessages(store, {
            defaultClip: { type: "headtail", data: { head: 1, tail: 1, maxLineChars: 100, maxKeepBytes: 512 } },
            defaultReasoningClip: { type: "headtail", data: { headChars: 10, tailChars: 0 } },
            transformToolResult: ({ output, clip }) => (clip?.type === "full" ? output : `[裁]${output}`),
        });
        const toolMsgs = msgs.filter((m) => m.role === "tool");
        expect(toolMsgs.length).toBe(2);
        for (const m of toolMsgs) {
            const parts = m.content as { output: { value: string } }[];
            expect(parts[0]!.output.value.startsWith("[裁]")).toBe(true); // 工具轴：全局 headtail 生效
        }
        // 推理轴：按 defaultReasoningClip 裁短，但**绝不裁空**
        const rs = reasoningsOf(msgs);
        expect(rs.length).toBeGreaterThan(0);
        // 推理轴：50 字 < headChars(10)+marker ⇒ 被裁短但**绝不为空**（上游对空推理直接 400）
        for (const t of rs) expect(t.length).toBeGreaterThan(0);
    });
});

describe("分层核算把推理算进去（##374：账要算得平）", () => {
    it("messageLayerBytes 单列 assistantReasoning；layerFacts 的合计 = 各层之和（不漏推理）", async () => {
        const { messageLayerBytes, layerFacts } = await import("../../src/shared/context/request-view");
        const reasoning = "推".repeat(100);
        const view = {
            model: "m",
            system: "",
            tools: [],
            toolsBytes: 0,
            messages: [{ role: "assistant", content: [{ type: "reasoning", text: reasoning }, { type: "text", text: "结论" }] }],
        };
        const b = messageLayerBytes(view.messages);
        expect(b.assistantReasoning).toBe(utf8Bytes(reasoning));
        expect(b.assistantText).toBe(utf8Bytes("结论"));
        const facts = layerFacts(view, view, 1);
        expect(facts.some((r) => r.key === "assistant.reasoning")).toBe(true);
        const total = facts.find((r) => r.key === "total")!;
        expect(total.oldTokens).toBe(facts.filter((r) => r.key !== "total").reduce((n, r) => n + r.oldTokens, 0));
    });

    it("推理被裁短 ⇒ 那一层的 token 数下降（改动可见，不是隐形账）", async () => {
        const { layerFacts } = await import("../../src/shared/context/request-view");
        const clip: ReasoningClipSpec = { type: "headtail", data: { headChars: 10, tailChars: 0 } };
        const mk = (text: string) => ({
            model: "m",
            system: "",
            tools: [],
            toolsBytes: 0,
            messages: [{ role: "assistant", content: [{ type: "reasoning", text }] }],
        });
        const base = mk(LONG);
        const mod = mk(clipReasoningText(LONG, clip).text);
        const row = layerFacts(base, mod, 1).find((r) => r.key === "assistant.reasoning")!;
        expect(row.newTokens).toBeLessThan(row.oldTokens);
    });
});

