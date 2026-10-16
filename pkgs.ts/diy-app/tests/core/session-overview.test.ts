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
    abnormalEndOf,
    activityOf,
    fmtDuration,
    fmtTokens,
    newStepsOf,
    queueViewOf,
    sessionChipOf,
    stalledOf,
    stepsNow,
    stepsProgressOf,
    STALL_MS,
} from "../../src/shared/session-overview";
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

    it("距上次看新增：水位缺失（没看过）算 0，不把历史步数算成「你不在时跑的」", () => {
        expect(newStepsOf(running({ totalSteps: 40 }), null)).toBe(0);
        expect(newStepsOf(running({ totalSteps: 40 }), 20)).toBe(23);
        expect(newStepsOf(entry({ totalSteps: 5 }), 99)).toBe(0); // 水位比现在靠前（清过日志）→ 不出现负数
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
        expect(abnormalEndOf(entry({ turnCount: 1, lastEndReason: { type: "aborted", data: { source: "user" } } }))).toBe(
            true,
        );
        // 还在跑 → 不看上一轮（那是完成时才有意义的历史）
        expect(
            abnormalEndOf(running({ lastEndReason: { type: "error", data: { source: "llm", message: "x" } } })),
        ).toBe(false);
    });

    it("在跑 → ● 主色 chip，文案带 k/max 与排队 / 无人看 / 新增", () => {
        const c = sessionChipOf(running({ queue: 1, viewers: 0, totalSteps: 7 }), {
            seenSteps: 2,
            maxSteps: 200,
            now: NOW,
        });
        expect(c).toBeTruthy();
        expect(c!.tone).toBe("primary");
        expect(c!.text).toContain("10/200");
        expect(c!.text).toContain("排队 1");
        expect(c!.text).toContain("无人看");
        expect(c!.text).toContain("新增 8 步");
        expect(c!.tip).toContain("projects/4/tasks/308");
    });

    it("停滞 → 黄色 chip 并把「多久没动」说出来", () => {
        const c = sessionChipOf(running(), { seenSteps: 0, maxSteps: 200, now: NOW + STALL_MS });
        expect(c!.tone).toBe("warning");
        expect(c!.text).toContain("停滞");
    });

    it("空闲且无事 → 不发 chip（任务表几百行，不挂噪音）", () => {
        expect(
            sessionChipOf(entry({ turnCount: 3, lastEndReason: { type: "completed", data: {} } }), {
                seenSteps: 100,
                maxSteps: 200,
                now: NOW,
            }),
        ).toBeNull();
    });

    it("空闲但有未读新增 → ◎（##87「任务 agent 状态未体现」的那一面）", () => {
        const c = sessionChipOf(
            entry({ totalSteps: 20, turnCount: 2, lastEndReason: { type: "completed", data: {} } }),
            { seenSteps: 5, maxSteps: 200, now: NOW },
        );
        expect(c!.text).toContain("15");
    });

    it("空闲 + 异常收尾 → 文案与图标与轮尾同源（endMarkOf / abortText）", () => {
        const userStop = sessionChipOf(
            entry({ turnCount: 1, lastEndReason: { type: "aborted", data: { source: "user" } } }),
            { seenSteps: 0, maxSteps: 200, now: NOW },
        );
        expect(userStop!.text).toBe("生成已取消");
        const err = sessionChipOf(
            entry({ turnCount: 1, lastEndReason: { type: "error", data: { source: "llm", message: "boom" } } }),
            { seenSteps: 0, maxSteps: 200, now: NOW },
        );
        expect(err!.tone).toBe("error");
        expect(err!.icon).toBe("✗");
    });

    it("待投递留言的空闲会话 → chip 说「什么时候投」（不是只说个数）", () => {
        const c = sessionChipOf(entry({ queue: 2, viewers: 0 }), { seenSteps: 0, maxSteps: 200, now: NOW });
        expect(c!.tone).toBe("warning");
        expect(c!.text).toContain("已关闭");
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
