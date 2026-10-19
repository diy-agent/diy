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
import { clipReasoningText, utf8Bytes, type ClipSpec, type ReasoningClipSpec } from "../../src/shared/context/compaction";
import {
    DEFAULT_KEEP,
    DEFAULT_REASONING_CLIP,
    DEFAULT_REASONING_HEADTAIL_DATA,
    validateKeepStages,
} from "../../src/shared/context/compact-keep";
import { blocksToMessages, projectAll, replay, type Op } from "../../src/main/services/local-blocks";
import { CLIP_FULL, defaultBudgetPlan, keepStagesToPlan, runPlan } from "../../src/main/services/compaction-plan";

const LONG = "推".repeat(2_000);
const HEADTAIL_600: ReasoningClipSpec = { type: "headtail", data: { ...DEFAULT_REASONING_HEADTAIL_DATA } };
/** 工具侧的裁法（只为了让工具结果也参与字节账，值取 headtail 1/1） */
const TOOL_CLIP: ClipSpec = { type: "headtail", data: { head: 1, tail: 1, maxLineChars: 100, maxKeepBytes: 512 } };

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
        expect(r.text).toContain("推理省略");
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

describe("配置面（reasoningClip 与 clip 同级）", () => {
    it("validateKeepStages 收合法的 reasoningClip", () => {
        const { stages, issues } = validateKeepStages([
            { type: "steps", must: true, clip: { type: "full" }, reasoningClip: { type: "full" }, data: { n: 6 } },
            { type: "ladder", reasoningClip: { type: "headtail", data: { headChars: 600, tailChars: 0 } } },
        ]);
        expect(issues.filter((i) => i.level === "error")).toEqual([]);
        expect(stages[0]!.reasoningClip).toEqual({ type: "full" });
        expect(stages[1]!.reasoningClip).toEqual({ type: "headtail", data: { headChars: 600, tailChars: 0 } });
    });

    it("headChars=0 被拒（裁到空 = 上游 400，schema 层就拦）", () => {
        const { stages, issues } = validateKeepStages([{ type: "ladder", reasoningClip: { type: "headtail", data: { headChars: 0, tailChars: 0 } } }]);
        expect(stages).toEqual([]);
        const err = issues.find((i) => i.level === "error");
        expect(err?.message).toContain("reasoningClip");
        expect(err?.message).toContain("不可裁空");
    });

    it("未知 type 被拒（判别联合的读侧护栏）", () => {
        const { issues } = validateKeepStages([{ type: "ladder", reasoningClip: { type: "chars", data: {} } }]);
        expect(issues.some((i) => i.level === "error" && i.message.includes("reasoningClip"))).toBe(true);
    });

    it("缺省 plan：must 6 步推理 full；ladder 级用保守缺省（保头 600）", () => {
        expect(DEFAULT_KEEP[0]!.reasoningClip).toEqual({ type: "full" });
        expect(DEFAULT_KEEP[0]!.must).toBe(true);
        expect(DEFAULT_KEEP[1]!.reasoningClip).toEqual({ type: "headtail", data: { headChars: 600, tailChars: 0 } });
        expect(DEFAULT_REASONING_CLIP).toEqual({ type: "headtail", data: { headChars: 600, tailChars: 0 } });

        const p = defaultBudgetPlan(20_480, TOOL_CLIP);
        expect(p.stages[0]!.clip).toEqual(CLIP_FULL);
        expect(p.stages[0]!.reasoningClip).toEqual({ type: "full" });
        expect(p.stages[1]!.reasoningClip?.type).toBe("headtail");
    });
});

