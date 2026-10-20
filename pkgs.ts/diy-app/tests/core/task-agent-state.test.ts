// tests/core/task-agent-state.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 窗口占用的**呈现判据**（纯函数）。
//
// ##393 之后本文件只剩这一件事：原来的「任务四态单轴」（in-turn > unread > draft > clean）
// 把属性当状态，已整体迁到 `shared/session-state.ts`（判据测试见 `session-state.test.ts`）。
// 状态与窗口占用**本来就是两条轴**，拆开后各自单测，反而更好钉。
// 纯逻辑，无 DOM / 无 Electron / 无注册表实例。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { windowUsageOf, WINDOW_WARN_RATIO } from "../../src/shared/task-agent-state";
import { DEFAULT_WINDOW_OVER_TOKENS } from "../../src/shared/context/auto-compact";
import { fmtTokens } from "../../src/shared/usage";

describe("窗口占用（##339 阈值口径）", () => {
    it("实测 token + 阈值 → 文本与比例都对（阈值取 38400 token）", () => {
        const v = windowUsageOf(12_000, DEFAULT_WINDOW_OVER_TOKENS, fmtTokens)!;
        expect(v.tokens).toBe(12_000);
        expect(v.limit).toBe(38_400);
        expect(v.pct).toBeCloseTo(12_000 / 38_400, 10);
        expect(v.text).toBe("12.0k / 38.4k（31%）");
        expect(v.tone).toBe("ok");
    });

    it("≥80% 转 warn、≥100% 转 over（撞阈值就是「该压了」）", () => {
        expect(windowUsageOf(Math.floor(DEFAULT_WINDOW_OVER_TOKENS * WINDOW_WARN_RATIO), DEFAULT_WINDOW_OVER_TOKENS)!.tone).toBe("warn");
        expect(windowUsageOf(DEFAULT_WINDOW_OVER_TOKENS - 1, DEFAULT_WINDOW_OVER_TOKENS)!.tone).toBe("warn");
        expect(windowUsageOf(DEFAULT_WINDOW_OVER_TOKENS, DEFAULT_WINDOW_OVER_TOKENS)!.tone).toBe("over");
    });

    it("没有实测 / 阈值关闭 → null（不编 0%：老会话没用量账，0% 会被读成「窗口是空的」）", () => {
        expect(windowUsageOf(null, DEFAULT_WINDOW_OVER_TOKENS)).toBeNull();
        expect(windowUsageOf(undefined, DEFAULT_WINDOW_OVER_TOKENS)).toBeNull();
        expect(windowUsageOf(Number.NaN, DEFAULT_WINDOW_OVER_TOKENS)).toBeNull();
        expect(windowUsageOf(1000, 0)).toBeNull(); // 0 = 关闭该触发
        expect(windowUsageOf(1000, null)).toBeNull();
        // 实测为 0 是**真值**（空会话也跑过一步），照画
        expect(windowUsageOf(0, DEFAULT_WINDOW_OVER_TOKENS)!.pct).toBe(0);
    });
});
