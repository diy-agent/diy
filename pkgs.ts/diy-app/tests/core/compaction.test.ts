// tests/core/compaction.test.ts
// 🎯 压缩纯逻辑：策略归一 / 工具输出裁剪 / 账本边界 / 历史代切分
//
// 全部为纯函数（shared/context/compaction.ts），不起 Electron、不打网络。
// 真发落点（blocksToMessages 的投递选项）另在 local-blocks.test.ts 里验证。

import { describe, it, expect } from "vitest";
import {
    DEFAULT_HEADTAIL,
    flatPolicyOf,
    clipToolResult,
    estimateTokens,
    fmtBytes,
    listTurnIds,
    normalizePolicy,
    parseCompactLog,
    toolResultOf,
    resolveBoundary,
    sliceOpsFromTurn,
    utf8Bytes,
    type CompactEventRecord,
    type OpLike,
} from "@diy/compact/compaction";
import { parseCutMarkers } from "@diy/context/format/cut-marker";

// ─── 策略归一（只有 budget 一种算法）───

describe("normalizePolicy：工具结果兜底（历史上限不在这里）", () => {
    it("空输入 → 缺省：头尾裁剪（历史上限 = history.limit.limitTokens，与 policy 无关）", () => {
        const p = normalizePolicy(undefined);
        expect(p.mode).toBe("budget");
        expect(p.modeData.toolResult.render).toBe("headtail");
        expect(flatPolicyOf(p).headtail).toEqual(DEFAULT_HEADTAIL);
    });
    it("收扁平输入面（headLines 局部覆盖）；旧 budgetBytes 字段被忽略", () => {
        const t = toolResultOf(normalizePolicy({ toolResult: "headtail", headtail: { headLines: 7 } }));
        expect(t.render).toBe("headtail");
        if (t.render === "headtail") {
            expect(t.renderData.head).toBe(7);
            expect(t.renderData.tail).toBe(DEFAULT_HEADTAIL.tailLines);
        }
        // ##432：旧字节预算字段已删 —— 传进来也不影响任何东西（不炸、不复活）
        expect(normalizePolicy({ budgetBytes: 5120 }).modeData.toolResult.render).toBe("headtail");
    });
    it("坏值回落：未知 render → asis", () => {
        expect(normalizePolicy({ toolResult: "nope" }).modeData.toolResult.render).toBe("asis");
    });
});

/** 造 n 行文本（每行 `line i`） */
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

