// tests/core/room-tail-read.test.ts
// 🎯 room 轮询的读法与读盘合并（##427）
//
// 病根：`room.get` 每 2.5s 轮询一次，旧实现把**整份** events.jsonl 读进内存、逐行 JSON.parse + zod，
// 最后才 `slice(-limit)` —— `limit: 300` 对成本毫无作用；同一房间还被多个组件各读一遍。
//
// 本组钉四件事（每条都对着任务 body 的判据）：
//   ① **limit 真的不读全文**：倒读字节数 < 文件的一小部分（用 `roomReadStats().eventsTailBytes` 证明）；
//   ② **坏行只影响自身**：跳过 + 计数，其余照常返回（整份失败 / 静默吞掉都不行）；
//   ③ **文件签名缓存**：同一房间在一次刷新窗口里只读一次盘；文件变了立刻读到新的（不是 TTL）；
//   ④ **5 MB / 2600 条样本上的耗时 < 20 ms** + 读期间主进程事件循环 lag p99 < 50 ms。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
    appendEvent,
    ensureRoom,
    readEvents,
    readRoomView,
    resetRoomReadStats,
    roomDir,
    roomEventsPath,
    roomReadStats,
} from "../../src/main/core/room";
import { readRoomViewCached } from "../../src/main/core/room-view-cache";
import type { RoomEvent } from "../../src/shared/room";

const ROOM = "projects/4/tasks/900";
let home: string;
let prevHome: string | undefined;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "diy-room-tail-"));
    prevHome = process.env["DIY_HOME"];
    process.env["DIY_HOME"] = home;
    resetRoomReadStats();
    ensureRoom(ROOM, { members: [] });
});

