// tests/core/session-nav.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##358 D1/D2：nav 的**会话活动语汇**（主角标唯一 / 后台活动行集）
//
// 为什么必须钉住：角标是"看一眼就知道该不该点进去"的东西 —— 判据错了不是样式不好看，
// 而是**训练用户忽略它**（假 +N、该红的没红、跑着的看不见）。用户给的口径是**颜色词**：
//   绿 = 未读 · 红 = 未读异常终止 · 闪烁绿 = 运行中 · 黄 = 停滞 · 紫 = 队列
// 契约（见 src/shared/session-nav.ts 头注）：
//   · 同一时刻**只出一个主角标**，优先级 停滞 > 运行中 > 异常未读 > 未读 > 队列；
//   · 关掉 ≠ 消失：没开 tab、但有活态的会话进「后台活动」区；
//   · 判据不新造：位次全部出自 shared/session-overview（未读 1 轮 = 1 条，不是步数）。
// 纯逻辑，无 DOM / 无 Electron。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
    backgroundOf,
    heroBadgeOf,
    navRowOf,
    needsYouOf,
    rowBadgeOf,
    secondaryBadgeOf,
    unreadText,
    type NavRow,
} from "../../src/shared/session-nav";
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

/** 在跑的轮次（心跳可控 —— 停滞判据的输入） */
function running(ageMs = 0, patch: Partial<SessionEntry> = {}): SessionEntry {
    return entry({
        turn: {
            turnId: "t1",
            steps: 3,
            tokens: 10,
            lastOpAt: new Date(NOW - ageMs).toISOString(),
            startedAt: T0,
            state: "active",
        },
        ...patch,
    });
}

/** 跑完的一轮（未读 = totalTurns − 水位） */
function finished(patch: Partial<SessionEntry> = {}): SessionEntry {
    return entry({ turnCount: 5, lastEndReason: { type: "completed", data: {} }, ...patch });
}

/** 直接造 nav 行（不经过 entry → 单测聚合与排序时更直白） */
function row(patch: Partial<NavRow> & { uri: string }): NavRow {
    return { label: patch.uri, running: false, stalled: false, abnormal: false, unread: 0, queue: 0, opened: false, lastTs: null, ...patch };
}

describe("navRowOf：判据全部出自 session-overview（不另写一套）", () => {
    it("在跑的轮次 → running；心跳超阈值 → stalled（同一条 STALL_MS）", () => {
        const fresh = navRowOf({ uri: "u", label: "u", opened: false, entry: running(0), seenTurns: null, maxSteps: 200, now: NOW });
        expect(fresh.running).toBe(true);
        expect(fresh.stalled).toBe(false);

        const stuck = navRowOf({
            uri: "u",
            label: "u",
            opened: false,
            entry: running(STALL_MS + 1_000),
            seenTurns: null,
            maxSteps: 200,
            now: NOW,
        });
        expect(stuck.stalled).toBe(true);
    });

    it("未读 = 跨启动总轮次 − 水位（1 轮 = 1 条，**不是步数**）", () => {
        // totalSteps=99 是干扰项：它绝不能进未读
        const e = finished({ totalSteps: 99 });
        const r = navRowOf({ uri: "u", label: "u", opened: false, entry: e, seenTurns: 3, totalTurns: 5, maxSteps: 200, now: NOW });
        expect(r.unread).toBe(2);
        // 传了 totalTurns 就要压过注册表的本进程计数（重启归零那把错尺子）
        const r2 = navRowOf({ uri: "u", label: "u", opened: false, entry: e, seenTurns: 3, totalTurns: 9, maxSteps: 200, now: NOW });
        expect(r2.unread).toBe(6);
    });

    it("异常收尾 / 待投递留言都照 session-overview 的口径", () => {
        const bad = navRowOf({
            uri: "u",
            label: "u",
            opened: false,
            entry: entry({ lastEndReason: { type: "aborted", data: { source: "detached" } } }),
            seenTurns: 0,
            maxSteps: 200,
            now: NOW,
        });
        expect(bad.abnormal).toBe(true);

        const q = navRowOf({ uri: "u", label: "u", opened: false, entry: entry({ queue: 2 }), seenTurns: 0, maxSteps: 200, now: NOW });
        expect(q.queue).toBe(2);
    });
});

