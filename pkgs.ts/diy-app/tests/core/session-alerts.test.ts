// tests/core/session-alerts.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##358 D3：三级提示里"什么时候该打断你"（L1 toast / L2 自动拉回）
//
// 为什么必须钉住：判据错了不是样式问题 —— 要么**半夜抢焦点**（L2 自动开 tab），
// 要么**永远不提示**（漏报）。而且很容易写成"拿状态当事件"：
//   ① 一启动把历史未读全弹一遍（用户刚开 app 就被糊脸）；
//   ② 每 tick 重算（停滞依赖"现在几点"）→ 同一条未读**反复弹**。
// 契约（见 src/shared/session-alerts.ts 头注）：
//   · 只对**跃迁**出提示；`prev` 里没有的 uri = 基线，不报；
//   · `opened`（tab 开着）= 已在视线内，不打断；
//   · L2 只有两种：**异常终止** / **有人在等你回复**（队列刚出现留言）；
//   · 一个会话一次至多一条（toast 打两件事等于没说）；
//   · 文案一律「条」（未读=消息条数），**任何地方出现「步」即 bug**。
// 纯逻辑，无 DOM / 无 Electron。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { alertsOf, type SessionAlert } from "../../src/shared/session-alerts";
import type { NavRow } from "../../src/shared/session-nav";

/** 造一行（缺省 = 安静的已读空闲会话；每个用例只改它关心的那几位） */
function row(over: Partial<NavRow> = {}): NavRow {
    return {
        uri: "projects/1/tasks/308",
        label: "#308 会话可见性",
        running: false,
        stalled: false,
        abnormal: false,
        unread: 0,
        queue: 0,
        opened: false,
        lastTs: null,
        ...over,
    };
}

/** 快照（prev 用）：一条记录 */
const snap = (r: NavRow): Record<string, NavRow> => ({ [r.uri]: r });