afterEach(() => {
    if (prevHome === undefined) delete process.env["DIY_HOME"];
    else process.env["DIY_HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
});

function ev(i: number): RoomEvent {
    return {
        id: `e${i}`,
        ts: new Date(1_700_000_000_000 + i).toISOString(),
        channel: "default",
        kind: "say",
        author: "human:chen56",
        to: [],
        routing: "focus",
        text: `第 ${i} 条`,
        delivered: false,
    };
}

/** 同步造样本（测试不关心写侧：直接拼 jsonl，才能精确控制「坏行 / 无尾换行」这类边界） */
function seed(n: number, padChars = 0): void {
    mkdirSync(roomDir(ROOM), { recursive: true });
    const pad = "填充".repeat(padChars);
    const lines: string[] = [];
    for (let i = 1; i <= n; i++) lines.push(JSON.stringify({ ...ev(i), ...(pad ? { text: `第 ${i} 条 ${pad}` } : {}) }));
    writeFileSync(roomEventsPath(ROOM), lines.join("\n") + "\n", "utf8");
}

const ids = (events: readonly RoomEvent[]): string[] => events.map((e) => e.id);

describe("① limit 不读全文（倒读）", () => {
    it("只返回最后 N 条，且与全量读的尾巴逐条一致", async () => {
        seed(500);
        const all = await readEvents(ROOM);
        const tail = await readEvents(ROOM, { limit: 100 });
        expect(all.events).toHaveLength(500);
        expect(tail.events).toHaveLength(100);
        expect(ids(tail.events)).toEqual(ids(all.events.slice(-100)));
        expect(tail.bad).toBe(0);
    });

    it("实际读盘字节数远小于文件大小（不是「读全文再裁」）", async () => {
        seed(2600, 20); // ~每条几百字节，文件到 MB 级
        const size = statSync(roomEventsPath(ROOM)).size;
        expect(size).toBeGreaterThan(500_000);
        resetRoomReadStats();
        const { events } = await readEvents(ROOM, { limit: 50 });
        expect(events).toHaveLength(50);
        const read = roomReadStats().eventsTailBytes;
        // 只读了尾巴那一点：绝不能是整份
        expect(read).toBeLessThan(size / 3);
    });

    it("limit 大于总行数 ⇒ 全部返回（读到头了也不出错）", async () => {
        seed(7);
        const { events } = await readEvents(ROOM, { limit: 100 });
        expect(ids(events)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
    });

    it("尾行没有换行符（半截写入）⇒ 仍被读出来并如实计为坏行", async () => {
        seed(5);
        appendFileSync(roomEventsPath(ROOM), '{"id":"broken"', "utf8");
        const { events, bad } = await readEvents(ROOM, { limit: 3 });
        expect(bad).toBe(1); // 半截那行如实计数
        // 名额被坏行挤掉 ⇒ 自动宽一档，仍然给满 3 条（不是 2 条）
        expect(ids(events)).toEqual(["e3", "e4", "e5"]);
    });

    it("文件不存在 ⇒ 空结果，不抛", async () => {
        rmSync(roomEventsPath(ROOM), { force: true });
        expect(await readEvents(ROOM, { limit: 10 })).toEqual({ events: [], bad: 0 });
    });
});

describe("② 坏行只影响自身", () => {
    it("窗口内一条坏行 ⇒ 其余 N-1 条正常返回，坏行计数 1", async () => {
        seed(10);
        // 一条解析不了（半截写入）+ 一条能解析但过不了 zod（字段缺 / 类型错）
        appendFileSync(roomEventsPath(ROOM), "garbage-not-json\n", "utf8");
        appendFileSync(roomEventsPath(ROOM), `${JSON.stringify({ id: "wrong-shape" })}\n`, "utf8");
        appendFileSync(roomEventsPath(ROOM), `${JSON.stringify(ev(11))}\n`, "utf8");

        const { events, bad } = await readEvents(ROOM, { limit: 3 });
        expect(bad).toBe(2); // 坏行不静默吞掉：计数如实上报
        expect(ids(events)).toEqual(["e9", "e10", "e11"]); // 其余照常返回（不是整份失败，也不是只给 N-2 条）
    });

    it("readRoomView 汇总事件流与投递状态两处的坏行计数", async () => {
        seed(3);
        appendFileSync(roomEventsPath(ROOM), "oops\n", "utf8");
        const dPath = join(roomDir(ROOM), "deliveries.jsonl");
        appendFileSync(dPath, "oops-2\n", "utf8");
        writeFileSync(
            dPath,
            `${JSON.stringify({ eventId: "e3", memberId: "agent:main", status: "ok", ts: "2026-01-01T00:00:00.000Z" })}\n`,
            "utf8",
        );
        const view = await readRoomView(ROOM, { limit: 3 });
        expect(ids(view.events)).toEqual(["e1", "e2", "e3"]);
        expect(view.bad).toBe(1); // 只数窗口内 / 本次扫到的
        // 窗口内事件的投递状态照样 fold 上来
        expect(view.events.at(-1)!.deliveries?.map((d) => d.status)).toEqual(["ok"]);
    });
});

describe("③ 文件签名缓存 / 读盘合并", () => {
    it("同一房间连读两次 ⇒ 只读一次盘", async () => {
        seed(50);
        const a = await readRoomViewCached(ROOM, { limit: 10 });
        const afterFirst = roomReadStats().eventsFiles;
        const b = await readRoomViewCached(ROOM, { limit: 10 });
        expect(roomReadStats().eventsFiles).toBe(afterFirst);
        expect(ids(b.events)).toEqual(ids(a.events));
    });

    it("大窗口的缓存能答小窗口（不重读盘）", async () => {
        seed(50);
        await readRoomViewCached(ROOM, { limit: 30 });
        const afterFirst = roomReadStats().eventsFiles;
        const small = await readRoomViewCached(ROOM, { limit: 5 });
        expect(roomReadStats().eventsFiles).toBe(afterFirst);
        expect(ids(small.events)).toEqual(["e46", "e47", "e48", "e49", "e50"]);
    });

    it("并发两个订阅者 ⇒ 共享同一次读盘", async () => {
        seed(50);
        const [a, b] = await Promise.all([readRoomViewCached(ROOM, { limit: 10 }), readRoomViewCached(ROOM, { limit: 10 })]);
        expect(ids(a.events)).toEqual(ids(b.events));
        expect(roomReadStats().eventsFiles).toBe(1);
    });

    it("盘上变了 ⇒ 下一次立即读到新的（签名失效，不是 TTL 拖着）", async () => {
        seed(10);
        const before = await readRoomViewCached(ROOM, { limit: 5 });
        expect(ids(before.events).at(-1)).toBe("e10");
        await appendEvent(ROOM, ev(11));
        const afterView = await readRoomViewCached(ROOM, { limit: 5 });
        expect(ids(afterView.events).at(-1)).toBe("e11");
    });
});

describe("④ 5 MB / 2600 条样本：耗时与事件循环 lag", () => {
    it("room.get(limit: 300) < 20 ms；读期间 event loop lag p99 < 50 ms", async () => {
        seed(2600, 320); // 每条约 2 KB ⇒ 文件 ~5 MB
        const size = statSync(roomEventsPath(ROOM)).size;
        expect(size).toBeGreaterThan(4 * 1024 * 1024);

        // 预热一次（JIT / 页缓存），量的是「轮询里真实的那一下」，不是冷启动
        const warm = await readRoomView(ROOM, { limit: 300 });
        expect(warm.events).toHaveLength(300);

        const hist = monitorEventLoopDelay({ resolution: 10 });
        hist.enable();
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
            const t0 = performance.now();
            const view = await readRoomView(ROOM, { limit: 300 });
            times.push(performance.now() - t0);
            expect(view.events).toHaveLength(300);
        }
        hist.disable();
        times.sort((a, b) => a - b);
        // 判据：中位数 < 20 ms（改前同口径是 ~60 ms；生产 5 MB 外推 ~700 ms）
        expect(times[2]!).toBeLessThan(20);
        expect(hist.percentile(99) / 1e6).toBeLessThan(50);
    });

    it("同一样本下走缓存的最快路径（文件没变）远快于一次真读", async () => {
        seed(2600, 320);
        await readRoomViewCached(ROOM, { limit: 300 });
        const t0 = performance.now();
        for (let i = 0; i < 5; i++) await readRoomViewCached(ROOM, { limit: 300 });
        const cached = (performance.now() - t0) / 5;
        expect(roomReadStats().eventsFiles).toBe(1); // 后 5 次一次都没读
        expect(cached).toBeLessThan(5);
    });
});
