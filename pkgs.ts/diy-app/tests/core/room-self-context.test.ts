// tests/core/room-self-context.test.ts
// 🎯 成员**自己起一轮**时也能读到房间刚才说了什么（##377 第 25 刀 → 第 26 刀改成 runtime 单元）
//
// 病灶：第 18 刀的「本房间近期发言」只在**被投递**时注入（`deliveryText`）——
//   任务页点跑 / 定时任务 / CLI 一句话都不经过投递 ⇒ 它不知道自己在跟谁说话。
//
// 第 26 刀把落点从「拼进 user 正文」换成 **runtime 变量单元**（`room.members` / `room.recent`）。
// 本文件验「算得对不对」（值与水位），接线见 `room-self-context-inject.test.ts`。
//
// 判据：
//   ① 没有房间 / 没有能对上这个 task 的成员 ⇒ `null`（运行时上下文逐字不变）
//   ② 别人的话 ⇒ `room.recent.items` 带 `from`（**能 @ 的键**）+ `at` + `text`，且**不含自己**
//   ③ 水位：`commit` 之后同一段不再出现（不重复），且水位真的落盘；之后新发言仍会出现
//   ④ 上限：≤20 条 / 4000 字符，超出取最近的并带 `omitted`
//   ⑤ 成员单元：`key` 与补全/解析同一份判据、`main` 标出会话主人

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, advanceLastSeen, ensureRoom, readRoom, upsertMember } from "../../src/main/core/room";
import { commitSelfStartContext, roomRuntimeFact } from "../../src/main/services/room-context";
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

const fact = async () => roomRuntimeFact({ roomId: ROOM, taskUri: ROOM });

describe("roomRuntimeFact（runtime.room 单元）", () => {
    it("① 房间不存在 ⇒ null（没开过任务页 / 没被投递过 = 零变化）", async () => {
        expect(await fact()).toBeNull();
    });

    it("① 房间在但事件流为空 ⇒ 只有成员单元，没有 recent 单元", async () => {
        seedRoom();
        const f = (await fact())!;
        expect(f).not.toBeNull();
        expect(f.value.members.list.length).toBe(2);
        expect(f.value.recent).toBeUndefined();
    });

    it("① 只有主人格自己说的话 ⇒ 没有 recent 单元（它自己的话在它自己会话里）", async () => {
        seedRoom();
        await appendEvent(ROOM, say("agent:main", "我先说一句"));
        expect((await fact())!.value.recent).toBeUndefined();
    });

    it("② 别人的话 ⇒ recent 带 from（能力 @ 的键）/ at / text，不含自己说的", async () => {
        seedRoom();
        await appendEvent(ROOM, say("agent:main", "这句是我自己说的"));
        await appendEvent(ROOM, say("human:chen56", "先跑一下测试"));
        const recent = (await fact())!.value.recent!;
        expect(recent.items).toHaveLength(1);
        expect(recent.items[0]).toMatchObject({ from: "chen56", text: "先跑一下测试" });
        expect(recent.items[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(recent.omitted).toBe(0);
        expect(JSON.stringify(recent)).not.toContain("这句是我自己说的");
    });

    it("⑤ 成员单元：每个成员都有能 @ 的 key，主人格标 main（与补全/解析同一份判据）", async () => {
        seedRoom();
        const m = (await fact())!.value.members;
        expect(m.roomId).toBe(ROOM);
        expect(m.name).toBe("#1");
        const main = m.list.find((x) => x.id === "agent:main")!;
        expect(main.main).toBe(true);
        expect(main.key).toBeTruthy();
        const human = m.list.find((x) => x.id === "human:chen56")!;
        expect(human).toMatchObject({ name: "chen56", key: "chen56", main: false });
    });

    it("③ commit 之后同一段不再出现（不重复），水位真的落盘", async () => {
        seedRoom();
        await appendEvent(ROOM, say("human:chen56", "先跑一下测试"));
        const first = (await fact())!;
        expect(first.value.recent!.items).toHaveLength(1);
        commitSelfStartContext(ROOM, first);
        // 水位是**异步**写的（promise 链）—— 串到链尾再断言（真实路径里下一轮早在这之后）
        await advanceLastSeen(ROOM, {});
        expect(readRoom(ROOM)?.lastSeen["agent:main"]).toBe(first.tailId);
        expect((await fact())!.value.recent).toBeUndefined();
    });

    it("③ 水位之后**新**的发言仍然会进来（不是一劳永逸关掉）", async () => {
        seedRoom();
        await appendEvent(ROOM, say("human:chen56", "第一句"));
        commitSelfStartContext(ROOM, (await fact())!);
        await advanceLastSeen(ROOM, {});
        await appendEvent(ROOM, say("human:chen56", "第二句"));
        const second = (await fact())!.value.recent!;
        expect(second.items.map((i) => i.text)).toEqual(["第二句"]);
    });

    it("④ 上限：25 条 ⇒ 只带最近 20 条 + omitted", async () => {
        seedRoom();
        for (let i = 1; i <= 25; i++) await appendEvent(ROOM, say("human:chen56", `造数第${i}条`));
        const recent = (await fact())!.value.recent!;
        expect(recent.items).toHaveLength(CONTEXT_MAX_EVENTS);
        expect(recent.omitted).toBe(25 - CONTEXT_MAX_EVENTS);
        expect(recent.items.at(-1)!.text).toBe("造数第25条");
        expect(recent.items[0]!.text).toBe("造数第6条");
    });

    it("⑤ 没有能对上这个 task 的成员 ⇒ null（不猜谁是主人）", async () => {
        ensureRoom(ROOM);
        upsertMember(ROOM, { id: "human:chen56", name: "chen56", kind: "human", backend: null });
        await appendEvent(ROOM, say("human:chen56", "一句"));
        expect(await fact()).toBeNull();
    });

    it("⑤ 成员 backend 指向别的 task ⇒ 优先精确匹配（拿的是这个 task 的水位键）", async () => {
        ensureRoom(ROOM);
        upsertMember(ROOM, {
            id: "agent:main",
            name: "deepseek-4.1-flash",
            kind: "agent",
            backend: { type: "task", data: { taskUri: "projects/1/tasks/9" } },
            main: true,
        });
        await appendEvent(ROOM, say("human:chen56", "一句"));
        expect((await fact())!.memberId).toBe("agent:main");
    });

    it("投递轮：`sayId` 指向的那一条不进 recent（正文里已经有了）", async () => {
        seedRoom();
        const target = say("human:chen56", "就是这一条");
        await appendEvent(ROOM, say("human:chen56", "更早的一句"));
        await appendEvent(ROOM, target);
        const f = (await roomRuntimeFact({ roomId: ROOM, taskUri: ROOM, sayId: target.id }))!;
        expect(f.value.recent!.items.map((i) => i.text)).toEqual(["更早的一句"]);
    });
});
