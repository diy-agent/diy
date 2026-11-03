// tests/core/inbox-unread.test.ts
// ═══════════════════════════════════════════════════════════════
// ##436 通知信箱 UI 的**判据**（纯函数，`shared/inbox.ts`）：
//   ① 未读数 = 比水位**新**的条数（0 / 99+ / 全读归零 / 水位被 ring 挤掉 ⇒ 全部未读 /
//      inbox 被清空 ⇒ 0 且不为负）—— 口径是 id 的**单调序**，不是数组位置
//   ①' 水位按数据根分段（lab 与 prod 是两份账，不许互相清未读）
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
    unreadBreakdownOf,
    badgeUnreadOf,
    isNewerInboxId,
    inboxIdOrderOf,
    watermarkIdOf,
    watermarkStoreOf,
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

/** 真 id 形态：`ib-<毫秒>-<序号>`（序号补零 ⇒ 纯字符串比较也单调） */
const ib = (ms: number, seq: number): string => `ib-${ms}-${String(seq).padStart(4, "0")}`;

describe("##436 未读数（比水位新的条数）", () => {
    it("水位为空 = 全部未读（新装 / 清过视图 cache）", () => {
        const rows = [entry(ib(1, 1)), entry(ib(1, 2)), entry(ib(2, 1))];
        expect(unreadCountOf(rows, null)).toBe(3);
        expect(unreadCountOf(rows, "")).toBe(3);
    });

    it("水位在中间 = 比它新的那几条；水位是最新 = 0（全读后归零）", () => {
        const rows = [entry(ib(1, 1)), entry(ib(1, 2)), entry(ib(2, 1))];
        expect(unreadCountOf(rows, ib(1, 1))).toBe(2);
        expect(unreadCountOf(rows, ib(1, 2))).toBe(1);
        expect(unreadCountOf(rows, ib(2, 1))).toBe(0);
    });

    it("同毫秒内按序号比大小（旧的按字符串比会把 `-10` 判成比 `-9` 小）", () => {
        const rows = Array.from({ length: 12 }, (_, i) => entry(ib(1000, i + 1)));
        expect(unreadCountOf(rows, ib(1000, 9))).toBe(3); // 10 / 11 / 12
        expect(isNewerInboxId(ib(1000, 10), ib(1000, 9))).toBe(true);
    });

    it("水位比所有条目都旧（被 INBOX_MAX ring 挤掉）= 全部未读（不谎报已读）", () => {
        const rows = [entry(ib(5000, 1)), entry(ib(5000, 2))];
        expect(unreadCountOf(rows, ib(1, 1))).toBe(2);
    });

    it("inbox 被清空 / 换过数据根（水位比所有条目都新）= 0，**不许负数**", () => {
        const rows = [entry(ib(1000, 1))];
        expect(unreadCountOf(rows, ib(9999, 1))).toBe(0);
        expect(unreadCountOf([], ib(9999, 1))).toBe(0);
    });

    it("水位是脏值（解析不了）= 全部未读（宁可多报，也不谎报已读）", () => {
        const rows = [entry(ib(1, 1))];
        expect(unreadCountOf(rows, "早被挤掉的 id")).toBe(1);
        expect(unreadCountOf(rows, "ib-abc-1")).toBe(1);
    });

    it("空信箱 = 0", () => {
        expect(unreadCountOf([], "whatever")).toBe(0);
        expect(unreadCountOf([], null)).toBe(0);
    });

    it("`latestIdOf` = id 最新的那条（与数组顺序无关；空信箱 = null）", () => {
        expect(latestIdOf([])).toBeNull();
        expect(latestIdOf([entry(ib(2, 1)), entry(ib(1, 1))])).toBe(ib(2, 1));
    });

    it("id 解析：`ib-<毫秒>-<序号>` 才认，其它形态 = null（旧格式走兜底）", () => {
        expect(inboxIdOrderOf("ib-1792950000000-0003")).toEqual({ ms: 1792950000000, seq: 3 });
        expect(inboxIdOrderOf("a")).toBeNull();
        expect(inboxIdOrderOf("ib-1")).toBeNull();
    });
});