describe("heroBadgeOf：同一时刻只出一个主角标", () => {
    it("无事发生 → null（**不给空闲发角标**：满屏角标等于没有角标）", () => {
        expect(heroBadgeOf([row({ uri: "a" }), row({ uri: "b" })])).toBeNull();
    });

    it("运行中 → 绿 + **闪**（用户原话：闪烁的绿色 = 运行中）", () => {
        const b = heroBadgeOf([row({ uri: "a", running: true })]);
        expect(b).toMatchObject({ key: "running", tone: "green", pulse: true });
        expect(b!.short).toBe("●");
    });

    it("停滞是运行的子集 → 黄 ⚠ **优先于**运行中（更该被看见）", () => {
        const b = heroBadgeOf([row({ uri: "a", running: true }), row({ uri: "b", running: true, stalled: true })]);
        expect(b).toMatchObject({ key: "stalled", tone: "amber", pulse: false });
        expect(b!.tip).toContain("1 个会话在跑但长时间没动静");
    });

    it("运行 > 异常未读 > 未读 > 队列（跨档顺序就是用户写的那个）", () => {
        const rows = [
            row({ uri: "q", queue: 3 }),
            row({ uri: "u", unread: 2 }),
            row({ uri: "e", unread: 4, abnormal: true }),
            row({ uri: "r", running: true }),
        ];
        const noRun = rows.filter((r) => !r.running);
        const noErr = noRun.filter((r) => !r.abnormal);
        const noUnread = noErr.filter((r) => r.unread === 0);
        expect(heroBadgeOf(rows)!.key).toBe("running");
        expect(heroBadgeOf(noRun)!.key).toBe("error");
        expect(heroBadgeOf(noErr)!.key).toBe("unread");
        expect(heroBadgeOf(noUnread)!.key).toBe("queue");
    });

    it("异常未读 → **红** + `+N`（用户原话：红色是未读异常终止）", () => {
        const b = heroBadgeOf([row({ uri: "a", unread: 3, abnormal: true }), row({ uri: "b", unread: 4, abnormal: true })]);
        expect(b).toMatchObject({ key: "error", tone: "red", text: "+7", short: "+7" });
        expect(b!.tip).toContain("异常收尾");
    });

    it("未读 → **绿** `+N`，且同档**聚合**（+23 = 一共 23 条，不是某一个会话的）", () => {
        const b = heroBadgeOf([row({ uri: "a", label: "A", unread: 20 }), row({ uri: "b", label: "B", unread: 3 })]);
        expect(b).toMatchObject({ key: "unread", tone: "green", text: "+23", pulse: false });
        expect(b!.tip).toContain("A、B");
    });

    it("已读的异常收尾**不当主角**（用户口径是「未读**且**异常」）", () => {
        expect(heroBadgeOf([row({ uri: "a", abnormal: true, unread: 0 })])).toBeNull();
    });

    it("队列 → 紫；文案给全称，`short` 给 40px rail（只装得下 1~3 字符）", () => {
        const b = heroBadgeOf([row({ uri: "a", queue: 2 })]);
        expect(b).toMatchObject({ key: "queue", tone: "purple", text: "队列 2", short: "2" });
    });

    it("未读文案：统一 `+n`，超大值截断（rail 撑破就成噪音）", () => {
        expect(unreadText(3)).toBe("+3");
        expect(unreadText(1234)).toBe("+99+");
    });
});

describe("secondaryBadgeOf：主角标之外的第二件事", () => {
    it("有运行中（主角）时，队列降级成次角标（紫，只给数）", () => {
        const rows = [row({ uri: "r", running: true }), row({ uri: "q", queue: 5 }), row({ uri: "q2", queue: 1 })];
        const hero = heroBadgeOf(rows)!;
        const sec = secondaryBadgeOf(rows, hero)!;
        expect(sec).toMatchObject({ key: "queue", tone: "purple", text: "6" });
    });

    it("主角标本身就是队列 → 不重复出次角标", () => {
        const rows = [row({ uri: "q", queue: 2 })];
        expect(secondaryBadgeOf(rows, heroBadgeOf(rows))).toBeNull();
    });

    it("没有队列 → null", () => {
        const rows = [row({ uri: "r", running: true })];
        expect(secondaryBadgeOf(rows, heroBadgeOf(rows))).toBeNull();
    });
});

describe("backgroundOf：关掉 ≠ 消失（D2）", () => {
    it("没开着 tab 且有活态 → 进区；开着 tab 的不进（已在视线内）", () => {
        const rows = [
            row({ uri: "open-run", running: true, opened: true }),
            row({ uri: "bg-run", running: true }),
            row({ uri: "bg-unread", unread: 1 }),
            row({ uri: "quiet", unread: 0 }),
        ];
        expect(backgroundOf(rows).map((r) => r.uri)).toEqual(["bg-run", "bg-unread"]);
    });

    it("行序 = 该不该看（停滞 → 运行 → 异常未读 → 未读 → 队列）", () => {
        const rows = [
            row({ uri: "q", queue: 9 }),
            row({ uri: "u", unread: 1 }),
            row({ uri: "e", unread: 2, abnormal: true }),
            row({ uri: "r", running: true }),
            row({ uri: "s", running: true, stalled: true }),
        ];
        expect(backgroundOf(rows).map((r) => r.uri)).toEqual(["s", "r", "e", "u", "q"]);
    });

    it("同档未读多的在前（一眼先看攒得多的）", () => {
        const rows = [row({ uri: "few", unread: 1 }), row({ uri: "many", unread: 9 })];
        expect(backgroundOf(rows).map((r) => r.uri)).toEqual(["many", "few"]);
    });

    it("「需要你看」= 异常未读 / 停滞 / 留言在等（已读的正常收尾不打扰）", () => {
        const rows = [
            row({ uri: "e", unread: 1, abnormal: true }),
            row({ uri: "s", running: true, stalled: true }),
            row({ uri: "q", queue: 1 }),
            row({ uri: "ok", running: true }),
            row({ uri: "done", unread: 3 }),
        ];
        expect(needsYouOf(rows).map((r) => r.uri)).toEqual(["s", "e", "q"]);
    });
});

describe("rowBadgeOf：单行角标（后台活动区每行）", () => {
    it("与主角标同源：停滞 > 运行 > 异常未读 > 未读 > 队列", () => {
        expect(rowBadgeOf(row({ uri: "a", running: true, stalled: true }))!.key).toBe("stalled");
        expect(rowBadgeOf(row({ uri: "a", running: true }))!.key).toBe("running");
        expect(rowBadgeOf(row({ uri: "a", unread: 2, abnormal: true }))!.key).toBe("error");
        expect(rowBadgeOf(row({ uri: "a", unread: 2 }))!.key).toBe("unread");
        expect(rowBadgeOf(row({ uri: "a", queue: 2 }))!.key).toBe("queue");
        expect(rowBadgeOf(row({ uri: "a" }))).toBeNull();
    });
});
