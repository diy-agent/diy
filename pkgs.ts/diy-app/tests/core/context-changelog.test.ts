// tests/core/context-changelog.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 变更历史（##310 二版）：「哪一步、哪个变量、从什么变成了什么」。
//
// 口径必须稳（这份数据要长期留）：
//   · **原子单元** = 变更单位：`chain` 整体一条，**不下钻** `chain.0.content`（下钻会谎报半棵树变了）；
//   · **有变才写**；首条 = `baseline`（整棵树）；
//   · **before/after 自带**（落盘自包含）→ 读侧不回放。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    changesOf,
    entryToRows,
    foldCtxTree,
    summarizeValue,
    type CtxLogEntry,
    type CtxSnapshot,
} from "../../src/shared/context/changelog";
import {
    appendCtxLog,
    ctxLogFile,
    hasV2CtxLog,
    lastCtxLogSeq,
    readCtxLog,
    readCtxLogEntries,
} from "../../src/main/core/context-changelog";
import type { ContextTreeState } from "../../src/shared/context/types";

const stateOf = (values: Record<string, unknown>): ContextTreeState => ({
    values,
    renderers: {},
    places: [],
    placement: {},
    wireVersion: "w1",
    placementEpoch: 0,
});
const snap = (values: Record<string, unknown>, hashes: Record<string, string>): CtxSnapshot => ({
    tree: stateOf(values),
    valueHashes: hashes,
});

describe("summarizeValue：值 → 一行摘要", () => {
    it("短标量给原值（不标截断）", () => {
        expect(summarizeValue("running")).toEqual({ text: "running", truncated: false });
        expect(summarizeValue(42)).toEqual({ text: "42", truncated: false });
        expect(summarizeValue(true)).toEqual({ text: "true", truncated: false });
        expect(summarizeValue(null)).toEqual({ text: "null", truncated: false });
    });
    it("长文本截断并标 truncated（全文在 steps 快照里）", () => {
        const long = "很长的正文".repeat(40);
        const s = summarizeValue(long);
        expect(s.truncated).toBe(true);
        expect(s.text.endsWith("…")).toBe(true);
        expect(s.text.length).toBeLessThanOrEqual(73);
    });
    it("数组给「计数 + 元素标签」，元素有 path 时用 ~ 缩写（chain 一眼认出是哪层）", () => {
        const s = summarizeValue([
            { path: "/Users/ccc/AGENTS.md", scope: "/Users/ccc" },
            { path: "/Users/ccc/git/AGENTS.md", scope: "/Users/ccc/git" },
        ]);
        expect(s.truncated).toBe(true);
        expect(s.text.startsWith("[2 项]")).toBe(true);
        expect(s.text).toContain("~/AGENTS.md");
        expect(s.text).toContain("~/git/AGENTS.md");
    });
    it("对象给「键数 + 前几个键」", () => {
        const s = summarizeValue({ cli: "/x/diy", home: "/Users/ccc/.diy" });
        expect(s.text).toContain("{2 键}");
        expect(s.text).toContain("cli: /x/diy");
    });
});

describe("changesOf：原子单元 diff（不下钻数组）", () => {
    const units = ["chain", "task.title", "task.body", "skills"];
    it("★ chain 变 → 一条 `chain`（**不是** chain.0.content）", () => {
        const prev = snap({ chain: [{ path: "/a" }] }, { chain: "h1" });
        const next = snap({ chain: [{ path: "/a" }, { path: "/b" }] }, { chain: "h2" });
        const changes = changesOf(prev, next, units);
        expect(changes.map((c) => c.path)).toEqual(["chain"]);
        expect(changes[0]!.type).toBe("update");
        expect(changes[0]!.data.after).toContain("[2 项]");
        expect(changes[0]!.data.truncated).toBe(true);
    });
    it("值 hash 相同 → 不是变更（有变才写）", () => {
        const a = snap({ task: { title: "t" } }, { "task.title": "h" });
        expect(changesOf(a, a, units)).toEqual([]);
    });
    it("新增 = add（before 为 null）、消失 = remove（after 为 null）、值变 = update", () => {
        const prev = snap({ task: { title: "旧" }, skills: [{ name: "s" }] }, { "task.title": "h1", skills: "s1" });
        const next = snap({ task: { title: "新", body: "正文" } }, { "task.title": "h2", "task.body": "b1" });
        const changes = changesOf(prev, next, units);
        // 顺序 = 单元字典序（skills < task.body < task.title）
        expect(changes.map((c) => [c.type, c.path])).toEqual([
            ["remove", "skills"],
            ["add", "task.body"],
            ["update", "task.title"],
        ]);
        const byPath = new Map(changes.map((c) => [c.path, c]));
        expect(byPath.get("task.title")!.data).toMatchObject({ before: "旧", after: "新" });
        expect(byPath.get("task.body")!.data.before).toBeNull();
        expect(byPath.get("skills")!.data.after).toBeNull();
    });
});

describe("entryToRows：记录 → UI 行", () => {
    it("baseline 无 changes；changed 展开", () => {
        const base: CtxLogEntry = {
            seq: 0, type: "baseline", ts: "t", model: "m", wireVersion: "w",
            ref: { turnId: "t1", stepId: "t1_s1", step: 1 },
            data: { tree: stateOf({}) },
        };
        expect(entryToRows(base)).toEqual([]);
        const changed: CtxLogEntry = {
            ...base, seq: 1, type: "changed",
            data: { changes: [{ type: "update", path: "chain", data: { before: "a", after: "b", truncated: true } }] },
        };
        expect(entryToRows(changed)).toEqual([{ kind: "update", path: "chain", before: "a", after: "b" }]);
    });
});

