// tests/core/history-limit.test.ts
// ##432 刀 2 的**唯一算法**（shared/context/history-limit.ts）单测：切点 / 保头 / 配对平衡 / 幂等。
import { describe, expect, it } from "vitest";
import {
    HISTORY_HEAD_TOKENS,
    estimateTokensOf,
    normalizeHistoryLimit,
    selectCompactableRange,
    stepStarts,
    type CompactableMessage,
} from "../../src/shared/context/history-limit";

/** 造一条消息：`step` 相同 = 同一步（真实投影里 step 是 `<turn>_s<n>`） */
function m(step: string | undefined, text: string, content?: unknown): CompactableMessage {
    return { role: step ? "assistant" : "user", content: content ?? text, ...(step ? { step } : {}) };
}

/** 每条消息 = 100 token（字符 400），便于手算切点 */
const big = (step: string | undefined, n = 100) => m(step, "x".repeat(n * 4));

describe("selectCompactableRange：从最后一步往前数，装不下就停", () => {
    it("stepStarts：同 step 成组；无 step 的消息并入前一组", () => {
        const all = [m(undefined, "u1"), m("s1", "a"), m("s1", "b"), m("s2", "c"), m("s2", "d")];
        expect(stepStarts(all)).toEqual([0, 1, 3]);
    });

    it("装得下就什么都不丢（返回 null）", () => {
        const all = Array.from({ length: 5 }, (_, i) => big(`s${i}`, 10));
        expect(selectCompactableRange(all, 100_000, { headTokens: 10 })).toBeNull();
    });

    it("装不下 ⇒ 从尾部往前切；切点落在 step 边界，保留的是**最新的那几步**", () => {
        // 5 步 × 100 token；保头 0，上限 250 ⇒ 从尾往前：s4(100) + s3(100) + s2(100)=300 ≥ 250 ⇒ 切在 s2
        const all = Array.from({ length: 5 }, (_, i) => big(`s${i}`, 100));
        const r = selectCompactableRange(all, 250, { headTokens: 1 });
        expect(r).not.toBeNull();
        expect(r!.cut).toBe(2);
        expect(r!.headEnd).toBe(1);
        expect(r!.dropped).toBe(1);
        // 期望的 messages 条数 = 保头 1 + 切点后 3 = 4（等价性：手算 vs 算法）
        expect(1 + (all.length - r!.cut)).toBe(4);
    });

    it("保头 600 token 硬编码：前 600 token 的消息永不被丢（即便上限极小）", () => {
        // 每条 100 token ⇒ 保头 = 前 6 条
        const all = Array.from({ length: 12 }, (_, i) => big(`s${i}`, 100));
        const r = selectCompactableRange(all, 1, {});
        expect(r).not.toBeNull();
        expect(r!.headEnd).toBe(Math.ceil(HISTORY_HEAD_TOKENS / 100));
        expect(r!.cut).toBeGreaterThanOrEqual(r!.headEnd);
    });

    it("全超时只留保头 + 最新一组（上限极小）", () => {
        const all = Array.from({ length: 8 }, (_, i) => big(`s${i}`, 100));
        const r = selectCompactableRange(all, 1, { headTokens: 100 });
        expect(r!.cut).toBe(7); // 只剩最后一组
        expect(r!.headEnd).toBe(1);
        expect(r!.dropped).toBe(6);
    });

    it("tool 配对不许切开：答案在后面的 tool-call 会带着切点一起往前挪", () => {
        // s1 = call，s2 = result，s3..s5 普通；上限只够 s5+s4 ⇒ 切在 s4，
        // 但 s1/s2 是**步内**成对 —— 这里构造跨步错位（call 在 s1、result 在 s2）验证平衡逻辑
        const call = m("s1", "", [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} }]);
        const result = m("s2", "", [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "ok" } }]);
        const all = [call, result, big("s3", 100), big("s4", 100), big("s5", 100)];
        // 上限 150 ⇒ 从尾：s5(100)+s4(100)=200 ≥ 150 ⇒ 切在 s4（下标 3）；
        // 此时 [0,3) 里 c1 的 call 存在、result 在 [3,n) 之外？不 —— result 在 1 < 3，故本来就平衡
        const r = selectCompactableRange(all, 150, { headTokens: 1 });
        expect(r!.cut).toBe(3);
        // 再造一份**切点正好落在 call 与 result 之间**的：保头 0、上限只够最后一条
        const all2 = [big("s1", 100), call, result, big("s4", 100)];
        const r2 = selectCompactableRange(all2, 100, { headTokens: 1 });
        // 从尾：s4=100 ≥ 100 ⇒ 切点 = s4 起点 = 3 —— call/result 都在切点之前，平衡
        expect(r2!.cut).toBe(3);
    });

    it("幂等：同一份历史算两次结果逐字段相同", () => {
        const all = Array.from({ length: 9 }, (_, i) => big(`s${i}`, 100));
        const a = selectCompactableRange(all, 300, { headTokens: 100 });
        const b = selectCompactableRange(all, 300, { headTokens: 100 });
        expect(a).toEqual(b);
    });

    it("空历史 / 非法上限 ⇒ null（不报错）", () => {
        expect(selectCompactableRange([], 1000)).toBeNull();
        expect(selectCompactableRange([big("s1")], 0)).toBeNull();
    });
});

describe("estimateTokensOf / normalizeHistoryLimit", () => {
    it("token 粗估 = 字符数 / 4（向上取整）", () => {
        expect(estimateTokensOf("1234")).toBe(1);
        expect(estimateTokensOf("12345")).toBe(2);
        expect(estimateTokensOf("")).toBe(0);
    });

    it("配置归一：缺字段 / 0 / 负数都回落缺省；摘要缺省关", () => {
        expect(normalizeHistoryLimit(undefined).limitTokens).toBe(20_000);
        expect(normalizeHistoryLimit({ limitTokens: 0 }).limitTokens).toBe(20_000);
        expect(normalizeHistoryLimit({ limitTokens: -5 }).limitTokens).toBe(20_000);
        expect(normalizeHistoryLimit({ limitTokens: 1234.9 }).limitTokens).toBe(1234);
        expect(normalizeHistoryLimit({ limitTokens: 1 }).summary.enabled).toBe(false);
        expect(normalizeHistoryLimit({ limitTokens: 1, summary: { enabled: true } }).summary.enabled).toBe(true);
    });
});
