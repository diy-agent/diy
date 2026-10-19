// tests/core/session-todo.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##358 D5：「待你处理」区的判据（谁该找你 / 为什么 / 谁排前面）
//
// 为什么必须钉住：这一区的唯一价值是「**不点进去就知道**」—— 于是**原因短语**与**行序**就是契约。
// 用户口径：未读 = 未读**消息**条数（1 轮 = 1 条，不是步数）；「值不值得看」的顺序 =
//   异常终止 > 无进展 > 有人在等 > 跑完没看。
// 另外两条容易写错的边界，用例专门钉：
//   · **开着 tab 的会话不进本区**（已在眼前 = 再列一遍是噪声）；
//   · **账本独有行**（重启后注册表为空）照样进本区 —— 否则用户"丢了所有进度"的痛点没被回答。
// 纯逻辑，无 DOM / 无 Electron。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { navRowOf, type NavRow } from "../../src/shared/session-nav";
import { todoKindOf, todoOf, todoTitleOf, todoWhenOf } from "../../src/shared/session-todo";
import { STALL_MS } from "../../src/shared/session-overview";
import type { SessionEntry } from "../../src/shared/registry-frame";

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

function row(patch: Partial<NavRow> & { uri: string }): NavRow {
    return {
        label: patch.uri,
        running: false,
        stalled: false,
        abnormal: false,
        unread: 0,
        queue: 0,
        opened: false,
        lastTs: null,
        ...patch,
    };
}

describe("todoKindOf：一个会话该不该找你（四类，有先后）", () => {
    it("跑完没看 → finished；条数 = 未读数", () => {
        expect(todoKindOf(row({ uri: "u", unread: 3 }))).toBe("finished");
    });

    it("异常终止 + 未读 → failed（不是 finished：红的比绿的更该看）", () => {
        expect(todoKindOf(row({ uri: "u", abnormal: true, unread: 1 }))).toBe("failed");
    });

    it("异常终止但**已读过** → 不找你（账已经结清，别拿旧伤吓人）", () => {
        expect(todoKindOf(row({ uri: "u", abnormal: true, unread: 0 }))).toBe(null);
    });

    it("卡住 → stalled；且优先于队列与未读", () => {
        expect(todoKindOf(row({ uri: "u", stalled: true, running: true, queue: 2, unread: 5 }))).toBe("stalled");
    });

    it("有人在等 → waiting（在跑也算：你得回话）", () => {
        expect(todoKindOf(row({ uri: "u", running: true, queue: 1 }))).toBe("waiting");
    });

    it("**只是**在跑、没人等 → 不找你（那是「后台活动」的事）", () => {
        expect(todoKindOf(row({ uri: "u", running: true }))).toBe(null);
    });

    it("在跑**且有未读**（账本已把在跑的这轮记了几行）→ 仍不报「跑完」", () => {
        // 实测踩到的自相矛盾：同一行角标写"运行中"（rowBadgeOf 先看 running）、原因写"跑完了"。
        expect(todoKindOf(row({ uri: "u", running: true, unread: 1 }))).toBe(null);
        expect(todoOf([row({ uri: "u", running: true, unread: 2 })])).toEqual([]);
        // 但"在跑 + 有人等"仍要找他（回话是当下的事）
        expect(todoKindOf(row({ uri: "u", running: true, unread: 1, queue: 1 }))).toBe("waiting");
    });
});