describe("文件层：append-only + seq 续写 + 坏行出声跳过", () => {
    it("写一条读一条；seq 从末行 +1；坏行跳过不炸（观测不能阻断会话）", () => {
        const dir = mkdtempSync(join(tmpdir(), "ctxlog-"));
        const old = process.env.DIY_HOME;
        process.env.DIY_HOME = dir;
        try {
            const uri = "projects/1/tasks/1";
            expect(hasV2CtxLog(uri)).toBe(false);
            expect(lastCtxLogSeq(uri)).toBe(-1);
            const mk = (seq: number, type: "baseline" | "changed"): CtxLogEntry => ({
                seq, type, ts: "t", model: "m", wireVersion: "w",
                ref: { turnId: "t1", stepId: `t1_s${seq + 1}`, step: seq + 1 },
                data: type === "baseline" ? { tree: stateOf({}) } : { changes: [] },
            });
            appendCtxLog(uri, mk(0, "baseline"));
            // 坏行（半截 JSON）：读侧跳过，好行照读
            writeFileSync(ctxLogFile(uri), "{ 这不合法\n", { flag: "a" });
            appendCtxLog(uri, mk(1, "changed"));
            expect(readCtxLog(uri).length).toBe(2);
            expect(readCtxLogEntries(uri).map((e) => e.seq)).toEqual([0, 1]);
            expect(lastCtxLogSeq(uri)).toBe(1);
            expect(hasV2CtxLog(uri)).toBe(true);
        } finally {
            if (old === undefined) delete process.env.DIY_HOME;
            else process.env.DIY_HOME = old;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // 起点的判据是「有二版记录」，不是「文件非空」—— 老文件全是老格式时读侧只会走降级视图，
    // 补一条二版 baseline 才切得到新格式。曾经用 readCtxLog().length > 0：老任务升级后永远
    // 补不上起点，UI 永远停在「降级视图」。
    it("★ 只有老格式记录 → 仍算「没有起点」（该补 baseline）", () => {
        const dir = mkdtempSync(join(tmpdir(), "ctxlog-legacy-"));
        const old = process.env.DIY_HOME;
        process.env.DIY_HOME = dir;
        try {
            const uri = "projects/1/tasks/1";
            const legacy = {
                ts: "t", turnId: "t1", model: "m", wireVersion: "w",
                ops: [{ kind: "update", path: "chain", preview: "…" }],
            };
            writeFileSync(ctxLogFile(uri), `${JSON.stringify(legacy)}\n`, "utf-8");
            expect(readCtxLog(uri).length).toBe(1); // 文件不空
            expect(hasV2CtxLog(uri)).toBe(false); // 但没有起点
            appendCtxLog(uri, {
                seq: 0, type: "baseline", ts: "t", model: "m", wireVersion: "w",
                ref: { turnId: "t2", stepId: "t2_s1", step: 1 },
                data: { tree: stateOf({}) },
            });
            expect(hasV2CtxLog(uri)).toBe(true);
        } finally {
            if (old === undefined) delete process.env.DIY_HOME;
            else process.env.DIY_HOME = old;
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("foldCtxTree：从变更日志重放「上一次真发时的值树」（跨重启播种用）", () => {
    const base = (tree: ContextTreeState, seq: number): CtxLogEntry => ({
        seq, type: "baseline", ts: "t", model: "m", wireVersion: "w1",
        ref: { turnId: `t${seq}`, stepId: `t${seq}_s1`, step: 1 },
        data: { tree },
    });
    const changed = (seq: number, changes: CtxLogEntry extends never ? never : Array<{ type: "update" | "add" | "remove"; path: string; data: { before: string | null; after: string | null } }>): CtxLogEntry => ({
        seq, type: "changed", ts: "t", model: "m", wireVersion: "w1",
        ref: { turnId: `t${seq}`, stepId: `t${seq}_s1`, step: 1 },
        data: { changes },
    });

    it("没有 baseline（老任务）→ null（调用方应退回「不播种」，不拿当前值冒充旧值）", () => {
        expect(foldCtxTree([])).toBeNull();
        expect(foldCtxTree([changed(0, [])])).toBeNull();
    });

    it("baseline 的全量树 + 后续 changed 的 after → 上一次真发的值", () => {
        const recs = [
            base(stateOf({ task: { title: "旧标题" }, chain: [{ path: "a" }] }), 0),
            changed(1, [
                { type: "update", path: "task", data: { before: "旧标题", after: "新标题" } },
                { type: "remove", path: "chain", data: { before: "[1 项]", after: null } },
            ]),
        ];
        const tree = foldCtxTree(recs)!;
        // ⚠️ 重放是**单元级**：`changed` 里只有摘要，所以整个单元被摘要串替换（不是深合并）。
        // 该树只服务 before **摘要**（`summarizeValue` 再过一遍），全文在 steps.jsonl。
        expect(tree.values["task"]).toBe("新标题");
        expect(tree.values["chain"]).toBeUndefined();
    });

    it("重置（第二条 baseline）从**最后一条**起算，不叠加旧段", () => {
        const recs = [
            base(stateOf({ task: { title: "第一段" } }), 0),
            changed(1, [{ type: "update", path: "task", data: { before: "第一段", after: "第一段改" } }]),
            base(stateOf({ task: { title: "第二段起点" } }), 2),
        ];
        // 第二条 baseline 是**全量树**（这里是真值），故起点之后没 changed → 原样返回
        expect(foldCtxTree(recs)!.values["task"]).toEqual({ title: "第二段起点" });
    });
});
