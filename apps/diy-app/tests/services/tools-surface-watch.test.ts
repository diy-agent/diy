// tests/services/tools-surface-watch.test.ts
// 🎯 ##519 工具面漂移的**启动时预报**：判定 + 落盘 + 与真发快照同口径。
//
// 三条契约（每条都能单独坏）：
//   ① 没有记录（首次 / 老数据 / 坏文件）⇒ **不报警**（宁少报，不谎报）
//   ② 记录在、hash 变了 ⇒ changed=true，且把"上一次"原样带出来（报警要说清从什么变到什么）
//   ③ 启动口径（`currentToolsSurfaceHash()`）与真发快照（`sha256Hex(JSON.stringify(buildTools(cwd)))`）
//      **逐字节相同** —— 两边分叉就会出现「启动说没变、真发说变了」的假警报

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    TOOLS_SURFACE_VERSION,
    readToolsSurfaceRecord,
    toolsSurfaceDriftOf,
    toolsSurfaceFile,
    writeToolsSurfaceRecord,
} from "../../src/main/services/tools-surface-watch";
import { buildTools, currentToolsSurfaceHash, DEFAULT_LIMITS } from "../../src/main/services/local-agent";
import { sha256Hex } from "@diy-agent/context/hash";

let home: string;

beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "diy-tools-watch-"));
});

afterAll(() => {
    rmSync(home, { recursive: true, force: true });
});

describe("##519 工具面漂移判定", () => {
    it("① 没有记录 ⇒ 读不出、不报警（首次启动 / 老数据）", () => {
        expect(readToolsSurfaceRecord(home)).toBeNull();
        const d = toolsSurfaceDriftOf(home, "aaaa");
        expect(d.previous).toBeNull();
        expect(d.changed).toBe(false);
    });

    it("坏文件 / 版本不认识 ⇒ 当作没有（宁可退回没历史，也不拿半懂的字段报警）", () => {
        writeFileSync(toolsSurfaceFile(home), "version: 999\nhash: zzz\n", "utf-8");
        expect(readToolsSurfaceRecord(home)).toBeNull();
        writeFileSync(toolsSurfaceFile(home), "::: 不是 yaml [\n", "utf-8");
        expect(readToolsSurfaceRecord(home)).toBeNull();
    });

    it("② 记录在、hash 变了 ⇒ changed=true，并原样带出上一次（含时刻）", () => {
        writeToolsSurfaceRecord(home, "aaaa1111", "2026-11-05T10:00:00.000+0800");
        const same = toolsSurfaceDriftOf(home, "aaaa1111");
        expect(same.changed).toBe(false);
        expect(same.previous?.hash).toBe("aaaa1111");

        const diff = toolsSurfaceDriftOf(home, "bbbb2222");
        expect(diff.changed).toBe(true);
        expect(diff.previous?.at).toBe("2026-11-05T10:00:00.000+0800");
        // 落盘是 yaml：版本位要在，老 reader 才认
        expect(readFileSync(toolsSurfaceFile(home), "utf-8")).toContain(`version: ${TOOLS_SURFACE_VERSION}`);
    });

    it("③ 启动口径 = 真发快照口径（同一份 buildTools 的 JSON 字节）", () => {
        const cwd = mkdtempSync(join(tmpdir(), "diy-tools-watch-cwd-"));
        try {
            const wired = sha256Hex(JSON.stringify(buildTools(cwd, DEFAULT_LIMITS, "")));
            expect(currentToolsSurfaceHash()).toBe(wired);
            // 工具面不依赖 cwd（golden 也钉了这条：启动时懒得知道谁是谁的任务，就靠它成立）
            expect(currentToolsSurfaceHash(cwd)).toBe(wired);
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