describe("选择 + 渲染（两段分离不得破）", () => {
    const store = replay(opsFor(8));

    it("must 6 步（recentSteps）推理字节保真；更旧的按级裁法裁短（先选中者赢）", () => {
        const plan = keepStagesToPlan(DEFAULT_KEEP, 1_000_000, TOOL_CLIP);
        const sel = runPlan(projectAll(store), plan, {
            costOf: (m, clip, rclip) => utf8Bytes(JSON.stringify(m)) + (clip ? 1 : 0) + (rclip ? 1 : 0),
        });
        const all = projectAll(store);
        const texts = reasoningsOf(blocksToMessages(store, { budgetBytes: 1_000_000, plan, defaultReasoningClip: DEFAULT_REASONING_CLIP }));
        // 全量：8 条推理都非空（硬约束：一条都不许消失）
        expect(texts).toHaveLength(8);
        expect(texts.every((t) => t.length > 0)).toBe(true);
        // 最近 6 步（t3..t8）逐字符保真；t1/t2 被裁短
        expect(texts.filter((t) => t === LONG)).toHaveLength(6);
        const clipped = texts.filter((t) => t !== LONG);
        expect(clipped).toHaveLength(2);
        for (const t of clipped) expect(t).toContain("推理省略");
        expect(sel.kept.length).toBe(all.length); // 本用例预算够，选择不是重点（轴行为才是）
    });

    it("裁剪只落投递层：块树 / 投影原文一字不动", () => {
        expect(store.blocks.get("t1_r")!.content).toBe(LONG);
        const all = projectAll(store);
        const firstReasoning = all[1]!.content as { type: string; text: string }[];
        expect(firstReasoning[0]!.text).toBe(LONG);
    });

    it("只声明工具 clip 的 plan **不带** reasoningClips 字段（读侧兼容）", () => {
        const plan = keepStagesToPlan([{ type: "ladder", clip: { type: "full" } }], 1_000_000, TOOL_CLIP);
        const sel = runPlan(projectAll(store), plan, { costOf: () => 1 });
        expect(sel.clips).toBeDefined();
        expect(sel.reasoningClips).toBeUndefined();
    });

    it("声明了 reasoningClip ⇒ reasoningsClips 带出；两轴各报各的", () => {
        const plan = keepStagesToPlan([{ type: "ladder", reasoningClip: { type: "full" } }], 1_000_000, TOOL_CLIP);
        const sel = runPlan(projectAll(store), plan, { costOf: () => 1 });
        expect(sel.clips).toBeUndefined(); // 没人声明工具轴
        expect(sel.reasoningClips?.filter((c) => c?.type === "full").length).toBeGreaterThan(0);
    });

    it("**无 plan / 无缺省** ⇒ 纯层不裁（真发的缺省由 main 注入，见 DEFAULT_REASONING_CLIP）", () => {
        const texts = reasoningsOf(blocksToMessages(store, {}));
        expect(texts.every((t) => t === LONG)).toBe(true);
    });

    it("预算口径跟着推理裁剪走：同一预算下 after 的 keptBytes < before", () => {
        const optsBefore = { budgetBytes: 20_480, plan: keepStagesToPlan(
            [{ type: "steps", must: true, clip: CLIP_FULL, data: { n: 6 } }, { type: "ladder" }],
            20_480,
            TOOL_CLIP,
        ) };
        // before = 老 DEFAULT_KEEP（推理无裁法、也无全局回落）
        const before = blocksToMessages(store, optsBefore).reduce((n, m) => n + utf8Bytes(JSON.stringify(m)), 0);
        const after = blocksToMessages(store, {
            budgetBytes: 20_480,
            plan: keepStagesToPlan(DEFAULT_KEEP, 20_480, TOOL_CLIP),
            defaultReasoningClip: DEFAULT_REASONING_CLIP,
        }).reduce((n, m) => n + utf8Bytes(JSON.stringify(m)), 0);
        expect(after).toBeLessThan(before);
    });

    it("级声明 `full` + 全局缺省不是 full ⇒ 该级仍保真（缺省不得顶掉显式声明）", () => {
        const plan = keepStagesToPlan(
            [{ type: "steps", must: true, reasoningClip: { type: "full" }, data: { n: 6 } }, { type: "ladder" }],
            1_000_000,
            TOOL_CLIP,
        );
        const texts = reasoningsOf(blocksToMessages(store, { budgetBytes: 1_000_000, plan, defaultReasoningClip: DEFAULT_REASONING_CLIP }));
        expect(texts.filter((t) => t === LONG)).toHaveLength(6);
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

describe("两条轴互不干扰（工具 clip 语义 ##343 不变）", () => {
    it("推理轴声明 full 时推理保真，工具轴仍按全局回落 headtail 裁（各按各的轴走）", () => {
        const store = replay(opsFor(2, "推".repeat(50)));
        const msgs = blocksToMessages(store, {
            budgetBytes: 20_480,
            defaultClip: TOOL_CLIP, // 工具侧全局回落（headtail 1/1）
            // 推理侧只声明 full ⇒ 不裁（缺省 DEFAULT_REASONING_CLIP 不得顶掉它）
            plan: keepStagesToPlan([{ type: "ladder", reasoningClip: { type: "full" } }], 20_480, TOOL_CLIP),
            defaultReasoningClip: DEFAULT_REASONING_CLIP,
            transformToolResult: ({ output, clip }) => (clip?.type === "full" ? output : `[裁]${output}`),
        });
        const toolMsgs = msgs.filter((m) => m.role === "tool");
        expect(toolMsgs.length).toBe(2);
        for (const m of toolMsgs) {
            const parts = m.content as { output: { value: string } }[];
            expect(parts[0]!.output.value.startsWith("[裁]")).toBe(true); // 工具轴：回落 headtail 生效
        }
        // 推理轴：级声明 full ⇒ 一字不动
        expect(reasoningsOf(msgs).every((t) => t === "推".repeat(50))).toBe(true);
    });
});
