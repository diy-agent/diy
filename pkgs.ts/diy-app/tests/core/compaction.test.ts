// tests/core/compaction.test.ts
// 🎯 压缩纯逻辑：策略归一 / 工具输出裁剪 / 账本边界 / 历史代切分
//
// 全部为纯函数（shared/context/compaction.ts），不起 Electron、不打网络。
// 真发落点（blocksToMessages 的投递选项）另在 local-blocks.test.ts 里验证。

import { describe, it, expect } from "vitest";
import {
    DEFAULT_HEADTAIL,
    flatPolicyOf,
    keptTurnsByMessageCount,
    keptTurnsOf,
    clipToolResult,
    estimateTokens,
    fmtBytes,
    listTurnIds,
    normalizePolicy,
    parseCompactLog,
    toolResultOf,
    contentKindOf,
    type CompactPolicy,
    resolveBoundary,
    sliceOpsFromTurn,
    utf8Bytes,
    type CompactEventRecord,
    type OpLike,
} from "../../src/shared/context/compaction";

// ─── 策略归一 ────────────────────────────────────────

/** 造一条 keep 策略（内容默认「全部 + 原样」；范围单独给） */
const keepP = (count: number | "all", unit: "turns" | "messages" = "turns"): CompactPolicy => ({
    mode: "keep",
    modeData: {
        keep: count === "all" ? { scope: "all" } : { scope: "recent", unit, count },
        content: { kind: "all", toolResult: { render: "asis" } },
    },
    summary: false,
});

describe("normalizePolicy：缺省值 + 越界兜底", () => {
    it("空输入 → 全默认（保留 6 轮 / 全内容 / 原样 / 不摘要）", () => {
        const p = normalizePolicy(undefined);
        expect(p).toEqual({
            mode: "keep",
            modeData: {
                keep: { scope: "recent", unit: "turns", count: 6 },
                content: { kind: "all", toolResult: { render: "asis" } },
            },
            summary: false,
        });
        // 扁平视图（输入面契约）仍是老样子，UI 不用改
        expect(flatPolicyOf(p).headtail).toEqual(DEFAULT_HEADTAIL);
    });
    it("**旧 count:0 升格成 mode:reset**（0 不再是一支范围，也就不会被误读成「保留 0 轮」）", () => {
        expect(normalizePolicy({ keepTurns: 0 })).toEqual({ mode: "reset", summary: false });
        expect(normalizePolicy({ keep: { unit: "turns", count: 0 } })).toEqual({ mode: "reset", summary: false });
        // 决策树形状：reset 是**另一支**，不带范围/内容字段
        expect(normalizePolicy({ mode: "reset" })).toEqual({ mode: "reset", summary: false });
    });
    it("非法值逐项回落：负数 / 未知 render / 小数取整", () => {
        expect(normalizePolicy({ keepTurns: -3, toolResult: "nope" })).toMatchObject({
            mode: "keep",
            modeData: {
                keep: { scope: "recent", unit: "turns", count: 6 },
                content: { kind: "all", toolResult: { render: "asis" } },
            },
        });
        expect(normalizePolicy({ keepTurns: 4.9 })).toMatchObject({ modeData: { keep: { scope: "recent", unit: "turns", count: 4 } } });
    });
    it("**三种形状都收**：旧扁平 / 旧三轴 / 新决策树，结果同形", () => {
        const flat = normalizePolicy({ keepTurns: 2, toolResult: "headtail", headtail: { headLines: 7, tailLines: 2 } });
        const axis = normalizePolicy({ keep: { unit: "turns", count: 2 }, toolResult: { render: "headtail", head: 7, tail: 2 } });
        const tree = normalizePolicy({
            mode: "keep",
            modeData: {
                keep: { scope: "recent", unit: "turns", count: 2 },
                content: { kind: "all", toolResult: { render: "headtail", renderData: { head: 7, tail: 2, maxLineChars: DEFAULT_HEADTAIL.maxLineChars, maxKeepBytes: DEFAULT_HEADTAIL.maxKeepBytes } } },
            },
        });
        expect(flat).toEqual(axis);
        expect(tree).toEqual(axis);
        expect(flat).toMatchObject({
            modeData: { content: { kind: "all", toolResult: { render: "headtail", renderData: { head: 7, tail: 2, maxLineChars: DEFAULT_HEADTAIL.maxLineChars, maxKeepBytes: DEFAULT_HEADTAIL.maxKeepBytes } } } },
        });
    });
    it("旧扁平局部覆盖：只给 headLines，其余保持默认（参数收进分支后仍如此）", () => {
        const t = toolResultOf(normalizePolicy({ toolResult: "headtail", headtail: { headLines: 7 } }))!;
        expect(t.render).toBe("headtail");
        if (t.render === "headtail") {
            expect(t.renderData.head).toBe(7);
            expect(t.renderData.tail).toBe(DEFAULT_HEADTAIL.tailLines);
        }
    });
    it("messages 单位 + 未知 content 逐项兜底", () => {
        expect(normalizePolicy({ keepUnit: "messages", keepTurns: 3 })).toMatchObject({ modeData: { keep: { scope: "recent", unit: "messages", count: 3 } } });
        expect(normalizePolicy({ content: "nope" })).toMatchObject({ modeData: { content: { kind: "all", toolResult: { render: "asis" } } } });
        expect(normalizePolicy({ content: "conclusion" })).toMatchObject({ modeData: { content: { kind: "conclusion" } } });
    });
});

