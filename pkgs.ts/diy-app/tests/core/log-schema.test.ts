// tests/core/log-schema.test.ts
// 🎯 落盘日志的 zod 契约（##269 D6）—— 「初版紧凑、扩展松散、失败即异常数据」
//
// 三条契约：
//   ① 必需字段缺失 → **异常数据**（不进 lines、给出行号+原因），不当成"缺了就缺了吧"；
//   ② 扩展容忍 → 未知字段、可选字段缺失都不算异常（将来加字段，旧读者不许报错）；
//   ③ 说明文本从 zod 派生（不是手写第二真源）。

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
    LlmLogLineSchema,
    describeAnomalies,
    readLlmLog,
} from "../../src/shared/context/log-schema";
import { fieldDocs, fieldNames, renderFieldDocs } from "../../src/shared/schema-doc";

// ─── ① 日志行：必需严格 ────────────────────────────────

describe("LlmLogLineSchema：初版紧凑（必需字段缺一即异常）", () => {
    const good = { role: "user", content: "话", turn: "t1" };

    it("最小合法行：role/content/turn 三条必需", () => {
        expect(LlmLogLineSchema.safeParse(good).success).toBe(true);
        for (const k of ["role", "content", "turn"] as const) {
            const bad: Record<string, unknown> = { ...good };
            delete bad[k];
            expect(LlmLogLineSchema.safeParse(bad).success, `缺 ${k} 应失败`).toBe(false);
        }
    });

    it("role 是**无法宽松处理**的字段：非法值也不放过", () => {
        expect(LlmLogLineSchema.safeParse({ ...good, role: "system" }).success).toBe(false);
    });

    it("step/origin 缺失不算异常（开场 user 本就没有 step）", () => {
        expect(LlmLogLineSchema.safeParse(good).success).toBe(true);
        expect(LlmLogLineSchema.safeParse({ ...good, step: "t1_s1", origin: "tool" }).success).toBe(true);
    });
});

describe("LlmLogLineSchema：扩展松散（将来加字段，旧读者不许报错）", () => {
    it("未知字段容忍，且**保留**（不因校验而丢字段）", () => {
        const r = LlmLogLineSchema.safeParse({ role: "tool", content: [], turn: "t1", futureField: 42 });
        expect(r.success).toBe(true);
        expect((r.data as Record<string, unknown>)["futureField"]).toBe(42);
    });
});

// ─── ② 读日志：异常行单列，不进统计 ─────────────────────

describe("readLlmLog：异常数据单列（不计入统计）", () => {
    it("合法行入 lines；坏 JSON / 缺 role 入 anomalies（带行号）", () => {
        const text = [
            JSON.stringify({ role: "user", content: "a", turn: "t1" }),
            "{ 半行",
            JSON.stringify({ content: "没有角色", turn: "t1" }),
            JSON.stringify({ role: "assistant", content: [{ type: "text", text: "b" }], turn: "t1" }),
            "",
        ].join("\n");
        const r = readLlmLog(text);
        expect(r.lines).toHaveLength(2);
        expect(r.total).toBe(4);
        expect(r.anomalies.map((a) => a.line)).toEqual([2, 3]);
        expect(r.anomalies[0]!.reason).toContain("JSON 解析失败");
        expect(r.anomalies[1]!.reason).toContain("role");
    });

    it("describeAnomalies：最多列 3 条 + 总数（排障要典型，不刷屏）", () => {
        const as = [1, 2, 3, 4, 5].map((n) => ({ line: n, reason: "r", excerpt: "" }));
        const s = describeAnomalies(as);
        expect(s).toContain("第 1 行");
        expect(s).toContain("等共 5 条");
        // 3 条明细 + 1 条"等共 N 条"尾巴 = 4 段
        expect(s.split("；")).toHaveLength(4);
        expect(s).not.toContain("第 4 行");
        expect(describeAnomalies([])).toBe("");
    });
});

// ─── ③ 说明文本从 zod 派生 ────────────────────────────

describe("schema-doc：字段说明由 zod 派生（不手写第二真源）", () => {
    const S = z.object({
        a: z.string().describe("甲"),
        b: z.number().optional().describe("乙"),
        c: z.string().default("x").describe("丙（有默认值 = 可选）"),
    });

    it("保序取字段 + required 由「能否接受 undefined」判定", () => {
        expect(fieldDocs(S)).toEqual([
            { name: "a", desc: "甲", required: true },
            { name: "b", desc: "乙", required: false },
            { name: "c", desc: "丙（有默认值 = 可选）", required: false },
        ]);
        expect(fieldNames(S)).toEqual(["a", "b", "c"]);
    });

    it("渲染成注释行：可选才标（必填不刷噪音），名字对齐", () => {
        const out = renderFieldDocs(S);
        expect(out[0]).toBe("#   a 甲");
        expect(out[1]).toBe("#   b 乙（可选）");
        expect(out[2]).toContain("丙（有默认值 = 可选）（可选）");
        // 对齐 = 名字列宽相同（取最长字段名）
        expect(out.every((l) => l.startsWith("#   a ") || l.startsWith("#   b ") || l.startsWith("#   c "))).toBe(true);
    });
});
