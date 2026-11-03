// tests/core/history-cut-cap.test.ts
// ##432 review B：已落盘边界之上仍要有 ##406 的**装配后硬上限**兜底（按步收窄、不切开 tool 配对）。
import { describe, expect, it } from "vitest";
import { selectHistoryByCut, type LocalModelMessage } from "../../src/main/services/local-blocks";

const user = (turn: string, step: string | undefined, text: string): LocalModelMessage =>
    ({ role: "user", content: [{ type: "text", text }], turn, ...(step ? { step } : {}) });
const asst = (turn: string, step: string, text: string): LocalModelMessage =>
    ({ role: "assistant", content: [{ type: "text", text }], turn, step });

/** 6 步 × 2 条，每条 ~250 字节 ⇒ 总量明显超过 cap */
function history(): LocalModelMessage[] {
    const out: LocalModelMessage[] = [];
    out.push(user("t1", undefined, "开场：" + "x".repeat(200)));
    for (let s = 1; s <= 6; s++) {
        out.push(user(`t${s}`, `t${s}_s1`, `问 ${s}：` + "x".repeat(200)));
        out.push(asst(`t${s}`, `t${s}_s1`, `答 ${s}：` + "x".repeat(200)));
    }
    return out;
}

describe("selectHistoryByCut + hardCapBytes（##432 review B）", () => {
    it("kept 超 cap ⇒ 按步从前往后收窄，最终 ≤ cap", () => {
        const all = history();
        const sel = selectHistoryByCut(all, { cut: 3, headEnd: 1 }, { hardCapBytes: 700 });
        // 收窄以**步**为单位：只剩最后一步时仍可能略超 cap（不许切开一步里的 call/result）
        expect(sel.keptBytes <= 700 || sel.kept.length <= 3).toBe(true);
        expect(sel.dropped.length).toBeGreaterThan(0);
        // 保头仍在
        expect(sel.kept).toContain(0);
    });

    it("收窄不切开 tool 配对（call 与其 result 要么都在、要么都不在）", () => {
        const all: LocalModelMessage[] = [
            user("t1", undefined, "开场"),
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} }], turn: "t1", step: "t1_s1" },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "ok" } }], turn: "t1", step: "t1_s1" },
            asst("t2", "t2_s1", "答 2：" + "x".repeat(600)),
            asst("t3", "t3_s1", "答 3：" + "x".repeat(600)),
        ];
        const sel = selectHistoryByCut(all, { cut: 1, headEnd: 1 }, { hardCapBytes: 300 });
        const hasCall = sel.kept.includes(1);
        const hasResult = sel.kept.includes(2);
        expect(hasCall).toBe(hasResult);
    });

    it("cap 未给 ⇒ 与纯边界切分逐字一致", () => {
        const all = history();
        const a = selectHistoryByCut(all, { cut: 3, headEnd: 1 });
        const b = selectHistoryByCut(all, { cut: 3, headEnd: 1 }, { hardCapBytes: 0 });
        expect(a.kept).toEqual(b.kept);
    });
});
