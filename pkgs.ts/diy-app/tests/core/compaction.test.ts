// tests/core/compaction.test.ts
// 🎯 压缩纯逻辑：策略归一 / 工具输出裁剪 / 账本边界 / 历史代切分
//
// 全部为纯函数（shared/context/compaction.ts），不起 Electron、不打网络。
// 真发落点（blocksToMessages 的投递选项）另在 local-blocks.test.ts 里验证。

import { describe, it, expect } from "vitest";
import {
    DEFAULT_HEADTAIL,
    clipToolOutput,
    estimateTokens,
    fmtBytes,
    listGenerations,
    listTurnIds,
    normalizePolicy,
    parseCompactLog,
    resolveBoundary,
    sliceOpsFromTurn,
    turnsOfGeneration,
    utf8Bytes,
    type CompactEventRecord,
    type OpLike,
} from "../../src/shared/context/compaction";

// ─── 策略归一 ────────────────────────────────────────

describe("normalizePolicy：缺省值 + 越界兜底", () => {
    it("空输入 → 全默认（保留 6 轮 / 原样 / 不摘要）", () => {
        const p = normalizePolicy(undefined);
        expect(p.keepTurns).toBe(6);
        expect(p.toolOutput).toBe("asis");
        expect(p.summary).toBe(false);
        expect(p.headtail).toEqual(DEFAULT_HEADTAIL);
    });
    it("keepTurns=0 是合法值（= 全部清零），不被当成缺失回落默认", () => {
        expect(normalizePolicy({ keepTurns: 0 }).keepTurns).toBe(0);
    });
    it("非法值逐项回落：负数 keepTurns / 未知 toolOutput / 小数取整", () => {
        const p = normalizePolicy({ keepTurns: -3, toolOutput: "nope" as never });
        expect(p.keepTurns).toBe(6);
        expect(p.toolOutput).toBe("asis");
        expect(normalizePolicy({ keepTurns: 4.9 }).keepTurns).toBe(4);
    });
    it("headtail 局部覆盖：只给 headLines，其余保持默认", () => {
        const p = normalizePolicy({ headtail: { headLines: 7 } as never });
        expect(p.headtail.headLines).toBe(7);
        expect(p.headtail.tailLines).toBe(DEFAULT_HEADTAIL.tailLines);
    });
});

// ─── 工具输出裁剪 ────────────────────────────────────

/** 造 n 行、每行 line i 的文本 */
function lines(n: number): string {
    return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
}