describe("todoOf：行集与行序", () => {
    it("开着 tab 的会话不进本区（已在眼前，再列一遍是噪声）", () => {
        const rows = [
            row({ uri: "a", unread: 9, opened: true }),
            row({ uri: "b", unread: 1 }),
        ];
        expect(todoOf(rows).map((i) => i.row.uri)).toEqual(["b"]);
    });

    it("按「值不值得看」排序：异常终止 > 无进展 > 有人在等 > 跑完没看", () => {
        const rows = [
            row({ uri: "fin", unread: 1 }),
            row({ uri: "wait", queue: 1 }),
            row({ uri: "stall", stalled: true, running: true }),
            row({ uri: "fail", abnormal: true, unread: 1 }),
        ];
        expect(todoOf(rows).map((i) => i.row.uri)).toEqual(["fail", "stall", "wait", "fin"]);
    });

    it("同类之间：条数多的在前，再同则按 uri（顺序稳定，不随刷新抖动）", () => {
        const rows = [
            row({ uri: "b", unread: 2 }),
            row({ uri: "a", unread: 2 }),
            row({ uri: "c", unread: 7 }),
        ];
        expect(todoOf(rows).map((i) => i.row.uri)).toEqual(["c", "a", "b"]);
    });

    it("「不点进去就知道」：原因短语说清是哪一类 + 几条（不是只给个红点）", () => {
        const [failed] = todoOf([row({ uri: "u", label: "#7 活动可见性", abnormal: true, unread: 2 })]);
        expect(failed.why).toBe("异常终止 · 2 条未读");
        expect(failed.count).toBe(2);

        const [waiting] = todoOf([row({ uri: "u", queue: 3 })]);
        expect(waiting.why).toBe("有 3 条留言等你回复");
        // 卡住没有条数（不是 0 条未读，是"没法用条数说清"）——
        // 文案里不许出现数字，否则读起来像"0 条未读"
        const [stalled] = todoOf([row({ uri: "u", stalled: true, running: true, unread: 4 })]);
        expect(stalled.why).toBe("无进展 · 在跑但长时间没动静");
        expect(stalled.count).toBe(0);
    });

    it("标题计数文案：空区给空串（调用方据此不渲染），非空给「N 件事等你」", () => {
        expect(todoTitleOf([])).toBe("");
        expect(todoTitleOf(todoOf([row({ uri: "u", unread: 1 })]))).toBe("1 件事等你");
    });
});

describe("账本独有行（重启后注册表为空）：本区是『丢了所有进度』的正面回答", () => {
    it("没有注册表条目，但账本说聊过 5 轮、水位 3 → 未读 2，进本区", () => {
        const r = navRowOf({
            uri: "projects/4/tasks/5",
            label: "#5 真跑过",
            opened: false,
            entry: null, // ← 重启后就是这个样子
            seenTurns: 3,
            totalTurns: 5,
            lastTs: "2026-10-17T07:03:00.000Z",
            maxSteps: 200,
            now: NOW,
        });
        expect(r.running).toBe(false);
        expect(r.abnormal).toBe(false);
        expect(r.unread).toBe(2);
        expect(todoOf([r])[0].why).toBe("跑完了 · 2 条未读");
        // 时间按本地时区渲染 ⇒ 只钉形状（别把测试绑死在某个 TZ 上）
        expect(todoWhenOf(todoOf([r])[0])).toMatch(/^\d{2}-\d{2} \d{2}:03$/);
    });

    it("没有水位记录 → 未读 0（不知道就不虚报）⇒ 不进本区", () => {
        const r = navRowOf({
            uri: "u",
            label: "u",
            opened: false,
            entry: null,
            seenTurns: null,
            totalTurns: 5,
            maxSteps: 200,
            now: NOW,
        });
        expect(r.unread).toBe(0);
        expect(todoOf([r])).toEqual([]);
    });

    it("账本还没读到（totalTurns = undefined）→ 未读 0，不瞎猜", () => {
        const r = navRowOf({
            uri: "u",
            label: "u",
            opened: false,
            entry: null,
            seenTurns: 3,
            totalTurns: undefined,
            maxSteps: 200,
            now: NOW,
        });
        expect(r.unread).toBe(0);
    });

    it("注册表在跑 + 水位落后 → 未读照算（注册表/账本两把尺子取大，见 sessionStore.turnsOf）", () => {
        const r = navRowOf({
            uri: "u",
            label: "u",
            opened: false,
            entry: entry({ turnCount: 4, lastEndReason: { type: "completed", data: {} } }),
            seenTurns: 1,
            totalTurns: 4,
            maxSteps: 200,
            now: NOW,
        });
        expect(r.unread).toBe(3);
    });

    it("卡住的判定仍要注册表（账本只知道『聊过』，不知道『现在还动着』）", () => {
        const r = navRowOf({
            uri: "u",
            label: "u",
            opened: false,
            entry: entry({
                turn: {
                    turnId: "t1",
                    steps: 3,
                    tokens: 10,
                    lastOpAt: new Date(NOW - STALL_MS - 1_000).toISOString(),
                    startedAt: T0,
                    state: "active",
                },
            }),
            seenTurns: null,
            maxSteps: 200,
            now: NOW,
        });
        expect(r.stalled).toBe(true);
        expect(todoOf([r])[0].kind).toBe("stalled");
    });
});
