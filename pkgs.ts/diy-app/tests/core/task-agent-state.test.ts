// tests/core/task-agent-state.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##355 任务 agent 面状态（四态 + 兜底空闲）与窗口占用的**呈现判据**（纯函数）
//
// 为什么必须钉住：三处消费者（nav 项 / 任务表行 / 任务属性面板）共用这一份判据 ——
// 它错了就是「同一个任务在 nav 说对话中、在任务表说未对话」这类分叉；而且四态是**单轴**
// 的，优先级写错会让"在跑且已读且有草稿"被显示成"有草稿"（用户会去找那条草稿，
// 而真正该看见的是"它正在动"）。
// 纯逻辑，无 DOM / 无 Electron / 无注册表实例。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
    agentStateActive,
    taskAgentStateOf,
    windowUsageOf,
    WINDOW_WARN_RATIO,
    type TaskAgentStateInput,
} from "../../src/shared/task-agent-state";
import { DEFAULT_WINDOW_OVER_TOKENS } from "../../src/shared/context/auto-compact";
import { fmtTokens } from "../../src/shared/usage";

/** 输入基线：干净任务（没对话过、没跑、没未读、没草稿） */
function input(patch: Partial<TaskAgentStateInput> = {}): TaskAgentStateInput {
    return { inTurn: false, unreadTurns: 0, hasDraft: false, hasSession: false, ...patch };
}

describe("##355 四态判据", () => {
    it("干净任务（没对话过）→ clean（且这是「有事」要显示的态）", () => {
        const v = taskAgentStateOf(input());
        expect(v.kind).toBe("clean");
        expect(v.label).toBe("未对话");
        // clean 是**四态之一**，必须渲染（与兜底的 idle 相反）
        expect(agentStateActive(v)).toBe(true);
    });

    it("有轮次在跑 → in-turn", () => {
        const v = taskAgentStateOf(input({ inTurn: true, hasSession: true }));
        expect(v.kind).toBe("in-turn");
        expect(v.label).toBe("对话中");
    });

    it("对话已停止但有未读轮次 → unread（带上未读条数）", () => {
        const v = taskAgentStateOf(input({ hasSession: true, unreadTurns: 3 }));
        expect(v.kind).toBe("unread");
        expect(v.label).toBe("有未读");
        expect(v.tip).toContain("3 条");
    });

    it("有未发送的草稿 → draft", () => {
        const v = taskAgentStateOf(input({ hasSession: true, hasDraft: true }));
        expect(v.kind).toBe("draft");
        expect(v.label).toBe("有草稿");
    });

    it("有历史、已读、无草稿 → idle（兜底态：**不是**四态之一，行内不渲染）", () => {
        const v = taskAgentStateOf(input({ hasSession: true }));
        expect(v.kind).toBe("idle");
        expect(agentStateActive(v)).toBe(false);
    });
});

describe("##355 优先级（单轴，必须互斥）", () => {
    it("在跑压过未读 / 草稿 / 干净", () => {
        expect(taskAgentStateOf(input({ inTurn: true, unreadTurns: 9, hasDraft: true, hasSession: true })).kind).toBe("in-turn");
        // 甚至在"没历史"的输入上也以 in-turn 为准（真值来自注册表，不靠历史推）
        expect(taskAgentStateOf(input({ inTurn: true })).kind).toBe("in-turn");
    });

    it("未读压过草稿与干净（说「你还没看到新产出」比说「你有草稿」更要紧）", () => {
        expect(taskAgentStateOf(input({ unreadTurns: 1, hasDraft: true, hasSession: true })).kind).toBe("unread");
    });

    it("草稿压过干净（有草稿的任务不能报「未对话」）", () => {
        expect(taskAgentStateOf(input({ hasDraft: true })).kind).toBe("draft");
        expect(taskAgentStateOf(input({ hasDraft: true, hasSession: true })).kind).toBe("draft");
    });

    it("负数未读（水位比当前步数大，如刚清空会话）一律不算未读", () => {
        expect(taskAgentStateOf(input({ unreadTurns: -3, hasSession: true })).kind).toBe("idle");
        expect(taskAgentStateOf(input({ unreadTurns: -3 })).kind).toBe("clean");
    });

    it("四态两两互斥：任意输入只落一个 kind", () => {
        const kinds = new Set<string>();
        for (const inTurn of [false, true])
            for (const unreadTurns of [0, 2, -1])
                for (const hasDraft of [false, true])
                    for (const hasSession of [false, true])
                        kinds.add(taskAgentStateOf(input({ inTurn, unreadTurns, hasDraft, hasSession })).kind);
        expect([...kinds].sort()).toEqual(["clean", "draft", "idle", "in-turn", "unread"]);
    });
});

describe("##355 窗口占用（##339 阈值口径）", () => {
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