describe("clipToolOutput", () => {
    const pol = (toolOutput: "asis" | "headtail" | "callpath", headtail = DEFAULT_HEADTAIL) => ({
        toolOutput,
        headtail,
    });

    it("asis：逐字符返回原文", () => {
        const t = lines(1000);
        const r = clipToolOutput(t, pol("asis"));
        expect(r.clipped).toBe(false);
        expect(r.text).toBe(t);
    });

    it("headtail：未超阈值（80 行）不裁 —— 86% 的输出走这条路径", () => {
        const t = lines(50);
        const r = clipToolOutput(t, pol("headtail"));
        expect(r.clipped).toBe(false);
        expect(r.text).toBe(t);
    });

    it("headtail：超阈值 → 前 40 + marker + 后 10，标记省略行数/字节/原文路径", () => {
        const t = lines(1842);
        const r = clipToolOutput(t, pol("headtail"), { origPath: "local/toolout/x.txt" });
        expect(r.clipped).toBe(true);
        const out = r.text.split("\n");
        expect(out[0]).toBe("line 0");
        expect(out[39]).toBe("line 39");
        expect(out[40]).toContain("中间省略 1792 行");
        expect(out[40]).toContain("local/toolout/x.txt");
        expect(out[out.length - 1]).toBe("line 1841");
        expect(r.origLines).toBe(1842);
        expect(r.droppedLines).toBe(1792);
        // 头 40 + marker 1 + 尾 10
        expect(r.keptLines).toBe(51);
    });

    it("headtail：无 origPath 时 marker 不编造路径", () => {
        const r = clipToolOutput(lines(200), pol("headtail"));
        expect(r.text).toContain("完整输出已省略");
        expect(r.text).not.toContain("见 ");
    });

    it("headtail：行数没超但单行超长 → 只做单行截断，不写「中间省略」marker", () => {
        const t = `short\n${"A".repeat(500)}\nshort`;
        const r = clipToolOutput(t, pol("headtail"));
        expect(r.clipped).toBe(true);
        expect(r.droppedLines).toBe(0);
        expect(r.text).not.toContain("中间省略");
        expect(r.text).toContain("…");
        expect(r.text.split("\n")[1]!.endsWith("…")).toBe(true);
    });

    it("headtail：字节兜底（一行超长穿透 maxKeepBytes）→ 收缩到预算内", () => {
        // 一行 = 100k 字符 > 8KB 兜底
        const t = `head\n${"B".repeat(100_000)}\ntail`;
        const r = clipToolOutput(t, pol("headtail", { ...DEFAULT_HEADTAIL, maxLineChars: 1_000_000 }));
        expect(r.clipped).toBe(true);
        expect(utf8Bytes(r.text)).toBeLessThanOrEqual(DEFAULT_HEADTAIL.maxKeepBytes);
    });

    it("callpath：整段换成一句「只留调用」提示 + 原文路径", () => {
        const r = clipToolOutput(lines(300), pol("callpath"), { origPath: "local/toolout/y.txt" });
        expect(r.clipped).toBe(true);
        expect(r.text).toContain("输出已省略（只留调用）");
        expect(r.text).toContain("300 行");
        expect(r.text).toContain("local/toolout/y.txt");
        expect(r.keptLines).toBe(1);
    });

    it("空输出：任何模式都不裁（空串没有可省略的东西）", () => {
        for (const m of ["asis", "headtail", "callpath"] as const) {
            const r = clipToolOutput("", pol(m));
            expect(r.clipped).toBe(false);
            expect(r.text).toBe("");
        }
    });
});

