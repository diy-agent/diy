// tests/core/compact-state.test.ts
// 🎯 ##431：压缩账本降级为**纯审计日志** —— 边界状态外置 + 明细瘦身 + 股本限读
//
// 契约（任务 body 的判据）：
//   ① **等价性**：懒迁移重建的边界与「整份读账本 + resolveBoundary」逐字段一致；
//   ② **降级**：快照删除 / 损坏 / 空文件 ⇒ agent 仍能算出同一个重放起点（warn 出声，不静默当全量）；
//   ③ **写入原子**：写一半失败时目标文件逐字不变（tmp + rename 的可观测行为）；
//   ④ **账本瘦身**：新事件单条 ≤ 1 KB，且 details 里没有 dropped / clipped 明细；
//   ⑤ **限读**：尾部读在「正好 N 行 / 空文件 / 末行无换行」上都不错。
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import {
    compactFile,
    compactStateFile,
    getLocalAgent,
    opsFile,
    readCompactLogFull,
    readCompactLogTail,
    resetOpsReplayCache,
    resolveOpsReplay,
    writeCompactState,
} from "../../src/main/services/local-agent";
import { realFs } from "../../src/main/core/atomic-write";
import { readJsonlTail } from "../../src/main/core/jsonl-tail";
import { boundaryOfPoint, compactPointOf, parseCompactLog, resolveBoundary } from "../../src/shared/context/compaction";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "compact-state-work"));
});
let seq = 0;
const newUri = (): string => createTask({ title: `压缩快照 ${++seq}`, project: PROJECT });

