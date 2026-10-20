// tests/core/session-state.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##393 会话状态的**唯一判据**（`shared/session-state`）。
//
// 为什么必须钉住：四处消费者（nav 行 / 任务表行 / 详情+任务树 / 总览表格）都只认这一份，
// 它一错就是"同一个会话在四处四个说法"（用户 3.3 的原话）。用户拍板的模型：
//   · 状态轴只有三值：never / running / ended；
//   · 结束**原因**不是状态，是属性（根因照抄 TurnEndReason，旁边挂归因）；
//   · 未读 / 草稿 / 队列 / 停滞都是**属性**，与状态正交。
// 纯逻辑，无 DOM / 无 Electron / 无注册表实例。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
    blameOf,
    flagsOf,
    glyphOf,
    isAbnormalBlame,
    sessionStateOf,
    stalledOf,
    STALL_MS,
    tierOf,
    type SessionStateInput,
} from "../../src/shared/session-state";
import type { SessionEntry } from "../../src/shared/registry-frame";
import type { TurnEndReason } from "../../src/main/services/local-blocks";

const T0 = "2026-10-15T10:00:00.000Z";
const NOW = Date.parse(T0) + 5_000;

function entry(patch: Partial<SessionEntry> = {}): SessionEntry {
    return {
        id: "local-x",
        refs: [{ kind: "task", uri: "projects/4/tasks/1" }],
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

function input(patch: Partial<SessionStateInput> = {}): SessionStateInput {
    return { entry: entry(), hasSession: true, unread: 0, now: NOW, ...patch };
}

// ─── 状态轴：三值 ─────────────────────────────────────

describe("runState 三值（用户拍板：未运行 / 运行中 / 已结束）", () => {
    it("从未对话 → never（草稿也属于 never：草稿当然属于未开始对话）", () => {
        const s = sessionStateOf(input({ entry: null, hasSession: false, hasDraft: true }));
        expect(s.run).toBe("never");
        expect(s.draft).toBe(true); // 属性照给，但不影响状态
    });

    it("有轮次在跑 → running（哪怕从未被打开过：注册表事实，不依赖 tab）", () => {
        const s = sessionStateOf(input({ entry: entry({ turn: { startedAt: T0 } as never }) }));
        expect(s.run).toBe("running");
    });

    it("聊过且此刻没跑 → ended", () => {
        const s = sessionStateOf(
            input({ entry: entry({ turnCount: 3, lastEndReason: { type: "completed", data: {} } }) }),
        );
        expect(s.run).toBe("ended");
    });

    it("打开过但没说过话（注册表有条目、turnCount=0、无落盘）→ never，不是 ended", () => {
        const s = sessionStateOf(input({ entry: entry({ turnCount: 0 }), hasSession: false }));
        expect(s.run).toBe("never");
    });
});

// ─── 结束原因 → 归因（TurnEndReason 全值域，逐个覆盖） ─────────

describe("blameOf：TurnEndReason 六个值逐一映射（不许漏、不许编）", () => {
    const cases: Array<[string, TurnEndReason, string]> = [
        ["completed", { type: "completed", data: {} }, "none"],
        ["max-steps", { type: "max-steps", data: { steps: 200, limit: 200 } }, "limit"],
        ["max-tokens", { type: "max-tokens", data: { maxOutputTokens: 8000 } }, "limit"],
        ["aborted:user", { type: "aborted", data: { source: "user" } }, "user"],
        // 旧日志里的 "abort" = 旧版停止按钮（shared/turn-end.ts:15-19 头注原话）⇒ 也是「你按的」
        ["aborted:abort（旧版停止）", { type: "aborted", data: { source: "abort" } }, "user"],
        ["aborted:detached（断流）", { type: "aborted", data: { source: "detached" } }, "unknown"],
        ["error:llm（上游）", { type: "error", data: { source: "llm", message: "429" } }, "service"],
        ["error:budget（预算）", { type: "error", data: { source: "budget", message: "quota" } }, "limit"],
        ["error:stream（断流）", { type: "error", data: { source: "stream", message: "reset" } }, "unknown"],
        ["interrupted（崩溃恢复）", { type: "interrupted", data: {} }, "unknown"],
    ];
    for (const [name, end, want] of cases) {
        it(`${name} → ${want}`, () => {
            expect(blameOf(end as TurnEndReason)).toBe(want);
        });
    }

    it("没有记录（遗留数据）→ none（用户：那一批不分析、不管了，按正常显示）", () => {
        expect(blameOf(null)).toBe("none");
        expect(blameOf(undefined)).toBe("none");
        const s = sessionStateOf(input({ entry: entry({ turnCount: 2, lastEndReason: null }) }));
        expect(s.run).toBe("ended");
        expect(s.blame).toBe("none");
        expect(s.end).toBeNull();
    });

    it("只有 expected 之外才值得提醒（none / user 是预期内）", () => {
        expect(isAbnormalBlame("none")).toBe(false);
        expect(isAbnormalBlame("user")).toBe(false);
        expect(isAbnormalBlame("limit")).toBe(true);
        expect(isAbnormalBlame("unknown")).toBe(true);
    });

    it("三档映射与 ##394 对齐：defect / external-recognized / external-unknown / expected", () => {
        expect(tierOf("defect")).toBe("defect");
        expect(tierOf("limit")).toBe("external-recognized");
        expect(tierOf("service")).toBe("external-recognized");
        expect(tierOf("environment")).toBe("external-recognized");
        expect(tierOf("unknown")).toBe("external-unknown");
        expect(tierOf("none")).toBe("expected");
        expect(tierOf("user")).toBe("expected");
    });
});

// ─── 属性与状态正交 ─────────────────────────────────

describe("属性不参与状态判定", () => {
    it("未读再多也不改 run（用户 3.4：未读是个属性）", () => {
        const s = sessionStateOf(
            input({ entry: entry({ turnCount: 3, lastEndReason: { type: "completed", data: {} } }), unread: 7 }),
        );
        expect(s.run).toBe("ended");
        expect(s.unread).toBe(7);
        expect(s.seen).toBe(false);
    });

    it("负数未读（水位比总轮次还大，如刚 clear）→ 0，不出现 -1", () => {
        expect(sessionStateOf(input({ unread: -3 })).unread).toBe(0);
        expect(sessionStateOf(input({ unread: -3 })).seen).toBe(true);
    });

    it("排队是 running 的属性：没在跑就不谈排队（用户：只有正在运行的对话才会出现排队）", () => {
        const idle = sessionStateOf(input({ entry: entry({ queue: 2, turnCount: 1 }) }));
        expect(idle.run).toBe("ended");
        expect(idle.queued).toBe(2); // 字段给（跨重启恢复要用），但状态仍是 ended

        const running = sessionStateOf(input({ entry: entry({ queue: 2, turn: { startedAt: T0 } as never }) }));
        expect(running.run).toBe("running");
        expect(running.queued).toBe(2);
    });

    it("停滞 = running 的健康度（不是第四种状态）", () => {
        const fresh = entry({ turn: { startedAt: T0, lastOpAt: T0 } as never });
        expect(stalledOf(fresh, NOW)).toBe(false);
        expect(stalledOf(fresh, NOW + STALL_MS)).toBe(true);

        const s = sessionStateOf(input({ entry: fresh, now: NOW + STALL_MS }));
        expect(s.run).toBe("running");
        expect(s.stalled).toBe(true);
    });
});

// ─── 图标：形状表阶段、线型表待处理等级（色弱兜底） ────────────

describe("glyphOf：形状 ≠ 只靠颜色", () => {
    it("三阶段三种形状：空心圆 / 实心点 / UML 终态圆", () => {
        expect(glyphOf(sessionStateOf(input({ entry: null, hasSession: false }))).shape).toBe("hollow");
        expect(glyphOf(sessionStateOf(input({ entry: entry({ turn: { startedAt: T0 } as never }) }))).shape).toBe("live");
        expect(
            glyphOf(sessionStateOf(input({ entry: entry({ turnCount: 1, lastEndReason: { type: "completed", data: {} } }) })))
                .shape,
        ).toBe("ended");
    });

    it("线型：unknown 虚线（等你裁定）/ defect 双环（我方缺陷）/ 其余实线", () => {
        const g = (end: TurnEndReason) => glyphOf(sessionStateOf(input({ entry: entry({ turnCount: 1, lastEndReason: end }) })));
        expect(g({ type: "interrupted", data: {} }).line).toBe("dashed");
        expect(g({ type: "completed", data: {} }).line).toBe("solid");
        // defect 今天没有信号源（值域里没有）；这里钉的是"接口留位"而不是"能造出来"
        expect(g({ type: "completed", data: {} }).line).not.toBe("double");
    });

    it("属性轴（SessionFlags）与状态轴正交：未读怎么变，`run` 都不变（用户 3.4 / ##395 接入口）", () => {
        const ended = (unread: number) =>
            sessionStateOf(input({ entry: entry({ turnCount: 3, lastEndReason: { type: "completed", data: {} } }), unread }));
        // 同一个已结束会话：未读 0 / 2 / 9 —— **状态不动**，只有属性动
        for (const n of [0, 2, 9]) {
            const s = ended(n);
            expect(s.run).toBe("ended");
            const f = flagsOf(s);
            expect(f.unreadCount).toBe(n);
            expect(f.unread).toBe(n > 0);
            expect(f.seen).toBe(n === 0);
        }
        // 运行中的会话同样可以"有未读"（属性），但状态仍是 running —— 未读绝不是第四种状态
        const running = sessionStateOf(input({ entry: entry({ turn: { startedAt: T0 } as never, turnCount: 2 }), unread: 1 }));
        expect(running.run).toBe("running");
        expect(flagsOf(running).unread).toBe(true);
        // 属性轴里没有任何"状态"值：类型上就不可能出现 in-turn / unread 这类伪状态
        expect(Object.keys(flagsOf(running)).sort()).toEqual(["draft", "queued", "seen", "stalled", "unread", "unreadCount"]);
    });

    it("未读以属性形式进图标视图（`+N`），但形状仍由状态决定", () => {
        const v = glyphOf(
            sessionStateOf(input({ entry: entry({ turnCount: 3, lastEndReason: { type: "completed", data: {} } }), unread: 2 })),
        );
        expect(v.shape).toBe("ended");
        expect(v.count).toBe("+2");
    });
});
