// tests/core/inbox-unread.test.ts
// ═══════════════════════════════════════════════════════════════
// ##436 通知信箱 UI 的**判据**（纯函数，`shared/inbox.ts`）：
//   ① 未读数 = 水位之后的条数（0 / 99+ / 全读归零 / 水位被 ring 挤掉 ⇒ 全部未读）
//   ② 徽标文字（0 = 不显示数字，图标恒在）
//   ③ 跳转锚点（有锚点才"定位"，没锚点必须由调用方说出来）
//   ④ kind 的中文名覆盖完整（组件里不许各写一份文案）
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
    INBOX_KINDS,
    INBOX_KIND_LABEL,
    INBOX_MAX,
    inboxBadgeOf,
    inboxPreviewOf,
    jumpOf,
    hasAnchorOf,
    latestIdOf,
    unreadCountOf,
    type InboxEntry,
} from "../../src/shared/inbox";

const entry = (id: string, over: Partial<InboxEntry> = {}): InboxEntry => ({
    id,
    ts: "2026-10-25T12:00:00.000Z",
    level: "N1",
    kind: "cost-step",
    taskUri: "projects/4/tasks/436",
    text: "单步花了 $0.20",
    source: "agent 成本门槛告警",
    reason: "超过阈值",
    detail: "机制",
    ...over,
});

describe("##436 未读数（水位之后的条数）", () => {
    it("水位为空 = 全部未读（新装 / 清过视图 cache）", () => {
        const rows = [entry("a"), entry("b"), entry("c")];
        expect(unreadCountOf(rows, null)).toBe(3);
        expect(unreadCountOf(rows, "")).toBe(3);
    });

    it("水位在中间 = 之后那几条；水位是最新 = 0（全读后归零）", () => {
        const rows = [entry("a"), entry("b"), entry("c")];
        expect(unreadCountOf(rows, "a")).toBe(2);
        expect(unreadCountOf(rows, "b")).toBe(1);
        expect(unreadCountOf(rows, "c")).toBe(0);
    });

    it("水位找不到（被 INBOX_MAX ring 挤掉）= 全部未读（不谎报已读）", () => {
        const rows = [entry("x"), entry("y")];
        expect(unreadCountOf(rows, "早被挤掉的 id")).toBe(2);
    });

    it("空信箱 = 0", () => {
        expect(unreadCountOf([], "whatever")).toBe(0);
        expect(unreadCountOf([], null)).toBe(0);
    });

    it("`latestIdOf` = 最后一条（空信箱 = null，不写空串进 cache）", () => {
        expect(latestIdOf([])).toBeNull();
        expect(latestIdOf([entry("a"), entry("b")])).toBe("b");
    });
});

describe("##436 徽标文字（0 不显示数字 / 99+）", () => {
    it("0 与负数都是空串（图标恒在，只是不显示数字）", () => {
        expect(inboxBadgeOf(0)).toBe("");
        expect(inboxBadgeOf(-1)).toBe("");
    });

    it("1..99 照数显示", () => {
        expect(inboxBadgeOf(1)).toBe("1");
        expect(inboxBadgeOf(99)).toBe("99");
    });

    it(">99 折成 `99+`（不许把顶栏撑爆）", () => {
        expect(inboxBadgeOf(100)).toBe("99+");
        expect(inboxBadgeOf(INBOX_MAX)).toBe("99+");
    });
});

describe("##436 跳转锚点", () => {
    it("taskUri 只算'打开'，不算'定位'", () => {
        const j = jumpOf(entry("a"));
        expect(j).toEqual({ taskUri: "projects/4/tasks/436", turnId: undefined, blockId: undefined, steerId: undefined });
        expect(hasAnchorOf(j)).toBe(false);
    });

    it("data 里三种锚点都认；空串不算锚点", () => {
        const j = jumpOf(entry("a", { data: { steerId: "st-1", turnId: "", blockId: 123 } }));
        expect(j.steerId).toBe("st-1");
        expect(j.turnId).toBeUndefined(); // 空串 = 没给
        expect(j.blockId).toBeUndefined(); // 非字符串 = 不认（别把数字当块 id）
        expect(hasAnchorOf(j)).toBe(true);
    });
});

describe("##436 kind 文案 + 一行摘要", () => {
    it("每个 kind 都有中文名（列表里不许出现英文原值）", () => {
        for (const k of INBOX_KINDS) {
            expect(INBOX_KIND_LABEL[k], k).toBeTruthy();
        }
    });

    it("摘要把多行折成一行并截断（原文另有 data.raw，不在摘要里丢）", () => {
        expect(inboxPreviewOf("第一行\n第二行\n\n第三行")).toBe("第一行 第二行 第三行");
        const long = "字".repeat(100);
        expect(inboxPreviewOf(long, 10)).toBe(`${"字".repeat(10)}…`);
    });
});
