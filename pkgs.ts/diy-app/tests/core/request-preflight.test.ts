// ##406 刀 2：发请求**前**的 token 预检（纯函数判据）。
//
// 判据：整个请求（system + tools + messages）折算 token，超过模型窗口 80% ⇒ 越线。
// 越线时用 `tighterHistoryCapBytes` 算出「历史最多还能占多少」重装一次；压不动才拒发。
import { describe, expect, it } from "vitest";
import { estimateRequest, tighterHistoryCapBytes, PREFLIGHT_RATIO } from "../../src/shared/context/request-preflight";

describe("estimateRequest：窗口占用判定", () => {
    it("窗口未知 ⇒ 不判定（没有判据就不报警）", () => {
        const e = estimateRequest({ systemBytes: 400_000, toolsBytes: 0, messagesBytes: 400_000, contextLimitTokens: null });
        expect(e.contextLimitTokens).toBeNull();
        expect(e.ratio).toBeNull();
        expect(e.over).toBe(false);
        expect(e.estTokens).toBe(200_000); // (800 KB / 4)
    });

    it("恰好在线上（= 80%）不算越线，多 1 token 才算（严格大于）", () => {
        const win = 1_000_000; // 窗口 100 万 token ⇒ 字节口径 4 MB；阈值 80 万 token = 3.2 MB
        const atLine = estimateRequest({
            systemBytes: Math.floor(win * 4 * PREFLIGHT_RATIO),
            toolsBytes: 0,
            messagesBytes: 0,
            contextLimitTokens: win,
        });
        expect(atLine.estTokens).toBe(Math.floor(win * PREFLIGHT_RATIO));
        expect(atLine.over).toBe(false);
        const over = estimateRequest({
            systemBytes: Math.floor(win * 4 * PREFLIGHT_RATIO) + 4,
            toolsBytes: 0,
            messagesBytes: 0,
            contextLimitTokens: win,
        });
        expect(over.over).toBe(true);
        expect(over.ratio).toBeGreaterThan(PREFLIGHT_RATIO);
    });

    it("##401 实况（4.95 MB / 窗口 1048576）⇒ 越线（这就是该被拦下的那个请求）", () => {
        const e = estimateRequest({
            systemBytes: 0,
            toolsBytes: 0,
            messagesBytes: 4_946_910,
            contextLimitTokens: 1_048_576,
        });
        expect(e.estTokens).toBeGreaterThan(1_048_576); // 连窗口本身都超了
        expect(e.over).toBe(true);
    });
});

describe("tighterHistoryCapBytes：压到预检线以内，历史还能占多少", () => {
    it("整份请求预算 − system − tools − 预留（缺省 8 KB）", () => {
        const win = 1_000_000;
        const cap = tighterHistoryCapBytes({ contextLimitTokens: win, systemBytes: 10_000, toolsBytes: 5_000 });
        expect(cap).toBe(Math.floor(win * 4 * PREFLIGHT_RATIO) - 10_000 - 5_000 - 8 * 1024);
    });

    it("system + tools 已顶满 ⇒ 0（历史压到零也救不回来，调用方据此拒发）", () => {
        const win = 100_000;
        const cap = tighterHistoryCapBytes({ contextLimitTokens: win, systemBytes: win * 4, toolsBytes: 0 });
        expect(cap).toBe(0);
    });

    it("预留可覆盖（测试 / 特殊口径）", () => {
        const cap = tighterHistoryCapBytes({ contextLimitTokens: 100_000, systemBytes: 0, toolsBytes: 0, reserveBytes: 0 });
        expect(cap).toBe(100_000 * 4 * PREFLIGHT_RATIO);
    });
});
