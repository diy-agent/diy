// tests/core/room-path.test.ts
// 🎯 room id → 落盘路径的**平台安全**（2026-10-31 事故：6789 个影子任务）
//
// 病根：侧边栏 room 的 id 是 `agent:room:ui/sidebar-<实例>`，旧实现**直接拿 id 当目录名**。
// 在 Windows 上 `:` 是 NTFS 的 ADS 分隔符：`mkdir` 直接 ENOENT（实测），写文件会静默落进
// 不可见的流 ⇒ `writeRoom` 失败 → `readRoom` 永远 null → `ensureSidebarRoom` 每次重试
// （UI 每 ~2s）都新建一个影子任务。
//
// 本组钉三件事：
//   ① 编码：`:` 等不安全字符必须被编码，且**可逆**；`/` 保留 ⇒ 任务 room 路径一字不变（零迁移）；
//   ② 真的能写能读：带冒号的 id 在临时 DIY_HOME 下建房间、写成员、再读回来（这就是那条一直失败的路径）；
//   ③ 幂等 + 顺序：房间落不了盘时**不许**留下影子任务（顺序 = 先探针后建任务）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ensureRoom, listRooms, readRoom, roomDir, roomYamlPath, upsertMember } from "../../src/main/core/room";
import { roomDirName, roomIdFromDirName, SIDEBAR_ROOM_PREFIX, HUMAN_MEMBER_ID } from "../../src/shared/room";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "diy-room-path-"));
    prevHome = process.env["DIY_HOME"];
    process.env["DIY_HOME"] = home;
});

afterEach(() => {
    if (prevHome === undefined) delete process.env["DIY_HOME"];
    else process.env["DIY_HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
});

const SIDEBAR = `${SIDEBAR_ROOM_PREFIX}dev-abc123`;

describe("roomDirName — id 不是目录名", () => {
    it("冒号被编码，且可逆", () => {
        const name = roomDirName(SIDEBAR);
        expect(name).not.toContain(":");
        expect(roomIdFromDirName(name)).toBe(SIDEBAR);
    });

    it("任务 room（taskUri）路径一字不变：`/` 保留 ⇒ 零迁移", () => {
        expect(roomDirName("projects/4/tasks/900")).toBe("projects/4/tasks/900");
    });

    it("`%` 自身也被编码（否则解码会误判老目录名）", () => {
        const id = "a%3Ab";
        expect(roomDirName(id)).not.toBe(id);
        expect(roomIdFromDirName(roomDirName(id))).toBe(id);
    });

    it("老的原样目录名（解不开的百分号序列）→ 原样返回，不炸", () => {
        expect(roomIdFromDirName("agent:room:ui/sidebar-x")).toBe("agent:room:ui/sidebar-x");
        expect(roomIdFromDirName("100%")).toBe("100%");
    });
});

describe("带冒号的房间真的能落盘（Windows 上这条一直是失败的）", () => {
    it("ensureRoom 写出 room.yaml，readRoom 读得回来", () => {
        ensureRoom(SIDEBAR, { title: "侧边栏助手", members: [] });
        expect(existsSync(roomYamlPath(SIDEBAR))).toBe(true);
        const room = readRoom(SIDEBAR);
        expect(room?.id).toBe(SIDEBAR);
        expect(room?.title).toBe("侧边栏助手");
    });

    it("目录名里没有冒号（NTFS 上不可能建出来）", () => {
        ensureRoom(SIDEBAR, { members: [] });
        const dirName = readdirSync(join(home, "rooms"));
        expect(dirName.some((n) => n.includes(":"))).toBe(false);
        // 只看 `rooms/` 之下的部分：盘符里的 `C:` 不算（那是合法前缀）
        expect(relative(join(home, "rooms"), roomDir(SIDEBAR))).not.toContain(":");
    });

    it("写成员后再读：成员表留得住（走的是同一条读写路径）", () => {
        ensureRoom(SIDEBAR, { members: [] });
        upsertMember(SIDEBAR, { id: HUMAN_MEMBER_ID, name: "chen56", kind: "human", backend: null });
        const room = readRoom(SIDEBAR);
        expect(room?.members.map((m) => m.id)).toContain(HUMAN_MEMBER_ID);
    });

    it("listRooms 能把它列出来，且 id 是**解码后**的原值", () => {
        ensureRoom(SIDEBAR, { members: [] });
        const ids = listRooms().map((r) => r.id);
        expect(ids).toContain(SIDEBAR);
    });
});