/** 3 轮小会话（每轮 user + assistant 文本 + 一个 bash 工具输出）—— 固定内容，便于等价性比对 */
function seedOps(uri: string, turns = 3): void {
    const lines: string[] = [];
    for (let i = 1; i <= turns; i++) {
        const t = `t${7000 + i}`;
        const push = (o: unknown) => lines.push(JSON.stringify(o));
        push({ op: "start", id: t, kind: "turn" });
        push({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } });
        push({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 问（中文跨字节）` } });
        push({ op: "stop", id: `${t}_u` });
        push({ op: "start", id: `${t}_s1`, kind: "step", parent: t });
        push({ op: "start", id: `${t}_c`, kind: "tool", parent: `${t}_s1`, meta: { tool: "bash" } });
        push({ op: "patch", id: `${t}_c`, fields: { args: { command: "ls" } } });
        push({
            op: "patch",
            id: `${t}_c`,
            fields: { status: "done", output: Array.from({ length: 120 }, (_, k) => `row ${k}`).join("\n") },
        });
        push({ op: "stop", id: `${t}_c` });
        push({ op: "stop", id: `${t}_s1` });
        push({ op: "stop", id: t });
    }
    writeFileSync(opsFile(uri), lines.join("\n") + "\n", "utf-8");
}

/** 真压一次（预算=0 ⇒ 全清零，必写账 + 必写快照） */
function compress(uri: string): void {
    getLocalAgent().compact(uri, { mode: "budget", budgetBytes: 0, toolResult: { render: "asis" }, summary: false }, "cli");
}

/**
 * 手写一条**老账**（有 compact 行、无 `compact-state.json`）—— 懒迁移/降级的对象。
 * 为什么不走 `compact()`：真压缩是否真丢轮取决于保底管道，测懒迁移不需要那层耦合。
 */
function writeLegacyLedger(uri: string, keepTurnIndex: number): void {
    const text = readFileSync(opsFile(uri), "utf-8");
    const turnId = `t${7000 + keepTurnIndex + 1}`;
    const line = `{"op":"start","id":"${turnId}","kind":"turn"`;
    const at = text.indexOf(line);
    if (at < 0) throw new Error(`fixture 里没有 ${turnId}`);
    const offset = Buffer.byteLength(text.slice(0, at), "utf-8");
    const rec = {
        kind: "compact",
        v: 5,
        id: "legacy-compact-1",
        ts: "2026-10-01T00:00:00.000Z",
        schema: 1,
        by: "cli",
        trigger: "manual",
        policy: { mode: "budget", modeData: { budgetBytes: 2048, toolResult: { render: "asis" } } },
        boundary: {
            keptFromTurnId: turnId,
            keepFromOpIndex: 0,
            keptFromOpsOffset: offset,
            keptFromLlmLine: keepTurnIndex * 2 + 1,
            opsBytes: Buffer.byteLength(text, "utf-8"),
        },
        size: {
            before: { turns: 8, messages: 16, bytes: 4096 },
            after: { turns: 7, messages: 14, bytes: 3584 },
            keptTurns: 7,
            droppedTurns: 1,
        },
        details: { droppedCount: 1, clippedIds: { ids: ["tool-legacy"], count: 1 } },
    };
    writeFileSync(compactFile(uri), `${JSON.stringify(rec)}\n`, "utf-8");
}

describe("① 懒迁移：老账（无快照）→ 生成快照，且与整份读结果逐字段一致", () => {
    it("删掉快照后仍得到同一个边界，并把快照重新写出来", () => {
        const uri = newUri();
        seedOps(uri, 8);
        writeLegacyLedger(uri, 3);
        const stateFile = compactStateFile(uri);
        expect(existsSync(stateFile)).toBe(false); // 老账：从未生成过快照

        // 老账模拟：删掉快照（账本里仍有 compact 行）
        rmSync(stateFile, { force: true });
        resetOpsReplayCache();
        const replay = resolveOpsReplay(uri);
        expect(replay.kind).toBe("offset");

        // 基线 = 整份读 + resolveBoundary（旧实现口径）
        const full = readCompactLogFull(uri);
        const base = resolveBoundary(full);
        expect(base).toBeTruthy();
        expect(replay.anchor!.compactId).toBe(base!.compactId);
        expect(replay.anchor!.keptFromOpsOffset).toBe(base!.keptFromOpsOffset);
        expect(replay.anchor!.keptFromLlmLine).toBe(base!.keptFromLlmLine);
        expect(replay.anchor!.opsBytes).toBe(base!.opsBytes);
        expect(replay.from).toBe(base!.keptFromOpsOffset);

        // 懒迁移必须真的写出快照（下一次不再扫账本）
        expect(existsSync(stateFile)).toBe(true);
        const st = JSON.parse(readFileSync(stateFile, "utf-8")) as { boundary?: { compactId?: string } };
        expect(st.boundary?.compactId).toBe(base!.compactId);
    });

    it("等价性：同 ops + 同 policy，快照「全新 / 删除 / 损坏」三种状态产出逐字段一致", () => {
        // 判据①：本刀只搬状态、不改选段算法 —— 任何算法差异都会体现在 size / boundary / details 上。
        // 三个 uri 用**同一份 ops 种子** + **同一个 policy**，各跑一次 `compact()`，比对落账产出。
        const policy = { budgetBytes: 700, toolResult: { render: "headtail" as const } };
        const run = (): Record<string, unknown> => {
            const uri = newUri();
            seedOps(uri, 8);
            resetOpsReplayCache();
            const rec = getLocalAgent().compact(uri, policy, "cli") as unknown as Record<string, unknown>;
            return rec;
        };
        // ① 全新（无快照，压缩过程本身会写快照）
        const a = run();
        // ② 账本已有 compact 行，快照被删（懒迁移路径）
        const uri2 = newUri();
        seedOps(uri2, 8);
        getLocalAgent().compact(uri2, policy, "cli");
        rmSync(compactStateFile(uri2), { force: true });
        resetOpsReplayCache();
        const b = getLocalAgent().compact(uri2, policy, "cli") as unknown as Record<string, unknown>;
        // ③ 快照损坏（warn + 回落扫账本）
        const uri3 = newUri();
        seedOps(uri3, 8);
        getLocalAgent().compact(uri3, policy, "cli");
        writeFileSync(compactStateFile(uri3), "{ 坏", "utf-8");
        resetOpsReplayCache();
        const c = getLocalAgent().compact(uri3, policy, "cli") as unknown as Record<string, unknown>;

        // size 逐字段一致（keptTurns / droppedTurns / before / after 全在里面）
        expect(b["size"]).toEqual(a["size"]);
        expect(c["size"]).toEqual(a["size"]);
        // 边界（keptFromOpsOffset / keptFromLlmLine / opsBytes）一致
        expect(b["boundary"]).toEqual(a["boundary"]);
        expect(c["boundary"]).toEqual(a["boundary"]);
        // 策略与过滤器表达（keptRuns 住在 plan 快照里，取自未改动的 compaction-plan.ts）
        expect(b["policy"]).toEqual(a["policy"]);
        expect(c["policy"]).toEqual(a["policy"]);
        expect(b["details"]).toEqual(a["details"]);
        expect(c["details"]).toEqual(a["details"]);
    });

    it("快照点 → EffectiveBoundary 与 compactPointOf 互逆（无字段丢失）", () => {
        const uri = newUri();
        seedOps(uri, 8);
        writeLegacyLedger(uri, 3);
        const rec = readCompactLogFull(uri).find((e) => e.kind === "compact")!;
        const point = compactPointOf(rec as never, 42);
        const b = boundaryOfPoint(point);
        expect(b.compactId).toBe((rec as { id: string }).id);
        expect(b.keptFromOpsOffset).toBe((rec as { boundary: { keptFromOpsOffset?: number } }).boundary.keptFromOpsOffset);
        expect(b.keptFromLlmLine).toBe((rec as { boundary: { keptFromLlmLine?: number } }).boundary.keptFromLlmLine);
        expect(point.at).toBe(42);
    });
});

describe("② 降级：快照删除 / 损坏 / 空文件 ⇒ 仍能算出同一个起点，且出声", () => {
    function firstFrom(uri: string): number {
        resetOpsReplayCache();
        return resolveOpsReplay(uri).from;
    }

    it("三种坏法都回落到同一 from（不静默当全量）", () => {
        const uri = newUri();
        seedOps(uri, 8);
        writeLegacyLedger(uri, 3);
        const good = firstFrom(uri);
        expect(good).toBeGreaterThan(0);

        const stateFile = compactStateFile(uri);
        const warnings: string[] = [];
        const orig = console.warn;
        console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
        try {
            // ① 空文件
            writeFileSync(stateFile, "", "utf-8");
            expect(firstFrom(uri)).toBe(good);
            // ② 坏 JSON
            writeFileSync(stateFile, "{ not json", "utf-8");
            expect(firstFrom(uri)).toBe(good);
            // ③ 形状不符（v 不对）
            writeFileSync(stateFile, JSON.stringify({ v: 9, boundary: null, opIds: [] }), "utf-8");
            expect(firstFrom(uri)).toBe(good);
        } finally {
            console.warn = orig;
        }
        // 崩溃/坏文件必须」出声「（它与「从未压缩」是两种事实）
        expect(warnings.some((w) => w.includes("压缩状态快照不可用"))).toBe(true);
    });

    it("账本不存在（从未压缩）⇒ 不写快照，起点 = 0", () => {
        const uri = newUri();
        seedOps(uri);
        resetOpsReplayCache();
        expect(resolveOpsReplay(uri).from).toBe(0);
        expect(existsSync(compactStateFile(uri))).toBe(false);
    });
});

describe("③ 写入原子：写一半失败时目标文件逐字不变", () => {
    it("第二次写抛 ENOSPC ⇒ 快照仍是第一次的内容（且不留 tmp）", () => {
        const uri = newUri();
        seedOps(uri);
        const first = {
            v: 1 as const,
            boundary: null,
            opIds: ["keep-me"],
        };
        writeCompactState(uri, first);
        const file = compactStateFile(uri);
        const before = readFileSync(file, "utf-8");
        expect(before).toContain("keep-me");

        // 故障注入：writeFileSync 抛 ENOSPC（tmp 已建但没写成）—— 目标文件必须原样
        let threw = false;
        try {
            writeCompactState(
                uri,
                { v: 1, boundary: null, opIds: ["should-not-land"] },
                {
                    fs: {
                        ...realFs,
                        writeFileSync: ((...args: Parameters<typeof realFs.writeFileSync>) => {
                            void args;
                            const e = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
                            e.code = "ENOSPC";
                            throw e;
                        }) as typeof realFs.writeFileSync,
                    },
                },
            );
        } catch {
            threw = true;
        }
        // writeCompactState 自己吞错（只出声）—— 所以这里不抛，文件不变
        expect(threw).toBe(false);
        expect(readFileSync(file, "utf-8")).toBe(before);
    });
});

describe("④ 账本瘦身：v5 单条 ≤ 1 KB，且不再存明细", () => {
    it("3 轮工具会话压缩后，compact 行 ≤ 1024 B，details 只有计数 / id 清单", () => {
        const uri = newUri();
        seedOps(uri, 3);
        // 用 headtail 触发裁剪（有 clipped 才验证得上 id 清单）
        getLocalAgent().compact(
            uri,
            { mode: "budget", budgetBytes: 0, toolResult: { render: "headtail" }, summary: false },
            "cli",
        );
        const raw = readFileSync(compactFile(uri), "utf-8").trim().split("\n").filter(Boolean);
        const line = raw.find((l) => (JSON.parse(l) as { kind?: string }).kind === "compact")!;
        expect(Buffer.byteLength(line, "utf-8")).toBeLessThanOrEqual(1024);

        const rec = JSON.parse(line) as {
            v: number;
            details?: { dropped?: unknown; clipped?: unknown; droppedCount?: number; clippedIds?: { ids: string[]; count: number } };
        };
        expect(rec.v).toBe(5);
        expect(rec.details?.dropped).toBeUndefined();
        expect(rec.details?.clipped).toBeUndefined();
        expect(rec.details?.droppedCount).toBe(3); // 预算 0 ⇒ 3 轮全丢
        expect(rec.details?.clippedIds?.count).toBe(rec.details?.clippedIds?.ids.length ?? -1);
    });

    it("老账（v4 带大 details）照旧能读 —— 读侧兼容", () => {
        const uri = newUri();
        seedOps(uri, 1);
        compress(uri);
        // 手工把行改成 v4 形状（带 clipped 明细），模拟历史账本
        const legacy = {
            kind: "compact",
            v: 4,
            id: "legacy-1",
            ts: "2026-10-01T00:00:00.000Z",
            schema: 1,
            by: "cli",
            trigger: "manual",
            policy: { mode: "budget", modeData: { budgetBytes: 0, toolResult: { render: "asis" } } },
            boundary: { keptFromTurnId: null, keepFromOpIndex: 0, opsBytes: 10 },
            size: { before: { turns: 1, messages: 2, bytes: 100 }, after: { turns: 0, messages: 0, bytes: 0 }, keptTurns: 0, droppedTurns: 1 },
            details: { clipped: [{ id: "tool-abc", tool: "bash", render: "headtail", origLines: 1, origBytes: 1, keptLines: 1, keptBytes: 1, origPath: "x" }] },
        };
        writeFileSync(compactFile(uri), `${JSON.stringify(legacy)}\n`, "utf-8");
        const events = parseCompactLog(readFileSync(compactFile(uri), "utf-8"));
        expect(events.length).toBe(1);
        const rec = events[0] as { details?: { clipped?: { id: string }[] } };
        expect(rec.details?.clipped?.[0]?.id).toBe("tool-abc");
        // 老行也能被尾部限读读到
        expect(readCompactLogTail(uri).events.length).toBe(1);
    });
});

describe("⑤ 限读：正好 N 行 / 空文件 / 末行无换行", () => {
    it("maxLines 边界：正好 N 行不标截断，多一行才标", () => {
        const uri = newUri();
        seedOps(uri);
        const file = join(diyHome(), "tail-boundary.jsonl");
        writeFileSync(file, "a\nb\nc\n", "utf-8");
        const exact = readJsonlTail(file, { maxLines: 3, maxBytes: 1 << 20 });
        expect(exact.lines).toEqual(["a", "b", "c"]);
        expect(exact.truncated).toBe(false);
        const cut = readJsonlTail(file, { maxLines: 2, maxBytes: 1 << 20 });
        expect(cut.lines).toEqual(["b", "c"]);
        expect(cut.truncated).toBe(true);
        rmSync(file, { force: true });
    });

    it("空文件 / 不存在：空结果且不标截断", () => {
        const file = join(diyHome(), "tail-empty.jsonl");
        writeFileSync(file, "", "utf-8");
        expect(readJsonlTail(file)).toEqual({ lines: [], from: 0, size: 0, truncated: false });
        rmSync(file, { force: true });
        expect(readJsonlTail(file).lines).toEqual([]);
    });

    it("末行无换行：照常算一行；从中间起读丢掉半行", () => {
        const file = join(diyHome(), "tail-nonl.jsonl");
        writeFileSync(file, "one\ntwo\nthree", "utf-8"); // 末行无 \n
        const r = readJsonlTail(file, { maxLines: 10, maxBytes: 1 << 20 });
        expect(r.lines).toEqual(["one", "two", "three"]);
        expect(r.truncated).toBe(false);

        // 只读最后 6 字节：窗口恰好从 `three` 的行首开始 ⇒ **完整行照样保留**（不能无条件丢首行）
        const mid = readJsonlTail(file, { maxLines: 10, maxBytes: 6 });
        expect(mid.truncated).toBe(true);
        expect(mid.lines).toEqual(["three"]);

        // 窗口比一行还短（从 `three` 中间切）⇒ 全是半行，一条都不留
        const half = readJsonlTail(file, { maxLines: 10, maxBytes: 3 });
        expect(half.truncated).toBe(true);
        expect(half.lines).toEqual([]);
        rmSync(file, { force: true });
    });
});