describe("clipToolResult", () => {
    // 工具输出策略：三轴形状（参数收进分支）
    const pol = (mode: "asis" | "headtail" | "callpath", ht = DEFAULT_HEADTAIL) =>
        toolResultOf(normalizePolicy({ toolResult: mode, headtail: { headLines: ht.headLines, tailLines: ht.tailLines, maxLineChars: ht.maxLineChars, maxKeepBytes: ht.maxKeepBytes } }))!;

    it("asis：逐字符返回原文", () => {
        const t = lines(1000);
        const r = clipToolResult(t, pol("asis"));
        expect(r.clipped).toBe(false);
        expect(r.text).toBe(t);
    });

    it("headtail：未超阈值（默认 triggerLines 行）不裁 —— 短输出原样走这条路径", () => {
        const t = lines(DEFAULT_HEADTAIL.triggerLines);
        const r = clipToolResult(t, pol("headtail"));
        expect(r.clipped).toBe(false);
        expect(r.text).toBe(t);
    });

    it("headtail：超阈值 → 前 head + marker + 后 tail，标记省略行数/字节/原文路径（阈值跟常量走）", () => {
        const head = DEFAULT_HEADTAIL.headLines;
        const tail = DEFAULT_HEADTAIL.tailLines;
        const n = DEFAULT_HEADTAIL.triggerLines + 1;
        const t = lines(n);
        const r = clipToolResult(t, pol("headtail"), { origPath: "local/toolout/x.txt" });
        expect(r.clipped).toBe(true);
        const out = r.text.split("\n");
        expect(out[0]).toBe("line 0");
        expect(out[head - 1]).toBe(`line ${head - 1}`);
        // marker 紧跟在头之后（第 head 行）——##425 起是 `<cut by="tool-output" scope="wire" …/>`
        const m = parseCutMarkers(out[head]!).at(0)!;
        expect(m).toMatchObject({ by: "tool-output", scope: "wire", why: "budget", unit: "lines", total: n });
        expect(m.total - m.kept).toBe(n - head - tail);
        expect(m.resume).toBe("local/toolout/x.txt");
        expect(out[out.length - 1]).toBe(`line ${n - 1}`);
        expect(r.origLines).toBe(n);
        expect(r.droppedLines).toBe(n - head - tail);
        // 头 head + marker 1 + 尾 tail
        expect(r.keptLines).toBe(head + tail + 1);
    });

    it("headtail：无 origPath 时 marker 不编造路径", () => {
        const r = clipToolResult(lines(200), pol("headtail"));
        const m = parseCutMarkers(r.text).at(0)!;
        expect(m).toMatchObject({ by: "tool-output", scope: "wire" });
        expect(m.resume).toBeUndefined(); // 没落盘就不编造路径（指向不存在的文件比不说还坏）
    });

    it("headtail：行数没超但单行超长 → 只做单行截断，不写截断 marker（没省略任何行）", () => {
        const t = `short\n${"A".repeat(500)}\nshort`;
        const r = clipToolResult(t, pol("headtail", { ...DEFAULT_HEADTAIL, maxLineChars: 300 }));
        expect(r.clipped).toBe(true);
        expect(r.droppedLines).toBe(0);
        expect(parseCutMarkers(r.text)).toEqual([]); // 没省略任何行 ⇒ 不写 marker
        expect(r.text).toContain("…");
        expect(r.text.split("\n")[1]!.endsWith("…")).toBe(true);
    });

    it("headtail：字节兜底（一行超长穿透 maxKeepBytes）→ 收缩到预算内", () => {
        // 一行 = maxKeepBytes + 1 字节 > 字节兜底（单行阈值调大以免先被行内截断）
        const t = `head\n${"B".repeat(DEFAULT_HEADTAIL.maxKeepBytes + 1)}\ntail`;
        const r = clipToolResult(t, pol("headtail", { ...DEFAULT_HEADTAIL, maxLineChars: 1_000_000 }));
        expect(r.clipped).toBe(true);
        expect(utf8Bytes(r.text)).toBeLessThanOrEqual(DEFAULT_HEADTAIL.maxKeepBytes);
    });

    it("callpath：整段换成一句「只留调用」提示 + 原文路径", () => {
        const r = clipToolResult(lines(300), pol("callpath"), { origPath: "local/toolout/y.txt" });
        expect(r.clipped).toBe(true);
        expect(parseCutMarkers(r.text).at(0)).toMatchObject({
            by: "tool-result-callpath",
            scope: "wire",
            why: "budget",
            unit: "lines",
            total: 300,
            kept: 0,
            resume: "local/toolout/y.txt",
        });
        expect(r.keptLines).toBe(1);
    });

    it("空输出：任何模式都不裁（空串没有可省略的东西）", () => {
        for (const m of ["asis", "headtail", "callpath"] as const) {
            const r = clipToolResult("", pol(m));
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
        v: 2,
        id,
        ts,
        by: "cli",
        trigger: "manual",
        policy: normalizePolicy({}),
        boundary: { keptFromTurnId, keepFromOpIndex: 0 },
        size: {
            before: { turns: 5, messages: 10, bytes: 1000, estTokens: 250 },
            after: { turns: 2, messages: 4, bytes: 400, estTokens: 100 },
            keptTurns: 2,
            droppedTurns: 3,
        },
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
