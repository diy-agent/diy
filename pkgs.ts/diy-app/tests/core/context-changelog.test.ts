// tests/core/context-changelog.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 变更历史：「哪一轮、哪个变量、从什么变成了什么」。
//
// 这份数据要**长期留**（小、append-only），口径必须稳：
//   · 基线（首轮）是**起点**不是"变了 n 次"；
//   · 老→新由**回放**得出（落盘只存改成了什么）—— 回不动就是这份日志没用；
//   · 0 变更的轮也要留（"这轮什么都没变"是事实：缓存没被砸）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { changedOf, foldCtxLog, opsFromHashes, type CtxLogRecord } from "../../src/shared/context/changelog";
import { appendCtxLog, ctxLogFile, readCtxLog } from "../../src/main/core/context-changelog";

const base = { ts: "2026-10-01T00:00:00.000Z", turnId: "t1", model: "m", wireVersion: "w1" };

describe("opsFromHashes：值 hash 差 → 变更事件", () => {
    it("★ 首轮（无上一轮）= 基线：全部算 add，不是'变了 n 次'", () => {
        const ops = opsFromHashes(null, { b: "2", a: "1" });
        expect(ops.map((o) => [o.kind, o.path])).toEqual([
            ["add", "a"],
            ["add", "b"],
        ]);
        // 基线也要值预览（没有它，回放的起点就是空的）
        expect(opsFromHashes(null, { a: "1" }, () => "preview-A")[0]).toMatchObject({
            kind: "add",
            path: "a",
            preview: "preview-A",
        });
    });

    it("值变算 update；值同不算；新出现 add / 消失 remove（字典序稳定）", () => {
        const ops = opsFromHashes({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" }, () => "p");
        expect(ops).toEqual([
            { kind: "update", path: "b", preview: "p" },
            // 删除没有"变更后的值" → preview 必须是 null（不能编一个）
            { kind: "remove", path: "c", preview: null },
            { kind: "add", path: "d", preview: "p" },
        ]);
    });

    it("折算路径（拿不到值）也要能出事件 —— 只到 path 粒度，preview = null", () => {
        const ops = opsFromHashes({ a: "1" }, { a: "2" }, undefined);
        expect(ops).toEqual([{ kind: "update", path: "a", preview: null }]);
    });
});

describe("foldCtxLog：逐轮回放（老→新由前缀推出来）", () => {
    const records: CtxLogRecord[] = [
        { ...base, ops: [{ kind: "add", path: "a", preview: "A1" }] },
        // 0 变更的轮：留一条（"这一轮什么都没变"）
        { ...base, turnId: "t2", ops: [] },
        { ...base, turnId: "t3", ops: [{ kind: "update", path: "a", preview: "A2" }] },
        { ...base, turnId: "t4", ops: [{ kind: "remove", path: "a", preview: null }] },
        { ...base, turnId: "t5", ops: [{ kind: "add", path: "a", preview: "A3" }] },
    ];
    const turns = foldCtxLog(records);

    it("★ 轮序 = 落盘序（与真发投递快照同序）；首轮标 baseline", () => {
        expect(turns.map((t) => t.index)).toEqual([1, 2, 3, 4, 5]);
        expect(turns.map((t) => t.baseline)).toEqual([true, false, false, false, false]);
        expect(turns[1]!.changes).toEqual([]);
    });

    it("★ update 的 before 从回放里来（落盘只有 after）：A1 → A2", () => {
        expect(turns[2]!.changes).toEqual([{ kind: "update", path: "a", before: "A1", after: "A2" }]);
    });

    it("★ remove 之后 add：before = null（不是上一次的值 —— 中间确实不存在过）", () => {
        expect(turns[3]!.changes).toEqual([{ kind: "remove", path: "a", before: "A2", after: null }]);
        expect(turns[4]!.changes).toEqual([{ kind: "add", path: "a", before: null, after: "A3" }]);
    });

    it("基线轮的 before 全为 null（起点之前什么都没有）", () => {
        expect(turns[0]!.changes).toEqual([{ kind: "add", path: "a", before: null, after: "A1" }]);
    });

    it("changedOf = 该轮变化的 path（喂 sysCauses 用，与投递快照的 changed 同集）", () => {
        expect(changedOf(records[2]!)).toEqual(["a"]);
        expect(changedOf(records[1]!)).toEqual([]);
    });
});

describe("文件层：append-only + 坏行出声跳过", () => {
    it("写一条读一条；坏行跳过不炸（观测不能阻断会话）", () => {
        const dir = mkdtempSync(join(tmpdir(), "ctxlog-"));
        const old = process.env.DIY_HOME;
        process.env.DIY_HOME = dir;
        try {
            const uri = "projects/1/tasks/1";
            expect(readCtxLog(uri)).toEqual([]);
            appendCtxLog(uri, { ...base, ops: [{ kind: "add", path: "a", preview: "A1" }] });
            // 坏行（半截 JSON）：读侧跳过，好行照读
            writeFileSync(ctxLogFile(uri), "{ 这不合法\n", { flag: "a" });
            appendCtxLog(uri, { ...base, turnId: "t2", ops: [] });
            const back = readCtxLog(uri);
            expect(back.map((r) => r.turnId)).toEqual(["t1", "t2"]);
            expect(foldCtxLog(back).map((t) => t.index)).toEqual([1, 2]);
        } finally {
            if (old === undefined) delete process.env.DIY_HOME;
            else process.env.DIY_HOME = old;
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
