// tests/core/session-overview.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##308 全局会话可见性的**呈现判据**（纯函数）
//
// 为什么必须钉住：三处消费者（总览页 / nav 标签 / 任务表行）共用这一份判据 ——
// 它错了就是「同一个会话在 nav 说在跑、在任务表说空闲」这类分叉，而不是某处样式不好看。
// 契约（见 src/shared/session-overview.ts 头注）：
//   · 主状态轴只有一条：turn != null → working，否则 idle；queue / viewers / steps 全是属性；
//   · **三种「排队」必须可区分**（对话中 / 已打开未通讯 / 已关闭待投递）；
//   · 停滞（无进展）与异常退出都要在「不点进去」时可见。
// 纯逻辑，无 DOM / 无 Electron / 无注册表实例。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
    fmtDuration,
    fmtTokens,
    sessionRowOf,
    stepsNow,
    stepsProgressOf,
} from "../../src/shared/session-overview";
import { abnormalEndOf, activityOf, newTurnsOf, queueViewOf, stalledOf, STALL_MS } from "../../src/shared/session-state";
import type { SessionEntry } from "../../src/shared/registry-frame";

const T0 = "2026-10-15T10:00:00.000Z";
const NOW = Date.parse(T0) + 5_000; // 起跑 5s 后

function entry(patch: Partial<SessionEntry> = {}): SessionEntry {
    return {
        id: "local-projects_4_tasks_308",
        refs: [{ kind: "task", uri: "projects/4/tasks/308" }],
        turn: null,
        queue: 0,
        viewers: 0,
        firstSeenAt: T0,
        lastActivity: T0,
        turnCount: 0,
        lastEndReason: null,
        totalSteps: 0,
        totalTokens: 0,
        ...patch,
    };
}

/** 在跑的轮次（steps / 心跳可控） */
function running(patch: Partial<SessionEntry> = {}, turnPatch: Record<string, unknown> = {}): SessionEntry {
    return entry({
        turn: {
            turnId: "t1",
            steps: 3,
            tokens: 1200,
            lastOpAt: T0,
            startedAt: T0,
            model: "mimo-v2.6-flash",
            cwd: "/tmp/x",
            state: "active",
            ...turnPatch,
        } as SessionEntry["turn"],
        ...patch,
    });
}

describe("主状态轴：working / idle", () => {
    it("turn != null → working；否则 idle（不引入第三个状态）", () => {
        expect(activityOf(running())).toBe("working");
        expect(activityOf(entry())).toBe("idle");
    });

    it("步数 = 本进程累计 + 在跑轮次的当前步（「距上次看新增」的口径基础）", () => {
        expect(stepsNow(entry({ totalSteps: 40 }))).toBe(40);
        expect(stepsNow(running({ totalSteps: 40 }))).toBe(43);
    });

    it("步数进度：有上限给 k/max，没上限只给已跑（不编一个 200 出来）", () => {
        expect(stepsProgressOf(running({ totalSteps: 7 }), 200)).toMatchObject({ done: 10, limit: 200, text: "10/200" });
        expect(stepsProgressOf(running(), null)).toMatchObject({ done: 3, limit: null, pct: null, text: "3 步" });
        // 超出上限（上限被调小过 / 竞态）不许画成 >100%
        expect(stepsProgressOf(running({ totalSteps: 400 }), 200).pct).toBe(1);
    });

    it("停滞：在跑但心跳超过阈值才算（空闲不算停滞；刚好到阈值也算）", () => {
        expect(stalledOf(running(), NOW)).toBe(false);
        expect(stalledOf(running(), NOW + STALL_MS)).toBe(true);
        expect(stalledOf(entry({ lastEndReason: { type: "completed", data: {} } }), NOW + STALL_MS * 99)).toBe(false);
    });

    it("距上次看新增：**单位是轮次**（1 轮 = 1 条未读消息），水位缺失（没看过）算 0", () => {
        expect(newTurnsOf(running({ turnCount: 4 }), null)).toBe(0);
        expect(newTurnsOf(running({ turnCount: 4 }), 1)).toBe(3);
        expect(newTurnsOf(entry({ turnCount: 0 }), 9)).toBe(0); // 水位比现在靠前 → 不出现负数
    });
});

describe("三种「排队」的区分（用户明确要的可见性）", () => {
    it("对话中 + queue>0（##306）", () => {
        const q = queueViewOf(running({ queue: 2, viewers: 1 }));
        expect(q.kind).toBe("chatting");
        expect(q.label).toContain("2");
        expect(q.tip).toContain("本轮收尾后");
    });

    it("已打开·未通讯 + queue>0（页面开着，但没在跑）", () => {
        const q = queueViewOf(entry({ queue: 1, viewers: 1, turnCount: 2 }));
        expect(q.kind).toBe("opened-idle");
        expect(q.label).toContain("已打开");
    });

    it("已关闭·idle + queue>0（##303 的洞：没人看它，留言躺着）", () => {
        const q = queueViewOf(entry({ queue: 3, viewers: 0 }));
        expect(q.kind).toBe("closed-idle");
        expect(q.label).toContain("已关闭");
        expect(q.tip).toContain("下次有人开口");
    });

    it("queue=0 → 三档都不成立（不给出「排队 0」这种假信号）", () => {
        expect(queueViewOf(running()).kind).toBe("none");
        expect(queueViewOf(entry({ viewers: 1 })).kind).toBe("none");
    });

    it("判据只看 turn × viewers，不看「哪个页面开着」（同一会话在任何页面同一档）", () => {
        // 在跑且无人看 / 在跑且有人看 → 都是 chatting（「打开」与否不改变「什么时候投」）
        expect(queueViewOf(running({ queue: 1, viewers: 0 })).kind).toBe("chatting");
        expect(queueViewOf(running({ queue: 1, viewers: 9 })).kind).toBe("chatting");
    });
});

