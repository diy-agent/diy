// ##406 刀 3：单条工具结果的**不可绕过硬顶**。
//
// 病灶（实测）：缺省 plan 第一级 `steps · must:true · clip:full` 让最近几步「逐字保真」，
// 而 `full` 原先直接原样返回 ⇒ 投递层 50 KB 的封顶在**历史重放**时被绕过，
// ##401 的请求从 282 KB 一步跳到 4.95 MB（`~/.diy/log/network/2026-10-21.jsonl`）。
import { describe, expect, it } from "vitest";
import { clipToolResult, HARD_MAX_TOOL_RESULT_BYTES, toToolResultPolicy, type ToolResultPolicy } from "@diy/compact/compaction";
import { parseCutMarkers } from "@diy/context/format/cut-marker";

/** 缺省 plan 的保底级 `clip:{type:"full"}` —— 经 toToolResultPolicy 映射成 `asis`（原样不裁） */
const FULL: ToolResultPolicy = toToolResultPolicy({ type: "full" });
const ASIS: ToolResultPolicy = { render: "asis" };
const CALLPATH: ToolResultPolicy = { render: "callpath" };
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("clipToolResult 单条硬顶（##406）", () => {
    it("4.95 MB + clip:full（= asis）⇒ 结果 ≤ 硬顶，且给出「中间省略」marker", () => {
        const huge = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${"x".repeat(200)}`).join("\n");
        expect(bytes(huge)).toBeGreaterThan(4_000_000);
        const r = clipToolResult(huge, FULL, { origPath: "toolout/abc.txt" });
        expect(r.clipped).toBe(true);
        expect(bytes(r.text)).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_BYTES);
        const m = parseCutMarkers(r.text).at(0)!;
        expect(m).toMatchObject({ by: "tool-output", scope: "wire", why: "budget", unit: "lines" });
        expect(m.total).toBeGreaterThan(m.kept);
        expect(m.resume).toBe("toolout/abc.txt"); // 指针仍要给出
        expect(r.origBytes).toBe(bytes(huge)); // 原始体量仍如实报
    });

    it("正常体量（50 KB）+ clip:full（= asis）⇒ 逐字符不变（硬顶不误伤）", () => {
        const ok = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
        expect(bytes(ok)).toBeLessThan(HARD_MAX_TOOL_RESULT_BYTES);
        const r = clipToolResult(ok, FULL);
        expect(r.clipped).toBe(false);
        expect(r.text).toBe(ok);
    });

    it("asis 也翻不过硬顶（用户显式选了「不裁」也不例外）", () => {
        const big = "y".repeat(200_000);
        const r = clipToolResult(big, ASIS);
        expect(r.clipped).toBe(true);
        expect(bytes(r.text)).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_BYTES);
    });

    it("单行巨长（无换行，base64 那种）⇒ 也收在硬顶内", () => {
        const oneLine = "A".repeat(5_000_000);
        const r = clipToolResult(oneLine, FULL);
        expect(r.clipped).toBe(true);
        expect(bytes(r.text)).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_BYTES);
    });

    it("callpath 不受影响（本来就只留调用，远小于硬顶）", () => {
        const big = "z".repeat(500_000);
        const r = clipToolResult(big, CALLPATH);
        expect(r.clipped).toBe(true);
        expect(parseCutMarkers(r.text).at(0)).toMatchObject({ by: "tool-result-callpath", scope: "wire", kept: 0 });
        expect(bytes(r.text)).toBeLessThan(1000);
    });
});