// ─── 工具输出裁剪 ────────────────────────────────────

/** 造 n 行、每行 line i 的文本 */
function lines(n: number): string {
    return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
}

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

    it("headtail：未超阈值（默认 6 行）不裁 —— 短输出原样走这条路径", () => {
        const t = lines(6);
        const r = clipToolResult(t, pol("headtail"));
        expect(r.clipped).toBe(false);
        expect(r.text).toBe(t);
    });

    it("headtail：超阈值 → 前 3 + marker + 后 3，标记省略行数/字节/原文路径", () => {
        const t = lines(1842);
        const r = clipToolResult(t, pol("headtail"), { origPath: "local/toolout/x.txt" });
        expect(r.clipped).toBe(true);
        const out = r.text.split("\n");
        expect(out[0]).toBe("line 0");
        expect(out[2]).toBe("line 2");
        expect(out[3]).toContain("中间省略 1836 行");
        expect(out[3]).toContain("local/toolout/x.txt");
        expect(out[out.length - 1]).toBe("line 1841");
        expect(r.origLines).toBe(1842);
        expect(r.droppedLines).toBe(1836);
        // 头 3 + marker 1 + 尾 3
        expect(r.keptLines).toBe(7);
    });

    it("headtail：无 origPath 时 marker 不编造路径", () => {
        const r = clipToolResult(lines(200), pol("headtail"));
        expect(r.text).toContain("完整输出已省略");
        expect(r.text).not.toContain("见 ");
    });

    it("headtail：行数没超但单行超长 → 只做单行截断，不写「中间省略」marker", () => {
        const t = `short\n${"A".repeat(500)}\nshort`;
        const r = clipToolResult(t, pol("headtail"));
        expect(r.clipped).toBe(true);
        expect(r.droppedLines).toBe(0);
        expect(r.text).not.toContain("中间省略");
        expect(r.text).toContain("…");
        expect(r.text.split("\n")[1]!.endsWith("…")).toBe(true);
    });

    it("headtail：字节兜底（一行超长穿透 maxKeepBytes）→ 收缩到预算内", () => {
        // 一行 = 100k 字符 > 8KB 兜底
        const t = `head\n${"B".repeat(100_000)}\ntail`;
        const r = clipToolResult(t, pol("headtail", { ...DEFAULT_HEADTAIL, maxLineChars: 1_000_000 }));
        expect(r.clipped).toBe(true);
        expect(utf8Bytes(r.text)).toBeLessThanOrEqual(DEFAULT_HEADTAIL.maxKeepBytes);
    });

    it("callpath：整段换成一句「只留调用」提示 + 原文路径", () => {
        const r = clipToolResult(lines(300), pol("callpath"), { origPath: "local/toolout/y.txt" });
        expect(r.clipped).toBe(true);
        expect(r.text).toContain("输出已省略（只留调用）");
        expect(r.text).toContain("300 行");
        expect(r.text).toContain("local/toolout/y.txt");
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

describe("keep.unit=messages：安全吸附（绝不切开 tool-call/result 配对）", () => {
    // 一轮内的消息都属同一 turn；轮 id 序列如 ["t1","t1","t2","t2","t3"]
    const turns = ["t1", "t2", "t3"];
    const msgs = ["t1", "t1", "t2", "t2", "t3"];

    it("0 = 全清；≥总条数 = 全留", () => {
        expect(keptTurnsByMessageCount(msgs, 0, turns)).toBe(0);
        expect(keptTurnsByMessageCount(msgs, 5, turns)).toBe(3);
        expect(keptTurnsByMessageCount(msgs, 99, turns)).toBe(3);
    });

    it("取尾 N 条后**退到轮首**（只会多留，不会少留）", () => {
        // msgs = [t1,t1,t2,t2,t3]；最后 2 条 = t2,t3 → 起点落到 t2 → 留 2 轮
        expect(keptTurnsByMessageCount(msgs, 2, turns)).toBe(2);
        // 最后 3 条 = t2,t2,t3 → 同样是 t2 起 → 2 轮（把 t2 整个留下 = 多留不切开）
        expect(keptTurnsByMessageCount(msgs, 3, turns)).toBe(2);
        // 最后 4 条 = t1…t3 → 起点 t1 → 全留
        expect(keptTurnsByMessageCount(msgs, 4, turns)).toBe(3);
    });

    it("投影里的轮 id 不在已知轮表（日志被换）→ 宁可全留", () => {
        expect(keptTurnsByMessageCount(["tx", "tx"], 1, turns)).toBe(3);
        expect(keptTurnsByMessageCount([], 3, [])).toBe(0);
    });
});

describe("keep 单位经由 normalizePolicy 落地（扁平输入 → 决策树）", () => {
    it("keepUnit=messages 与三轴形状等价", () => {
        expect(normalizePolicy({ keepUnit: "messages", keepTurns: 2 })).toEqual(
            normalizePolicy({ keep: { unit: "messages", count: 2 } }),
        );
    });
});

describe("范围三支：全留轮次 / 保留最近 N / 清零（互不混）", () => {
    it("normalizePolicy 收 all / recent / reset，各归各支", () => {
        expect(normalizePolicy({ keepTurns: "all" })).toMatchObject({ mode: "keep", modeData: { keep: { scope: "all" } } });
        expect(normalizePolicy({ keep: { unit: "turns", count: "all" } })).toMatchObject({ mode: "keep", modeData: { keep: { scope: "all" } } });
        expect(normalizePolicy({ keepTurns: 0 })).toMatchObject({ mode: "reset" });
        expect(normalizePolicy({})).toMatchObject({ mode: "keep", modeData: { keep: { scope: "recent", unit: "turns", count: 6 } } });
    });

    it("keptTurnsOf：all = 全留轮；reset = 全丢；recent = min(...)", () => {
        const turns = ["t1", "t2", "t3"];
        const msgs = ["t1", "t1", "t2", "t2", "t3"];
        expect(keptTurnsOf(keepP("all"), turns, msgs)).toBe(3);
        expect(keptTurnsOf({ mode: "reset", summary: false }, turns, msgs)).toBe(0);
        expect(keptTurnsOf(keepP(2), turns, msgs)).toBe(2);
        expect(keptTurnsOf(keepP(99), turns, msgs)).toBe(3);
        // messages 单位仍走吸附
        expect(keptTurnsOf(keepP(2, "messages"), turns, msgs)).toBe(2);
    });

    it("清零支恒为「不裁内容」（contentKindOf / toolResultOf 收口）", () => {
        const r = normalizePolicy({ mode: "reset" });
        expect(contentKindOf(r)).toBe("all");
        expect(toolResultOf(r)).toBeNull();
    });

    it("自动压缩的默认策略读法：全留轮 + 只留结论", () => {
        const p = normalizePolicy({ keep: { unit: "turns", count: "all" }, content: "conclusion" });
        expect(p).toMatchObject({ mode: "keep", modeData: { keep: { scope: "all" }, content: { kind: "conclusion" } } });
    });
});