describe("异常退出 / chip", () => {
    it("非 completed 的收尾才算「异常退出」（completed 不报警）", () => {
        expect(abnormalEndOf(entry({ turnCount: 1, lastEndReason: { type: "completed", data: {} } }))).toBe(false);
        expect(
            abnormalEndOf(entry({ turnCount: 1, lastEndReason: { type: "error", data: { source: "llm", message: "x" } } })),
        ).toBe(true);
        // ##393（##266 2026-10-20 拍板）：`aborted:user` / 旧版 `abort` 都是**你自己按的停止** ⇒ 预期内，
        // 不算「异常退出」；真正分不清的那种是 `aborted:detached`（断流）
        expect(abnormalEndOf(entry({ turnCount: 1, lastEndReason: { type: "aborted", data: { source: "user" } } }))).toBe(
            false,
        );
        expect(abnormalEndOf(entry({ turnCount: 1, lastEndReason: { type: "aborted", data: { source: "abort" } } }))).toBe(
            false,
        );
        expect(
            abnormalEndOf(entry({ turnCount: 1, lastEndReason: { type: "aborted", data: { source: "detached" } } })),
        ).toBe(true);
        // 还在跑 → 不看上一轮（那是完成时才有意义的历史）
        expect(
            abnormalEndOf(running({ lastEndReason: { type: "error", data: { source: "llm", message: "x" } } })),
        ).toBe(false);
    });

    it("在跑 → live 图标 + 状态词带 k/max（未读是**属性**，不拼进同一句话）", () => {
        const row = sessionRowOf(running({ queue: 1, viewers: 0, totalSteps: 7, turnCount: 5 }), 2, 200, NOW);
        expect(row.glyph.shape).toBe("live");
        expect(row.glyph.tone).toBe("green");
        expect(row.state).toContain("10/200");
        expect(row.unread).toBe(3); // ##358：1 轮 = 1 条，不是步数
        expect(row.glyph.tip).toContain("projects/4/tasks/308");
    });

    it("停滞 → 同一个 live 图标，但动画放慢（运行健康度，不是第四种状态）", () => {
        const row = sessionRowOf(running(), 0, 200, NOW + STALL_MS);
        expect(row.glyph.shape).toBe("live");
        expect(row.glyph.motion).toBe("slow");
        expect(row.state).toContain("停滞");
    });

    it("空闲且无事 → 已结束的终态圆（图标是状态，不是噪音：仍然渲染）", () => {
        const row = sessionRowOf(entry({ turnCount: 3, lastEndReason: { type: "completed", data: {} } }), 100, 200, NOW);
        expect(row.attention).toBe(4);
        expect(row.glyph.shape).toBe("ended");
        expect(row.state).toBe("已对话");
    });

    it("空闲但有未读新增 → 未读计数与「已结束」图标同时成立（两条正交轴）", () => {
        const row = sessionRowOf(
            entry({ totalSteps: 20, turnCount: 4, lastEndReason: { type: "completed", data: {} } }),
            1,
            200,
            NOW,
        );
        expect(row.unread).toBe(3);
        expect(row.glyph.shape).toBe("ended");
        expect(row.glyph.tone).toBe("ok");
    });

    it("空闲 + 异常收尾 → 文案与图标与轮尾同源（endMarkOf / abortText）", () => {
        const userStop = sessionRowOf(
            entry({ turnCount: 1, lastEndReason: { type: "aborted", data: { source: "user" } } }),
            0,
            200,
            NOW,
        );
        expect(userStop.glyph.label).toBe("已结束 · 你停止");
        const err = sessionRowOf(
            entry({ turnCount: 1, lastEndReason: { type: "error", data: { source: "llm", message: "boom" } } }),
            0,
            200,
            NOW,
        );
        expect(err.glyph.tone).toBe("orange");
    });

    it("待投递留言的空闲会话 → 状态词说「什么时候投」（不是只说个数）", () => {
        const row = sessionRowOf(entry({ queue: 2, viewers: 0 }), 0, 200, NOW);
        expect(row.state).toContain("已关闭");
    });
});

describe("格式化", () => {
    it("时长", () => {
        expect(fmtDuration(9_400)).toBe("9s");
        expect(fmtDuration(65_000)).toBe("1m05s");
        expect(fmtDuration(3_720_000)).toBe("1h02m");
    });
    it("token", () => {
        expect(fmtTokens(0)).toBe("0");
        expect(fmtTokens(999)).toBe("999");
        expect(fmtTokens(12_340)).toBe("12.3k");
    });
});
