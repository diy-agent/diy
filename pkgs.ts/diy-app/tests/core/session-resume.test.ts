// tests/core/session-resume.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##358 D4：「继续工作」区的判据（谁在"最近干过"里、按什么排、到哪截）
//
// 为什么必须钉住：这一区回答的是用户的第一句原话 ——「app 启动后丢了所有进度……
//   我要接着工作、知道最近我在干啥」。于是三条是契约：
//   · 尺子是**最后活动时间**（账本 `lastTs`，跨启动），不是任务 `updated`（改标题也会动）；
//   · `lastTs` 为空 = 没聊过 ⇒ **不进本区**（不编时间，别拿"从未开始"冒充"最近在干"）；
//   · 已被「待你处理」/「后台活动」收走的会话**不重复出现**（同一会话在 nav 只有一处）；
//   · 截断要**说出来**（`more`）—— 静默吞掉"更早的会话"等于又丢了一次进度。
// 纯逻辑，无 DOM / 无 Electron。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import type { NavRow } from "../../src/shared/session-nav";
import { sessionStateOf } from "../../src/shared/session-state";
import { RESUME_LIMIT, resumeMoreTextOf, resumeOf, resumeWhenOf } from "../../src/shared/session-resume";

function row(patch: Partial<NavRow> & { uri: string }): NavRow {
    return {
        label: patch.uri,
        state: sessionStateOf({ entry: null, hasSession: false, unread: 0, now: 0 }),
        running: false,
        stalled: false,
        abnormal: false,
        unread: 0,
        queue: 0,
        queueHuman: 0,
        opened: false,
        lastTs: null,
        ...patch,
    };
}

describe("resumeOf：最近活动过、眼下没事的会话（按最后活动时间倒序）", () => {
    it("按 lastTs 倒序（最近的在前）——ISO 串字典序即时间序", () => {
        const v = resumeOf(
            [
                row({ uri: "a", lastTs: "2026-10-15T10:00:00.000Z" }),
                row({ uri: "c", lastTs: "2026-10-17T09:00:00.000Z" }),
                row({ uri: "b", lastTs: "2026-10-16T23:00:00.000Z" }),
            ],
            [],
        );
        expect(v.items.map((r) => r.uri)).toEqual(["c", "b", "a"]);
        expect(v.more).toBe(0);
    });

    it("lastTs 为空（没聊过 / 账本没读到）→ 不进本区", () => {
        const v = resumeOf([row({ uri: "never", lastTs: null }), row({ uri: "talked", lastTs: "2026-10-15T10:00:00.000Z" })], []);
        expect(v.items.map((r) => r.uri)).toEqual(["talked"]);
    });

    it("开着 tab 的不列（已在视线内）", () => {
        const v = resumeOf([row({ uri: "open", opened: true, lastTs: "2026-10-17T10:00:00.000Z" })], []);
        expect(v.items).toEqual([]);
    });

    it("已被前两区（待你处理 / 后台活动）收走的不重复出现", () => {
        const rows = [
            row({ uri: "todo", unread: 2, lastTs: "2026-10-17T12:00:00.000Z" }),
            row({ uri: "bg", running: true, lastTs: "2026-10-17T11:00:00.000Z" }),
            row({ uri: "rest", lastTs: "2026-10-17T10:00:00.000Z" }),
        ];
        const v = resumeOf(rows, ["todo", "bg"]);
        expect(v.items.map((r) => r.uri)).toEqual(["rest"]);
    });

    it("截断要报数（more > 0），阈值取 RESUME_LIMIT", () => {
        const rows = Array.from({ length: RESUME_LIMIT + 3 }, (_, i) =>
            row({ uri: `u${i}`, lastTs: `2026-10-${String(10 + i).padStart(2, "0")}T10:00:00.000Z` }),
        );
        const v = resumeOf(rows, []);
        expect(v.items).toHaveLength(RESUME_LIMIT);
        expect(v.items[0].uri).toBe("u7"); // 最近的在最前
        expect(v.more).toBe(3);
        expect(resumeMoreTextOf(v)).toBe("还有 3 条更早的");
    });

    it("同一时刻的两行 → 按 uri 稳定排序（不随刷新抖动）", () => {
        const t = "2026-10-17T10:00:00.000Z";
        const v = resumeOf([row({ uri: "b", lastTs: t }), row({ uri: "a", lastTs: t })], []);
        expect(v.items.map((r) => r.uri)).toEqual(["a", "b"]);
    });

    it("空行集 → 空视图（调用方据此不渲染标题）", () => {
        const v = resumeOf([], []);
        expect(v.items).toEqual([]);
        expect(resumeMoreTextOf(v)).toBe("");
    });

    it("时间文案 `MM-DD HH:mm`；没有计时 → 空串（不编）", () => {
        expect(resumeWhenOf(row({ uri: "u", lastTs: "2026-10-17T10:05:00.000Z" }))).toMatch(/^\d\d-\d\d \d\d:\d\d$/);
        expect(resumeWhenOf(row({ uri: "u", lastTs: null }))).toBe("");
    });
});
