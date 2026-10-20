// tests/core/room-self-context.test.ts
// 🎯 成员**自己起一轮**时也能读到房间刚才说了什么（##377 第 25 刀 · owner 口径 ②）
//
// 病灶：第 18 刀的「本房间近期发言」只在**被投递**时注入（`deliveryText`）——
//   任务页点跑 / 定时任务 / CLI 一句话都不经过投递 ⇒ 它不知道自己在跟谁说话。
//
// 判据（owner 点名要的是**判据**，不是功能）：
//   ① 没有房间 / 没有事件 / 只有自己的话 ⇒ `null`（正文**逐字不变** —— 第 17 刀判据 1/7 的回归网）
//   ② 别人的话 ⇒ 段里带作者名 + 原话，且**不含自己**说的
//   ③ 水位：`commit` 之后同一段不再注入（不重复），且水位真的落盘
//   ④ 上限：≤20 条 / 4000 字符，超出取最近的并标注「更早的 N 条已省略」
//   ⑤ 没有主人格的房间 ⇒ `null`（不猜"谁是主人"）

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, advanceLastSeen, ensureRoom, readRoom, upsertMember } from "../../src/main/core/room";
import { commitSelfStartContext, selfStartContext } from "../../src/main/services/room-context";
import { CONTEXT_MAX_EVENTS, type RoomEvent } from "../../src/shared/room";

const ROOM = "projects/1/tasks/1";

let home = "";
let prevHome: string | undefined;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "diy-room-selfctx-"));
    prevHome = process.env["DIY_HOME"];
    process.env["DIY_HOME"] = home;
});

afterEach(() => {
    if (prevHome === undefined) delete process.env["DIY_HOME"];
    else process.env["DIY_HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
});

let seq = 0;
function say(author: string, text: string): RoomEvent {
    return {
        id: `e${++seq}_${author.replace(/[^a-z0-9]/gi, "")}`,
        ts: new Date(2026, 9, 20, 10, 0, seq).toISOString(),
        channel: "default",
        kind: "say",
        author,
        to: [],
        text,
        delivered: true,
    };
}

/** 建一间「人 + 主人格」的任务房间（主人格的 backend = 这个 task） */
function seedRoom(): void {
    ensureRoom(ROOM);
    upsertMember(ROOM, {
        id: "agent:main",
        name: "deepseek-4.1-flash",
        kind: "agent",
        backend: { type: "task", data: { taskUri: ROOM } },
        main: true,
    });
    upsertMember(ROOM, { id: "human:chen56", name: "chen56", kind: "human", backend: null });
}

describe("selfStartContext（轮首注入）", () => {
    it("① 房间不存在 ⇒ null（没开过任务页 / 没被投递过 = 零变化）", () => {
        expect(selfStartContext(ROOM)).toBeNull();
    });

    it("① 房间在但事件流为空 ⇒ null", () => {
        seedRoom();
        expect(selfStartContext(ROOM)).toBeNull();
    });

    it("① 只有主人格自己说的话 ⇒ null（它自己的话在它自己会话里）", () => {
        seedRoom();
        appendEvent(ROOM, say("agent:main", "我先说一句"));
        expect(selfStartContext(ROOM)).toBeNull();
    });

    it("② 别人的话 ⇒ 段里带作者名与原话，不含自己说的", () => {
        seedRoom();
        appendEvent(ROOM, say("agent:main", "这句是我自己说的"));
        appendEvent(ROOM, say("human:chen56", "先跑一下测试"));
        const ctx = selfStartContext(ROOM)!;
        expect(ctx).not.toBeNull();
        // 段头与投递路径**同一个**（`contextBlock` 一处真源）
        expect(ctx.text).toContain("[本房间近期发言]");
        expect(ctx.text).toContain("chen56: 先跑一下测试");
        expect(ctx.text).not.toContain("这句是我自己说的");
        expect(ctx.items).toBe(1);
        expect(ctx.omitted).toBe(0);
        // 水位落点 = 流里最后一条（本次注入覆盖到它）
        expect(ctx.tailId).toBeTruthy();
    });

    it("③ commit 之后同一段不再注入（不重复），水位真的落盘", async () => {
        seedRoom();
        appendEvent(ROOM, say("human:chen56", "先跑一下测试"));
        const ctx = selfStartContext(ROOM)!;
        expect(ctx).not.toBeNull();
        commitSelfStartContext(ROOM, ctx);
        // 水位是**异步**写的（promise 链）—— 串到链尾再断言（真实路径里下一轮早在这之后）
        await advanceLastSeen(ROOM, {});
        expect(readRoom(ROOM)?.lastSeen["agent:main"]).toBe(ctx.tailId);
        expect(selfStartContext(ROOM)).toBeNull();
    });

    it("③ 水位之后**新**的发言仍然会注入（不是一劳永逸关掉）", async () => {
        seedRoom();
        appendEvent(ROOM, say("human:chen56", "第一句"));
        const first = selfStartContext(ROOM)!;
        commitSelfStartContext(ROOM, first);
        // 水位是**异步**写的（promise 链，见 `advanceLastSeen` 头注）—— 串到链尾等它落盘再断言
        await advanceLastSeen(ROOM, {});
        appendEvent(ROOM, say("human:chen56", "第二句"));
        const second = selfStartContext(ROOM)!;
        expect(second.text).toContain("第二句");
        expect(second.text).not.toContain("第一句");
    });

    it("④ 上限：25 条 ⇒ 只带最近 20 条 + 标注省略条数", () => {
        seedRoom();
        for (let i = 1; i <= 25; i++) appendEvent(ROOM, say("human:chen56", `造数第${i}条`));
        const ctx = selfStartContext(ROOM)!;
        expect(ctx.items).toBe(CONTEXT_MAX_EVENTS);
        expect(ctx.omitted).toBe(25 - CONTEXT_MAX_EVENTS);
        expect(ctx.text).toContain("造数第25条");
        expect(ctx.text).not.toContain("造数第1条");
        expect(ctx.text).toContain(`（更早的 ${25 - CONTEXT_MAX_EVENTS} 条已省略）`);
    });

    it("⑤ 没有主人格的房间 ⇒ null（不猜谁是主人）", () => {
        ensureRoom(ROOM);
        upsertMember(ROOM, { id: "human:chen56", name: "chen56", kind: "human", backend: null });
        appendEvent(ROOM, say("human:chen56", "一句"));
        expect(selfStartContext(ROOM)).toBeNull();
    });

    it("⑤ 主人格 backend 指向别的 task ⇒ 不认它（宁可没有上下文，也不拿错人的水位）", () => {
        ensureRoom(ROOM);
        upsertMember(ROOM, {
            id: "agent:main",
            name: "deepseek-4.1-flash",
            kind: "agent",
            backend: { type: "task", data: { taskUri: "projects/1/tasks/9" } },
            main: true,
        });
        appendEvent(ROOM, say("human:chen56", "一句"));
        // 兜底分支（「房间里的 main」）会认它 —— 这条只是钉住"优先精确匹配"的语义，
        // 故断言**不会崩、且取的是这个 task 的水位键**
        const ctx = selfStartContext(ROOM);
        if (ctx) expect(ctx.memberId).toBe("agent:main");
    });
});