describe("utf8Bytes / fmtBytes / estimateTokens", () => {
    it("中文按字节算（3 字节/char），不是按字符", () => {
        expect(utf8Bytes("中")).toBe(3);
        expect(utf8Bytes("abc")).toBe(3);
    });
    it("fmtBytes 单位换算", () => {
        expect(fmtBytes(512)).toBe("512 B");
        expect(fmtBytes(2048)).toBe("2 KB");
        expect(fmtBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    });
    it("estimateTokens = 字节/4（仅估算，不进计费）", () => {
        expect(estimateTokens(400)).toBe(100);
    });
});

// ─── 账本 & 边界 ─────────────────────────────────────

function compactEvent(id: string, keptFromTurnId: string | null, ts = id): CompactEventRecord {
    return {
        kind: "compact",
        v: 1,
        id,
        ts,
        by: "cli",
        policy: normalizePolicy({}),
        boundary: { keptFromTurnId, keptTurns: 2, droppedTurns: 3 },
        before: { turns: 5, messages: 10, bytes: 1000, estTokens: 250 },
        after: { turns: 2, messages: 4, bytes: 400, estTokens: 100 },
    };
}

describe("parseCompactLog / resolveBoundary", () => {
    it("坏行跳过，不连累整本账", () => {
        const good = JSON.stringify(compactEvent("a", "t2"));
        const events = parseCompactLog(`{坏行\n\n${good}\n`);
        expect(events).toHaveLength(1);
        expect(events[0]!.kind).toBe("compact");
    });

    it("无 compact → 无生效边界（= 从未压缩，全量投递）", () => {
        expect(resolveBoundary([])).toBeNull();
    });

    it("多次压缩 → 取最后一条为生效边界", () => {
        const b = resolveBoundary([compactEvent("a", "t2"), compactEvent("b", "t5")]);
        expect(b?.keptFromTurnId).toBe("t5");
        expect(b?.compactId).toBe("b");
    });

    it("undo：撤销最后一次 → 回落到上一次；撤销中间一次 → 不清掉后面的", () => {
        const evs = [
            compactEvent("a", "t1"),
            compactEvent("b", "t3"),
            compactEvent("c", "t5"),
            { kind: "undo", v: 1 as const, ref: "c", ts: "u1" } as const,
        ];
        expect(resolveBoundary(evs)?.keptFromTurnId).toBe("t3");
        const evs2 = [...evs, { kind: "undo", v: 1 as const, ref: "a", ts: "u2" } as const];
        // a 被撤销，但 b/c 仍在（c 仍被 undo，故落到 b）
        expect(resolveBoundary(evs2)?.keptFromTurnId).toBe("t3");
    });

    it("全部被 undo → 回到全量（null）", () => {
        const evs = [
            compactEvent("a", "t1"),
            { kind: "undo", v: 1 as const, ref: "a", ts: "u" } as const,
        ];
        expect(resolveBoundary(evs)).toBeNull();
    });
});

// ─── ops 切片 ────────────────────────────────────────

const OPS: OpLike[] = [
    { op: "start", id: "t1", kind: "turn" },
    { op: "stop", id: "t1" },
    { op: "start", id: "t2", kind: "turn" },
    { op: "stop", id: "t2" },
    { op: "start", id: "t3", kind: "turn" },
    { op: "stop", id: "t3" },
];

describe("sliceOpsFromTurn / listTurnIds", () => {
    it("listTurnIds 按出现序", () => {
        expect(listTurnIds(OPS)).toEqual(["t1", "t2", "t3"]);
    });
    it("从某轮起切（UI 的「当前会话」视图）", () => {
        expect(sliceOpsFromTurn(OPS, "t2").map((o) => o.id)).toEqual(["t2", "t2", "t3", "t3"]);
    });
    it("null = 全部清零（空视图）", () => {
        expect(sliceOpsFromTurn(OPS, null)).toEqual([]);
    });
    it("边界轮找不到 → 返回全量（宁可多给，不让用户面对空白会话）", () => {
        expect(sliceOpsFromTurn(OPS, "tX")).toEqual(OPS);
    });
});

// ─── 历史代 ──────────────────────────────────────────

describe("listGenerations / turnsOfGeneration", () => {
    const turns = ["t1", "t2", "t3", "t4", "t5"];

    it("无压缩 → 单代（seq 0, current, 覆盖全部轮）", () => {
        const gens = listGenerations(turns, []);
        expect(gens).toHaveLength(1);
        expect(gens[0]).toMatchObject({ seq: 0, fromTurnId: null, untilTurnId: null, current: true });
        expect(turnsOfGeneration(turns, gens[0]!)).toEqual(turns);
    });

    it("一次压缩 → 两代；上一代终点 = 下一代起点", () => {
        const gens = listGenerations(turns, [compactEvent("a", "t4")]);
        expect(gens.map((g) => [g.seq, g.fromTurnId, g.untilTurnId, g.current])).toEqual([
            [0, null, "t4", false],
            [1, "t4", null, true],
        ]);
        expect(turnsOfGeneration(turns, gens[0]!)).toEqual(["t1", "t2", "t3"]);
        expect(turnsOfGeneration(turns, gens[1]!)).toEqual(["t4", "t5"]);
    });

    it("清零（keptFromTurnId=null）→ 新一代从零开始", () => {
        const gens = listGenerations(turns, [compactEvent("a", null)]);
        expect(gens[1]).toMatchObject({ fromTurnId: null, untilTurnId: null, current: true });
        expect(turnsOfGeneration(turns, gens[1]!)).toEqual(turns); // from null = 从头（该代自身即全部轮）
    });

    it("边界轮已不存在（日志被换）→ 该次压缩不入代链，不凭空造代", () => {
        const gens = listGenerations(turns, [compactEvent("a", "tX")]);
        expect(gens).toHaveLength(1);
        expect(gens[0]!.current).toBe(true);
    });

    it("第 0 代的起点时间取首轮 id 的时刻", () => {
        const gens = listGenerations(["t1735000000000"], []);
        expect(gens[0]!.startedAt).toBe(new Date(1735000000000).toISOString());
    });
});
