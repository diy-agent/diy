// tests/core/room-unread.test.ts
// 🎯 未读提示的判据（##377 第 28 刀 · 可用性收口第 3 条）
//
// 用户复现：「侧边栏收起时别人说话 ⇒ 展开后无标记」。本组钉两件事：
//   ① **计算**（`unreadSince`，纯函数）—— 只数别人说的、按流内位置定位游标、游标找不到就按"从头看"；
//   ② **落盘**（`markRead`）—— 只动人成员的游标、没变化不写盘、没有房间 / 没有人成员时静默。
//
// 为什么"没变化不写盘"也要测：UI 每 2.5s 轮询一次都要问一次"要不要前移"，
// 每次都原子写 room.yaml = 白烧 IO，且文件 mtime 一直跳（引用稳定器白重算）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, ensureRoom, markRead, readRoom, roomDir } from "../../src/main/core/room";
import { HUMAN_MEMBER_ID, MAIN_MEMBER_ID, unreadSince, type RoomEvent, type RoomMember } from "../../src/shared/room";

const HUMAN: RoomMember = { id: HUMAN_MEMBER_ID, name: "chen56", kind: "human", backend: null, role: "我" };
const DEV: RoomMember = { id: "agent:dev", name: "dev", kind: "agent", backend: { type: "task", data: { taskUri: "t/dev" } } };

function ev(id: string, author: string, text = "x"): RoomEvent {
    return { id, ts: "2026-10-20T00:00:00.000Z", channel: "default", kind: author.startsWith("agent:") ? "reply" : "say", author, to: [], text, delivered: false };
}

describe("unreadSince：未读条数 / 第一条未读 / 流尾落点", () => {
    it("① 没有游标（老房间第一次打开）⇒ 按从头看，只数别人的", () => {
        const events = [ev("e1", HUMAN.id), ev("e2", "agent:dev"), ev("e3", HUMAN.id), ev("e4", "agent:dev")];
        const u = unreadSince(events, { cursorId: undefined, viewerId: HUMAN.id });
        expect(u).toEqual({ count: 2, firstId: "e2", lastId: "e4", cursorFound: false });
    });

    it("② 游标之后只算**别人说的**（自己发的不算未读）", () => {
        const events = [ev("e1", HUMAN.id), ev("e2", HUMAN.id), ev("e3", "agent:dev"), ev("e4", HUMAN.id)];
        const u = unreadSince(events, { cursorId: "e1", viewerId: HUMAN.id });
        expect(u.count).toBe(1);
        expect(u.firstId).toBe("e3");
        // 落点是**流尾**（与自己说没说无关）：游标是位置，不是"谁说的"
        expect(u.lastId).toBe("e4");
        expect(u.cursorFound).toBe(true);
    });

    it("③ 游标在流尾 ⇒ 0 条（标签不该亮），但落点仍是流尾", () => {
        const events = [ev("e1", "agent:dev"), ev("e2", HUMAN.id)];
        const u = unreadSince(events, { cursorId: "e2", viewerId: HUMAN.id });
        expect(u).toEqual({ count: 0, firstId: null, lastId: "e2", cursorFound: true });
    });

    it("④ 游标在流里找不到（事件被清过 / 换了房间）⇒ 从头算，**不静默当已读**", () => {
        const events = [ev("e9", "agent:dev"), ev("e10", "agent:dev")];
        const u = unreadSince(events, { cursorId: "e-from-another-room", viewerId: HUMAN.id });
        expect(u.count).toBe(2);
        expect(u.firstId).toBe("e9");
        expect(u.cursorFound).toBe(false);
    });

    it("⑤ 空房间 ⇒ 全 null（球上不该出现角标）", () => {
        expect(unreadSince([], { cursorId: null, viewerId: HUMAN.id })).toEqual({
            count: 0,
            firstId: null,
            lastId: null,
            cursorFound: false,
        });
    });
});

describe("markRead：人成员的阅读游标前移", () => {
    let home = "";
    let prevHome: string | undefined;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "diy-room-unread-"));
        prevHome = process.env["DIY_HOME"];
        process.env["DIY_HOME"] = home;
    });

    afterEach(() => {
        if (prevHome === undefined) delete process.env["DIY_HOME"];
        else process.env["DIY_HOME"] = prevHome;
        rmSync(home, { recursive: true, force: true });
    });

    it("① 前移到指定事件：**只动人成员**的格子（agent 的投递水位不许被 UI 前移）", async () => {
        ensureRoom("t1", { members: [HUMAN, DEV] });
        appendEvent("t1", ev("e1", "agent:dev"));
        expect(await markRead("t1", "e1")).toBe(true);
        const room = readRoom("t1");
        expect(room?.lastSeen[HUMAN_MEMBER_ID]).toBe("e1");
        expect(room?.lastSeen[MAIN_MEMBER_ID]).toBeUndefined();
        expect(room?.lastSeen["agent:dev"]).toBeUndefined();
    });

    it("② 不给事件 ⇒ 前移到流尾", async () => {
        ensureRoom("t2", { members: [HUMAN, DEV] });
        appendEvent("t2", ev("e1", HUMAN.id));
        appendEvent("t2", ev("e2", "agent:dev"));
        expect(await markRead("t2")).toBe(true);
        expect(readRoom("t2")?.lastSeen[HUMAN_MEMBER_ID]).toBe("e2");
    });

    it("③ 已经是这一条 ⇒ 不写盘（advanced=false，且 updated 没被刷新）", async () => {
        ensureRoom("t3", { members: [HUMAN] });
        appendEvent("t3", ev("e1", "agent:dev"));
        await markRead("t3", "e1");
        const before = readRoom("t3")!;
        expect(await markRead("t3", "e1")).toBe(false);
        expect(readRoom("t3")!.updated).toBe(before.updated);
    });

    it("④ 没有这个房间 / 没有人成员 ⇒ 静默不动（游标是优化，不是故障）", async () => {
        expect(await markRead("nope", "e1")).toBe(false);
        ensureRoom("t5", { members: [DEV] }); // 只有 agent 成员
        appendEvent("t5", ev("e1", DEV.id));
        expect(await markRead("t5", "e1")).toBe(false);
        expect(readRoom("t5")?.lastSeen).toEqual({});
    });

    it("⑤ 写盘失败 ⇒ 不 reject（与 advanceLastSeen 同口径：游标丢了最坏多提示一条未读）", async () => {
        ensureRoom("t6", { members: [HUMAN] });
        appendEvent("t6", ev("e1", "agent:dev"));
        chmodSync(roomDir("t6"), 0o555);
        try {
            await expect(markRead("t6", "e1")).resolves.toBe(false);
        } finally {
            chmodSync(roomDir("t6"), 0o755);
        }
        expect(readRoom("t6")?.lastSeen[HUMAN_MEMBER_ID]).toBeUndefined();
    });
});