describe("##358 D3 · alertsOf —— 只报跃迁", () => {
    it("首次快照（prev 空）= 建基线：有未读、在跑也不报（否则一启动就糊脸）", () => {
        const next = [row({ unread: 23 }), row({ uri: "projects/1/tasks/9", label: "#9", running: true })];
        expect(alertsOf({}, next, { autoPull: true })).toEqual([]);
    });

    it("一直在那儿的未读**不是事件**：状态没变 → 不报", () => {
        const r = row({ unread: 3 });
        expect(alertsOf(snap(row({ unread: 3 })), [r], { autoPull: true })).toEqual([]);
    });

    it("跑完（正常收尾 + 有未读）→ L1 toast，文案「跑完了 +N 条未读」（条，不是步）", () => {
        const next = row({ unread: 23 });
        const [a] = alertsOf(snap(row({ running: true })), [next], { autoPull: true });
        expect(a.kind).toBe("finished");
        expect(a.level).toBe("L1");
        expect(a.autoPull).toBe(false); // L1 从不抢焦点
        expect(a.text).toContain("跑完了");
        expect(a.text).toContain("+23 条未读");
    });

    it("跑完但未读数还是 0（账本慢一拍）→ **仍要报**（只是省掉「+N 条未读」）", () => {
        const [a] = alertsOf(snap(row({ running: true })), [row({ unread: 0 })], { autoPull: true });
        expect(a.kind).toBe("finished");
        expect(a.text).toContain("跑完了");
        expect(a.text).not.toContain("条未读");
    });

    it("异常终止（刚出现「未读 + 异常」）→ L2 + 自动拉回", () => {
        const next = row({ abnormal: true, unread: 7 });
        const [a] = alertsOf(snap(row()), [next], { autoPull: true });
        expect(a.kind).toBe("failed");
        expect(a.level).toBe("L2");
        expect(a.autoPull).toBe(true);
        expect(a.text).toContain("异常终止");
        expect(a.text).toContain("已自动拉回视线");
    });

    it("「在跑 → 异常收尾」是主判据：未读数还没跟上也要报（账本慢一拍）", () => {
        const [a] = alertsOf(snap(row({ running: true })), [row({ abnormal: true, unread: 0 })], { autoPull: true });
        expect(a.kind).toBe("failed");
        expect(a.level).toBe("L2");
        expect(a.text).toContain("异常终止");
        expect(a.text).not.toContain("条未读");
    });

    it("看过了又一次异常收尾（abnormal 一直 true，但中间又跑过一轮）→ 仍报", () => {
        const prev = row({ abnormal: true, unread: 0, running: true });
        const next = row({ abnormal: true, unread: 1 });
        expect(alertsOf(snap(prev), [next], { autoPull: true })[0]?.kind).toBe("failed");
    });

    it("「自动拉回」开着 = 抢焦点；关掉 → 仍提示、但不抢（level L2 / autoPull false + 明说已关）", () => {
        const next = row({ abnormal: true, unread: 7 });
        const [a] = alertsOf(snap(row()), [next], { autoPull: false });
        expect(a.level).toBe("L2");
        expect(a.autoPull).toBe(false);
        expect(a.text).toContain("自动拉回已关");
    });

    it("队列里**刚出现**留言 → L2「有人在等你回复」（可能是别的窗口留的，你看不到）", () => {
        const [a] = alertsOf(snap(row({ running: true })), [row({ running: true, queue: 2 })], { autoPull: true });
        expect(a.kind).toBe("waiting");
        expect(a.level).toBe("L2");
        expect(a.text).toContain("有人在等你回复");
    });

    it("队列一直在（1 → 2）→ 不报：留言条数变化不是「新的人来了」", () => {
        const prev = row({ running: true, queue: 1 });
        expect(alertsOf(snap(prev), [row({ running: true, queue: 2 })], { autoPull: true })).toEqual([]);
    });

    it("无进展（刚进停滞）→ L1；持续停滞 → 不反复弹", () => {
        const stalled = row({ running: true, stalled: true });
        expect(alertsOf(snap(row({ running: true })), [stalled], { autoPull: true })[0]?.kind).toBe("stalled");
        expect(alertsOf(snap(stalled), [stalled], { autoPull: true })).toEqual([]);
    });

    it("tab 开着（opened）= 已在视线内 → 一律不打断", () => {
        const next = row({ abnormal: true, unread: 9, opened: true });
        expect(alertsOf(snap(row()), [next], { autoPull: true })).toEqual([]);
    });

    it("一个会话同时「异常终止 + 队列有留言」→ 只出一条（打两件事等于没说）", () => {
        const next = row({ abnormal: true, unread: 4, queue: 1, running: false });
        const out: SessionAlert[] = alertsOf(snap(row()), [next], { autoPull: true });
        expect(out.length).toBe(1);
        expect(out[0].kind).toBe("failed"); // 异常终止 > 有人在等
    });

    it("多条要打断时 L2 排前面；key = uri|kind（同一会话同一事件只弹一次）", () => {
        const a = row({ uri: "projects/1/tasks/1", label: "#1", unread: 2 });
        const b = row({ uri: "projects/1/tasks/2", label: "#2", abnormal: true, unread: 5 });
        const prev = { [a.uri]: row({ uri: a.uri, running: true }), [b.uri]: row({ uri: b.uri }) };
        const out = alertsOf(prev, [a, b], { autoPull: true });
        expect(out.map((x) => x.kind)).toEqual(["failed", "finished"]);
        expect(out[0].key).toBe("projects/1/tasks/2|failed");
    });

    it("源码护栏：文案里不许出现「步」（未读=消息条数，不是步数）", () => {
        const prevBase = row({ uri: "a", running: true, queue: 0 });
        const kinds = [
            row({ uri: "a", unread: 3 }),
            row({ uri: "b", label: "#b", abnormal: true, unread: 3 }),
            row({ uri: "c", label: "#c", running: true, stalled: true }),
            row({ uri: "d", label: "#d", running: true, queue: 1 }),
        ];
        const prevAll = { "a": prevBase, b: row({ uri: "b", label: "#b" }), c: row({ uri: "c", label: "#c", running: true }), d: row({ uri: "d", label: "#d", running: true }) };
        const out = alertsOf(prevAll, kinds, { autoPull: true });
        expect(out.length).toBe(4);
        for (const a of out) expect(a.text).not.toContain("步");
    });
});
