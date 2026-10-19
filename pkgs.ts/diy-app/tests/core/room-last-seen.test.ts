// tests/core/room-last-seen.test.ts
// 🎯 「水位写失败不许传染给投递」的判据（##377 第 18 刀 · owner review P1）
//
// 背景（owner 定位）：`deliverOne` 里 `await advanceLastSeen(...)` 的下一行是 `input.done(ev)`，
// 而 `post` 的收尾循环 `for (let finished = 0; finished < tasks.length;)` **只靠 `completed` 计数收敛**，
// `completed` 的唯一来源就是 `input.done` ⇒ 水位写失败一旦 reject 冒泡，`done` 不执行，
// 那条 `room.post` 的 serverStream **永远不关闭**（症状 = CLI / UI 挂住，不是报错）。
//
// 判据（水位是**优化**，丢一次最坏是多注入一轮）：
//   ① 正常：前移真的落盘
//   ② 写失败：`advanceLastSeen` **resolve**（不 reject）—— 这条就是 P1 本身
//   ③ 失败之后链仍可用：下一次前移照常成功（链尾存的是已消化的 promise，不是会 reject 的那个）

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceLastSeen, ensureRoom, readRoom, roomDir } from "../../src/main/core/room";

let home = "";
let prevHome: string | undefined;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "diy-room-seen-"));
    prevHome = process.env["DIY_HOME"];
    process.env["DIY_HOME"] = home;
});

afterEach(() => {
    if (prevHome === undefined) delete process.env["DIY_HOME"];
    else process.env["DIY_HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
});

describe("advanceLastSeen（水位前移）", () => {
    it("① 正常：前移落盘", async () => {
        ensureRoom("t1");
        await advanceLastSeen("t1", { "human:chen56": "e-1" });
        expect(readRoom("t1")?.lastSeen["human:chen56"]).toBe("e-1");
    });

    it("② 写失败 ⇒ resolve（不 reject）—— P1：水位失败不许挂死投递流", async () => {
        ensureRoom("t2");
        // 目录只读 ⇒ `writeFileAtomic` 在目标同目录建 tmp 时 EACCES
        chmodSync(roomDir("t2"), 0o555);
        try {
            await expect(advanceLastSeen("t2", { "human:chen56": "e-2" })).resolves.toBeUndefined();
        } finally {
            chmodSync(roomDir("t2"), 0o755);
        }
        // 写没成，水位没动 —— 但**调用方拿到的是 resolve**，`input.done` 会被执行
        expect(readRoom("t2")?.lastSeen["human:chen56"]).toBeUndefined();
    });

    it("③ 失败之后链仍可用：下一次前移照常成功", async () => {
        ensureRoom("t3");
        chmodSync(roomDir("t3"), 0o555);
        try {
            await advanceLastSeen("t3", { "human:chen56": "e-3a" });
        } finally {
            chmodSync(roomDir("t3"), 0o755);
        }
        await advanceLastSeen("t3", { "human:chen56": "e-3b" });
        expect(readRoom("t3")?.lastSeen["human:chen56"]).toBe("e-3b");
    });

    it("④ 房间不存在 ⇒ 静默（不抛，也不建房间）", async () => {
        await expect(advanceLastSeen("t4", { "human:chen56": "x" })).resolves.toBeUndefined();
        expect(readRoom("t4")).toBeNull();
    });
});
