// tests/core/context-stats.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 节点变更统计：回答"用了几天，某节点变了几次"（划分位置的判据）。
//
// 这份数据要**长期留**（跨天、跨任务累计），所以口径必须稳：
// 首轮算不算变化、变化率的分母是什么、排序按什么 —— 都在这里锁住。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    changedPaths,
    dropBaselineChanges,
    statFromStep,
    summarizeStats,
    type ContextStatRecord,
} from "../../src/shared/context/stats";
import { appendContextStat, contextStatsFile, readContextStats } from "../../src/main/core/context-stats";
import type { DeliveryStepRecord } from "../../src/shared/context/steps";

const rec = (ts: string, changed: string[], taskUri = "projects/1/tasks/1"): ContextStatRecord => ({
    ts,
    taskUri,
    turnId: `t-${ts}`,
    changed,
});

describe("changedPaths：变化路径", () => {
    it("★ 首轮（无上一轮）→ **不算变化**（没有基线就谈不上变化，RV-15）", () => {
        // 曾写成"全部存在的 path 算变化" → 每个任务首轮把 41 个 path 全记成变化，
        // 从不变过的 diy/guard/rules 会显示成"变了 39 次 · 7.2%"（把用户往反方向带）。
        expect(changedPaths(null, { b: "2", a: "1" })).toEqual([]);
    });

    it("值变算变化；值同不算", () => {
        expect(changedPaths({ a: "1", b: "2" }, { a: "1", b: "3" })).toEqual(["b"]);
        expect(changedPaths({ a: "1" }, { a: "1" })).toEqual([]);
    });

    it("增（新 path）与删（消失的 path）都算变化", () => {
        expect(changedPaths({ a: "1" }, { a: "1", b: "2" })).toEqual(["b"]);
        expect(changedPaths({ a: "1", b: "2" }, { a: "1" })).toEqual(["b"]);
    });
});

describe("summarizeStats：聚合口径", () => {
    const records = [
        rec("2026-09-26T01:00:00Z", ["diy", "chain.0"]),
        rec("2026-09-26T02:00:00Z", ["chain.0"]),
        rec("2026-09-26T03:00:00Z", []),                       // 没变的一轮：计入 turns，不计入任何 path
        rec("2026-09-26T04:00:00Z", ["chain.0", "task.body"]),
    ];

    it("★ 变化率的分母是**总轮数**（含没变的轮 —— 否则只变 1 轮的节点会排到最前）", () => {
        const s = summarizeStats(records);
        expect(s.turns).toBe(4);
        const chain0 = s.paths.find((p) => p.path === "chain.0")!;
        expect(chain0.changes).toBe(3);
        expect(chain0.rate).toBeCloseTo(3 / 4);
        const diy = s.paths.find((p) => p.path === "diy")!;
        expect(diy.rate).toBeCloseTo(1 / 4);
    });

    it("排序按**变化次数**降序（并列按路径字典序 → 输出稳定）", () => {
        const s = summarizeStats(records);
        // chain.0=3 次；diy 与 task.body 都是 1 次 → 并列按路径字典序（diy 在前）
        expect(s.paths.map((p) => p.path)).toEqual(["chain.0", "diy", "task.body"]);
    });

    it("不变过的节点不出现（不需要提示用户移位置）", () => {
        const s = summarizeStats([rec("t1", ["a"]), rec("t2", ["a"])]);
        expect(s.paths.map((p) => p.path)).toEqual(["a"]);
    });

    it("lastChanged 是最后一次变化的时刻；turns 是变化的轮次序号（1 基）", () => {
        const s = summarizeStats(records);
        const chain0 = s.paths.find((p) => p.path === "chain.0")!;
        expect(chain0.lastChanged).toBe("2026-09-26T04:00:00Z");
        expect(chain0.turns).toEqual([1, 2, 4]);
    });

    it("时间范围取最早/最晚（供 UI 显示用了几天）", () => {
        const s = summarizeStats(records);
        expect(s.since).toBe("2026-09-26T01:00:00Z");
        expect(s.until).toBe("2026-09-26T04:00:00Z");
        expect(s.records).toBe(4);
    });

    it("taskCount = 参与的任务数（跨任务累计时让「轮数」的口径可辨）", () => {
        const s = summarizeStats([
            rec("t1", ["a"], "projects/1/tasks/1"),
            rec("t2", ["a"], "projects/1/tasks/1"),
            rec("t3", ["b"], "projects/1/tasks/2"),
        ]);
        expect(s.taskCount).toBe(2);
        expect(summarizeStats([]).taskCount).toBe(0);
    });

    it("空输入不炸", () => {
        const s = summarizeStats([]);
        expect(s).toMatchObject({ turns: 0, records: 0, since: null, until: null, paths: [] });
    });
});