describe("##436 角标只数 N2（##266 复核阻塞 1）", () => {
    const n2e = (id: string): InboxEntry => entry(id, { level: "N2", kind: "message" });
    const n1e = (id: string, kind: "cost-step" | "message" = "cost-step"): InboxEntry => entry(id, { level: "N1", kind });

    it("全是 N1 ⇒ 角标为空（agent↔agent 派活不该把人叫来）", () => {
        const rows = [n1e(ib(1, 1)), n1e(ib(1, 2), "message"), n1e(ib(2, 1))];
        expect(badgeUnreadOf(rows, null)).toBe(0);
        expect(inboxBadgeOf(badgeUnreadOf(rows, null))).toBe("");
        expect(unreadBreakdownOf(rows, null)).toEqual({ n2: 0, n1: 3, total: 3 });
    });

    it("2 N2 + 3 N1 ⇒ 角标「2」，列表仍是 5 条", () => {
        const rows = [n2e(ib(1, 1)), n1e(ib(1, 2)), n2e(ib(2, 1)), n1e(ib(2, 2)), n1e(ib(3, 1), "message")];
        expect(inboxBadgeOf(badgeUnreadOf(rows, null))).toBe("2");
        expect(unreadBreakdownOf(rows, null)).toEqual({ n2: 2, n1: 3, total: 5 });
        // 分级只影响「催不催」，不影响「能不能看到」：面板渲染的是全量，不是 N2 子集
        expect(rows).toHaveLength(5);
        expect(unreadCountOf(rows, null)).toBe(5); // 总未读（面板头那句"共 N 条"用它）
    });

    it("水位照旧生效（只对 N2 数）：2 N2 全读过 ⇒ 角标空，N1 仍未读", () => {
        const rows = [n2e(ib(1, 1)), n2e(ib(1, 2)), n1e(ib(2, 1))];
        expect(badgeUnreadOf(rows, ib(1, 2))).toBe(0);
        expect(unreadBreakdownOf(rows, ib(1, 2))).toEqual({ n2: 0, n1: 1, total: 1 });
        expect(unreadBreakdownOf(rows, ib(2, 1))).toEqual({ n2: 0, n1: 0, total: 0 });
    });

    it("N2 超 99 折 `99+`（只数 N2）", () => {
        const rows = Array.from({ length: 120 }, (_, i) => n2e(ib(1000, i + 1)));
        expect(inboxBadgeOf(badgeUnreadOf(rows, null))).toBe("99+");
    });

    it("水位脏 / 清空 与 unreadCountOf 同源（不分叉）", () => {
        const rows = [n2e(ib(1, 1))];
        expect(unreadBreakdownOf(rows, "脏值")).toEqual({ n2: 1, n1: 0, total: 1 });
        expect(unreadBreakdownOf(rows, ib(9, 1))).toEqual({ n2: 0, n1: 0, total: 0 });
        expect(unreadBreakdownOf([], null)).toEqual({ n2: 0, n1: 0, total: 0 });
    });
});

describe("##436 已读水位按数据根分段（lab 与 prod 是两份账）", () => {
    it("存进去再取出来：只有同一个数据根才认", () => {
        const stored = watermarkStoreOf("/Users/ccc/.diy", "ib-1-0001");
        expect(stored).toBe("/Users/ccc/.diy|ib-1-0001");
        expect(watermarkIdOf(stored, "/Users/ccc/.diy")).toBe("ib-1-0001");
        // 换数据根（lab = build/home）⇒ 不认，全部未读（不许把 production 的未读清掉）
        expect(watermarkIdOf(stored, "/repo/build/home")).toBe("");
    });

    it("空 / 旧形态（裸 id，没有数据根）= 不认（判不出归属就多报未读）", () => {
        expect(watermarkIdOf("", "/x")).toBe("");
        expect(watermarkIdOf(null, "/x")).toBe("");
        expect(watermarkIdOf("ib-1-0001", "/x")).toBe("");
    });

    it("空 id ⇒ 空串（别把 `根|` 存成一个「看起来有水位」的值）", () => {
        expect(watermarkStoreOf("/x", "")).toBe("");
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
