// tests/core/input-limit.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 发送前门禁（##426 B）：判据只看**本条**消息；三个数（字符 / token+成本 / 窗口占用）都得给。
//
// 为什么它值得单测：这三个数是用户决定「转文件还是照发」的唯一依据。算错一个方向都危险 ——
// 阈值口径错（UTF-16 vs code point）会在 emoji 上误判；成本给成 0 / 窗口给成 0%
// 会把"这条很贵"说成"不要钱"，那比不提示更坏。
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import {
    countChars,
    DEFAULT_INPUT_LIMIT_CHARS,
    inputGate,
    PASTE_HEAD_LINES,
    pasteFileMessage,
} from "../../src/shared/context/input-limit";
import { sanitizeInputLimitChars } from "../../src/shared/context/config";

describe("inputGate：本条消息的判据", () => {
    it("未超限 → over=false（UI 必须零变化）", () => {
        const g = inputGate({ text: "你好".repeat(100), limitChars: DEFAULT_INPUT_LIMIT_CHARS });
        expect(g.over).toBe(false);
        expect(g.chars).toBe(200);
    });

    it("恰好等于阈值仍不算超（判据是 `>`，不是 `>=`）", () => {
        const g = inputGate({ text: "a".repeat(100), limitChars: 100 });
        expect(g.over).toBe(false);
        expect(inputGate({ text: "a".repeat(101), limitChars: 100 }).over).toBe(true);
    });

    it("★ 字符数按 code point：emoji 算 1 个字（UTF-16 .length 会算 2，阈值就不准）", () => {
        const text = "😀😀😀";
        expect(text.length).toBe(6);
        expect(countChars(text)).toBe(3);
        expect(inputGate({ text, limitChars: 2 }).over).toBe(true);
        expect(inputGate({ text, limitChars: 3 }).over).toBe(false);
    });

    it("token 估算 = 字节 / 4（全仓同一口径，不另起一套）", () => {
        // 4 个 ASCII 字节 → 1 token
        expect(inputGate({ text: "abcd", limitChars: 100 }).estTokens).toBe(1);
        expect(inputGate({ text: "abcd", limitChars: 100 }).bytes).toBe(4);
    });

    it("★ 无价目 → costIncrement = null（不是 0：不可测 ≠ 免费）", () => {
        const g = inputGate({ text: "a".repeat(4000), limitChars: 100_000 });
        expect(g.estTokens).toBe(1000);
        expect(g.costIncrement).toBeNull();
        expect(g.windowRatio).toBeNull();
        expect(g.contextLimitTokens).toBeNull();
    });

    it("★ 窗口未知 → windowRatio = null（不编百分比）；有窗口才给率", () => {
        const base = { text: "a".repeat(4000), limitChars: 100_000, windowTokens: 10_000 };
        expect(inputGate(base).windowRatio).toBeNull();
        const g = inputGate({ ...base, contextLimitTokens: 20_000, inputRatePerM: 1 });
        // (10_000 + 1_000) / 20_000
        expect(g.windowRatio).toBeCloseTo(0.55, 6);
        // 成本 = 1_000 token × $1 / 1M
        expect(g.costIncrement).toBeCloseTo(0.001, 9);
    });

    it("没有历史步（windowTokens=null）→ 按 0 起算，不因缺历史就不给率", () => {
        const g = inputGate({ text: "a".repeat(400), limitChars: 100_000, contextLimitTokens: 2000 });
        expect(g.windowRatio).toBeCloseTo(0.05, 6);
    });
});

describe("sanitizeInputLimitChars：读侧兜底", () => {
    it("非法 / 缺失 → 缺省（门禁永远有一个可用阈值）", () => {
        for (const v of [undefined, null, "1000", 0, -5, NaN, Infinity]) {
            expect(sanitizeInputLimitChars(v)).toBe(DEFAULT_INPUT_LIMIT_CHARS);
        }
    });

    it("合法值原样生效（支持小数 → 向下取整）", () => {
        expect(sanitizeInputLimitChars(200_000)).toBe(200_000);
        expect(sanitizeInputLimitChars(12.9)).toBe(12);
        expect(sanitizeInputLimitChars(1)).toBe(1);
    });
});

describe("pasteFileMessage：转文件后的消息体", () => {
    const text = Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 行`).join("\n");

    it("★ 路径 + 前 20 行 + 总行数/字节数（余下行数提示）", () => {
        const msg = pasteFileMessage({ path: "/tmp/x/gen/paste/1.txt", text });
        expect(msg).toContain("/tmp/x/gen/paste/1.txt");
        expect(msg).toContain("总行数：50");
        expect(msg).toContain("第 1 行");
        expect(msg).toContain(`第 ${PASTE_HEAD_LINES} 行`);
        expect(msg).not.toContain(`第 ${PASTE_HEAD_LINES + 1} 行`);
        expect(msg).toContain(`余下 ${50 - PASTE_HEAD_LINES} 行`);
        // 字节数如实给（UTF-8）
        expect(msg).toContain(`字节数：${Buffer.byteLength(text, "utf-8")}`);
    });

    it("行数不足 20 → 不提示『余下』；末尾换行不算多一行", () => {
        const msg = pasteFileMessage({ path: "/tmp/a.txt", text: "a\nb\n" });
        expect(msg).toContain("总行数：2");
        expect(msg).not.toContain("余下");
    });

    it("空内容 → 总行数 0（不炸）", () => {
        const msg = pasteFileMessage({ path: "/tmp/a.txt", text: "" });
        expect(msg).toContain("总行数：0");
    });
});