describe("statFromStep：从投递快照造统计", () => {
    const step = (hashes: Record<string, string>): DeliveryStepRecord => ({
        ts: "2026-09-26T01:00:00Z",
        turnId: "t1",
        model: "mimo-v2.6-flash",
        wireVersion: "aaaa1111",
        systemPlaces: ["diy"],
        runtimePlaces: ["task.body"],
        valueHashes: hashes,
        systemText: "…",
        runtimeText: "…",
    });

    it("带 taskUri 与变化路径", () => {
        const r = statFromStep(step({ a: "1", b: "2" }), { a: "1", b: "9" }, "projects/1/tasks/1");
        expect(r).toMatchObject({ taskUri: "projects/1/tasks/1", turnId: "t1", changed: ["b"] });
    });

    it("★ 首轮（prev=null）→ changed 为空（RV-15；真发写入路径也走这条）", () => {
        expect(statFromStep(step({ a: "1" }), null, "u").changed).toEqual([]);
    });

    it("有上一轮 → 只记真变化（首轮不掺沙子的对照）", () => {
        const r = statFromStep(step({ a: "1", b: "2" }), { a: "1", b: "2" }, "u");
        expect(r.changed).toEqual([]);
    });
});

describe("dropBaselineChanges：存量数据抹平（RV-15）", () => {
    it("每个任务的**第一条**记录的 changed 抹成 []，其余原样", () => {
        const rows = [
            rec("2026-09-26T01:00:00Z", ["diy", "guard", "task.title"], "projects/1/tasks/1"), // 首轮基线
            rec("2026-09-26T02:00:00Z", ["task.title"], "projects/1/tasks/1"),
            rec("2026-09-26T03:00:00Z", ["diy", "rules"], "projects/1/tasks/2"), // 另一任务的首轮基线
            rec("2026-09-26T04:00:00Z", ["chain"], "projects/1/tasks/1"),
        ];
        expect(dropBaselineChanges(rows).map((r) => r.changed)).toEqual([[], ["task.title"], [], ["chain"]]);
        // 不改 ts/taskUri/turnId
        expect(dropBaselineChanges(rows)[0]!.turnId).toBe(rows[0]!.turnId);
    });

    it("★ 对**新**记录（首轮 written 已是 []）是恒等变换", () => {
        const rows = [
            rec("2026-09-26T01:00:00Z", [], "projects/1/tasks/1"),
            rec("2026-09-26T02:00:00Z", ["chain"], "projects/1/tasks/1"),
        ];
        expect(dropBaselineChanges(rows)).toEqual(rows);
    });

    it("★ 抹平后：从不变过的节点不再上榜，变化率里也不再有首轮沙子（RV-15 的用户可见效果）", () => {
        // 3 个任务各 1 轮基线（都记了全部 path）+ 1 轮真变化
        const legacy = [
            rec("2026-09-26T01:00:00Z", ["diy", "task.title"], "projects/1/tasks/1"),
            rec("2026-09-26T02:00:00Z", ["task.title"], "projects/1/tasks/1"),
            rec("2026-09-26T03:00:00Z", ["diy", "task.title"], "projects/1/tasks/2"),
        ];
        const s = summarizeStats(dropBaselineChanges(legacy));
        expect(s.paths.find((p) => p.path === "diy")).toBeUndefined(); // 39 次变 0 次 → 不显示
        expect(s.paths.find((p) => p.path === "task.title")!.changes).toBe(1); // 只剩真变化
        expect(s.turns).toBe(3); // 分母仍是全部真发轮（含没变的轮）
        expect(s.taskCount).toBe(2);
    });
});

describe("文件层：context-stats.jsonl（按项目累计）", () => {
    const dir = mkdtempSync(join(tmpdir(), "diy-ctx-stats-"));
    process.on("exit", () => {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* 忽略 */
        }
    });

    it("缺失文件 → 空（还没有数据）", () => {
        expect(readContextStats(join(dir, "nope"))).toEqual([]);
    });

    it("append-only：写两条读两条（顺序保持）", () => {
        appendContextStat(dir, rec("2026-09-26T01:00:00Z", ["a"]));
        appendContextStat(dir, rec("2026-09-26T02:00:00Z", ["b"]));
        const rows = readContextStats(dir);
        expect(rows.map((r) => r.ts)).toEqual(["2026-09-26T01:00:00Z", "2026-09-26T02:00:00Z"]);
        expect(rows[0]!.changed).toEqual(["a"]);
    });

    it("坏行跳过不污染整份（长期文件会被手改/半行）", () => {
        const fp = contextStatsFile(dir);
        writeFileSync(fp, '{"ts":"t1","taskUri":"u","turnId":"x","changed":["a"]}\n{bad json\n');
        const rows = readContextStats(dir);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.changed).toEqual(["a"]);
    });

    it("跨任务累计在同一个文件里（按项目）", () => {
        appendContextStat(dir, rec("2026-09-26T03:00:00Z", ["c"], "projects/1/tasks/9"));
        const rows = readContextStats(dir);
        expect(new Set(rows.map((r) => r.taskUri)).size).toBeGreaterThan(1);
    });
});
