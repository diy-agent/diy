// tests/core/context-dropped.test.ts
// 🎯 压缩后的**索引注记**（##269 D2/D3b）—— 纯渲染 + 选择 + 端到端投递形态
//
// 契约：
//   ① 保留消息**原样**（不因注记而变形）—— provider 友好、前缀缓存不砸；
//   ② 被省区间落在**一条 user 消息**里，内容是可回取的 YAML（行号 + 轮 + 回取命令）；
//   ③ 注记与保留首条 user 合并成一条（provider 拒连续同角色）；
//   ④ **多段**：`content` 轴会在**保留轮内部**也省内容 → 注记必须分段且标 `kind`，
//      否则模型以为保留轮是完整的（说谎，比不给索引更坏）。

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { BlockStore, projectAll, selectHistory, type Op } from "../../src/main/services/local-blocks";
import { compactFile, droppedSegmentsOf, getLocalAgent, opsFile } from "../../src/main/services/local-agent";
import { renderDroppedNote, type DroppedNote } from "../../src/shared/context/dropped";
import { normalizePolicy } from "../../src/shared/context/compaction";

let PROJECT = "";
beforeAll(() => {
    PROJECT = createProject(join(diyHome(), "dropped-work"));
});
let seq = 0;
const newUri = (): string => createTask({ title: `注记测试 ${++seq}`, project: PROJECT });

// ─── 渲染（纯函数）────────────────────────────────────

describe("renderDroppedNote：注释头 + 分段 YAML", () => {
    const note: DroppedNote = {
        total: 74,
        segments: [
            {
                range: [1, 74],
                kind: "turns",
                turns: ["t1000", "t2000"],
                tools: ["bash", "read"],
                why: "压缩策略：只保留最近 1 轮（此处含被省去的 2 轮）",
            },
        ],
    };
    it("字段齐 + 回取命令里的行号区间与 range 一致", () => {
        const t = renderDroppedNote(note, { file: "local/k.llm.jsonl" });
        expect(t).toContain("local/k.llm.jsonl");
        expect(t).toContain("sed -n '1,74p'");
        expect(t).toContain("dropped:");
        expect(t).toContain("  total: 74");
        expect(t).toContain("  segments:");
        expect(t).toContain("    - range: [1, 74]");
        expect(t).toContain("      kind: turns");
        expect(t).toContain("      turns: [t1000, t2000]");
        expect(t).toContain("      tools: [bash, read]");
        // why 含中文冒号/括号 → 走双引号标量，别成非法 YAML
        expect(t).toContain('why: "压缩策略');
        // 行号兜底：按轮次 grep（盘上日志落后时行号会偏，grep 一定命中）
        expect(t).toContain(`grep -n '"turn":"t1000"'`);
    });

    it("多段都渲染出来（两段 kind 不同）", () => {
        const two: DroppedNote = {
            total: 10,
            segments: [
                { range: [1, 6], kind: "turns", turns: ["t1"], tools: [], why: "w1" },
                { range: [8, 11], kind: "content", turns: ["t3"], tools: ["bash"], why: "w2" },
            ],
        };
        const t = renderDroppedNote(two, { file: "f" });
        expect(t).toContain("kind: turns");
        expect(t).toContain("kind: content");
        expect(t).toContain("range: [1, 6]");
        expect(t).toContain("range: [8, 11]");
    });

    it("字段说明从 zod 派生（含 segments 项说明），且不再有 messages/gist 死字段", () => {
        const t = renderDroppedNote(note, { file: "f" });
        expect(t).toContain("# 字段（由 zod 定义派生，勿手写）：");
        expect(t).toContain("total");
        expect(t).toContain("被省去的消息总数");
        expect(t).toContain("（segments 每一项）");
        expect(t).toContain("kind");
        expect(t).not.toContain("gist");
    });
});

// ─── 选择（纯函数：全量投影 → 下标）────────────────────

/** 三轮：每轮 user + assistant 文本 + 一个 tool */
function threeTurns(): BlockStore {
    const ops: Op[] = [];
    for (let i = 1; i <= 3; i++) {
        const t = `t${1000 + i}`;
        ops.push({ op: "start", id: t, kind: "turn" });
        ops.push({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } });
        ops.push({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 句` } });
        ops.push({ op: "stop", id: `${t}_u` });
        ops.push({ op: "start", id: `${t}_s1`, kind: "step", parent: t });
        ops.push({ op: "start", id: `${t}_c`, kind: "tool", parent: `${t}_s1`, meta: { tool: i === 2 ? "read" : "bash" } });
        ops.push({ op: "patch", id: `${t}_c`, fields: { args: { command: "ls" } } });
        ops.push({ op: "patch", id: `${t}_c`, fields: { status: "done", output: "x" } });
        ops.push({ op: "stop", id: `${t}_c` });
        ops.push({ op: "stop", id: `${t}_s1` });
        ops.push({ op: "stop", id: t });
    }
    const store = new BlockStore();
    for (const o of ops) store.apply(o);
    return store;
}

describe("selectHistory：选择是纯下标运算（行号 = 下标 + 1）", () => {
    const store = threeTurns();
    const all = projectAll(store);
    const turns = ["t1001", "t1002", "t1003"];

    it("全量投影 = 每轮 3 条（user / assistant-tool-call / tool）", () => {
        expect(all).toHaveLength(9);
        expect(all.map((m) => m.role)).toEqual([
            "user", "assistant", "tool",
            "user", "assistant", "tool",
            "user", "assistant", "tool",
        ]);
    });

    it("content=all + 轮级裁：保留最后一轮 → 省掉前 6 条（下标 0..5）", () => {
        const sel = selectHistory(all, { sinceTurnId: turns[2] });
        expect(sel.kept).toEqual([6, 7, 8]);
        expect(sel.dropped).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("content=text：整条丢 tool 链路（同批丢 ⇒ 配对不破）", () => {
        const sel = selectHistory(all, { content: "text" });
        const keptKinds = sel.kept.map((i) => all[i]!.role);
        expect(keptKinds).toEqual(["user", "user", "user"]);
        // tool-call 与 tool-result 一起被丢
        expect(sel.dropped.every((i) => all[i]!.role !== "user")).toBe(true);
    });

    it("content=conclusion：每轮只留 user + 该轮最后一条 assistant", () => {
        const sel = selectHistory(all, { content: "conclusion" });
        expect(sel.kept.map((i) => all[i]!.role)).toEqual(["user", "user", "user"]);
    });

    it("sinceTurnId=null：一条不投（全清）", () => {
        const sel = selectHistory(all, { sinceTurnId: null });
        expect(sel.kept).toEqual([]);
        expect(sel.dropped).toHaveLength(9);
    });

    it("保留起点找不到 → 退化为全投（宁可多给，也不给空白会话）", () => {
        expect(selectHistory(all, { sinceTurnId: "t9999" }).dropped).toEqual([]);
    });
});

describe("droppedSegmentsOf：分段事实", () => {
    const policy = normalizePolicy({ keepTurns: 1 });

    it("轮级裁 → 一段 kind=turns，行号区间 [1, 被省条数]", () => {
        const note = droppedSegmentsOf(threeTurns(), { sinceTurnId: "t1003", content: "all" }, policy)!;
        expect(note.total).toBe(6);
        expect(note.segments).toHaveLength(1);
        const s = note.segments[0]!;
        expect(s.range).toEqual([1, 6]);
        expect(s.kind).toBe("turns");
        expect(s.turns).toEqual(["t1001", "t1002"]);
        expect(s.tools).toEqual(["bash", "read"]);
        expect(s.why).toContain("只保留最近 1 轮");
    });

    it("**content 裁另成一段**（保留轮内被省的内容）—— 不谎称保留轮完整", () => {
        const p = normalizePolicy({ keepTurns: 1, content: "text" });
        const note = droppedSegmentsOf(threeTurns(), { sinceTurnId: "t1003", content: "text" }, p)!;
        const kinds = note.segments.map((s) => s.kind);
        expect(kinds).toContain("turns");
        expect(kinds).toContain("content");
        const content = note.segments.find((s) => s.kind === "content")!;
        expect(content.why).toContain("只留文本");
        expect(content.tools).toEqual(["bash"]);
        // total = 被省条数（全量 9 - 保留 1）
        expect(note.total).toBe(8);
    });

    it("conclusion 的 why 说「只留结论」", () => {
        const p = normalizePolicy({ keepTurns: 1, content: "conclusion" });
        const note = droppedSegmentsOf(threeTurns(), { sinceTurnId: "t1003", content: "conclusion" }, p)!;
        expect(note.segments.some((s) => s.why.includes("只留结论"))).toBe(true);
    });

    it("未压缩（无边界、content=all）→ null（调用方本就不会问）", () => {
        expect(droppedSegmentsOf(threeTurns(), { sinceTurnId: undefined, content: "all" }, policy)).toBeNull();
    });

    it("保留起点就是第一轮且 content=all → null（没有东西被省）", () => {
        expect(droppedSegmentsOf(threeTurns(), { sinceTurnId: "t1001", content: "all" }, policy)).toBeNull();
    });

    it("保留全部轮次（count=all）+ content=text → 只有 content 段，无 turns 段", () => {
        const p = normalizePolicy({ keepTurns: "all", content: "text" });
        const note = droppedSegmentsOf(threeTurns(), { sinceTurnId: "t1001", content: "text" }, p)!;
        expect(note.segments.every((s) => s.kind === "content")).toBe(true);
        expect(note.total).toBe(6); // 每轮丢 tool-call + tool-result
    });
});

// ─── 端到端：deliveryMessages 的投递形态 ──────────────

/** 造一个「已压缩」的落盘状态（真 ops + 真 compact 账本），走真发同一条链 */
function compactedTask(policy: Record<string, unknown>, keepTurnIdx: number): { uri: string; turns: string[] } {
    const uri = newUri();
    const lines: string[] = [];
    const turnStarts: number[] = [];
    const turns: string[] = [];
    for (let i = 1; i <= 3; i++) {
        const t = `t${2000 + i}`;
        turns.push(t);
        turnStarts.push(lines.length);
        const push = (o: Op) => lines.push(JSON.stringify(o));
        push({ op: "start", id: t, kind: "turn" });
        push({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } });
        push({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 句` } });
        push({ op: "stop", id: `${t}_u` });
        push({ op: "start", id: `${t}_s1`, kind: "step", parent: t });
        push({ op: "start", id: `${t}_c`, kind: "tool", parent: `${t}_s1`, meta: { tool: "bash" } });
        push({ op: "patch", id: `${t}_c`, fields: { args: { command: "ls" } } });
        push({ op: "patch", id: `${t}_c`, fields: { status: "done", output: `out${i}` } });
        push({ op: "stop", id: `${t}_c` });
        push({ op: "stop", id: `${t}_s1` });
        push({ op: "stop", id: t });
    }
    writeFileSync(opsFile(uri), lines.join("\n") + "\n", "utf-8");
    writeFileSync(
        compactFile(uri),
        JSON.stringify({
            kind: "compact",
            v: 1,
            id: "c1",
            ts: new Date().toISOString(),
            by: "cli",
            policy: normalizePolicy(policy),
            boundary: {
                keptFromTurnId: turns[keepTurnIdx],
                keepFromOpIndex: turnStarts[keepTurnIdx],
                keptTurns: 3 - keepTurnIdx,
                droppedTurns: keepTurnIdx,
            },
            before: { turns: 3, messages: 9, bytes: 0, estTokens: 0 },
            after: { turns: 3, messages: 3, bytes: 0, estTokens: 0 },
        }) + "\n",
        "utf-8",
    );
    return { uri, turns };
}

describe("deliveryMessages：注记落在投递里，且保留部分原样", () => {
    it("轮级裁：首条 = 索引注记（kind=turns）；被省内容不在投递里", () => {
        const { uri } = compactedTask({ keepTurns: 1 }, 2);
        const msgs = getLocalAgent().deliveryMessages(uri);
        const first = msgs[0]!;
        expect(first.role).toBe("user");
        const text = typeof first.content === "string" ? first.content : JSON.stringify(first.content);
        // 旧轮边界口径的注记与 system 的 historyIndex（预算注记说明）不是同一格式 → 自描述
        expect(text).toContain("# ── 会话历史（压缩视图）");
        expect(text).toContain("kind: turns");
        expect(text).toContain("sed -n"); // 自带回取命令（不再依赖 system 节点）
        expect(text).toContain("turns: [t2001, t2002]");
        const all = JSON.stringify(msgs);
        expect(all).not.toContain("第 1 句");
        expect(all).not.toContain("第 2 句");
        expect(all).toContain("第 3 句");
        expect(all).toContain("out3");
    });

    it("content=text：注记**两段**（turns + content），且工具链路不在投递里", () => {
        const { uri } = compactedTask({ keepTurns: 1, content: "text" }, 2);
        const msgs = getLocalAgent().deliveryMessages(uri);
        const text = String(msgs[0]!.content);
        expect(text).toContain("kind: turns");
        expect(text).toContain("kind: content");
        expect(text).toContain("只留文本");
        const all = JSON.stringify(msgs);
        expect(all).not.toContain("out3"); // 保留轮的工具结果也被省
        expect(all).toContain("第 3 句");
    });

    it("keepTurns='all' + content=conclusion：全留轮、只留结论", () => {
        const { uri } = compactedTask({ keepTurns: "all", content: "conclusion" }, 0);
        const msgs = getLocalAgent().deliveryMessages(uri);
        const text = String(msgs[0]!.content);
        expect(text).toContain("kind: content");
        expect(text).toContain("只留结论");
        expect(text).not.toContain("kind: turns"); // 没有整轮被裁
        const all = JSON.stringify(msgs);
        expect(all).toContain("第 1 句");
        expect(all).toContain("第 3 句");
        expect(all).not.toContain("out1");
    });

    it("DIY_CTX_HISTORY_NOTE=0 → 退回纯原生（对照实验的开关）", () => {
        const { uri } = compactedTask({ keepTurns: 1 }, 2);
        process.env["DIY_CTX_HISTORY_NOTE"] = "0";
        try {
            const msgs = getLocalAgent().deliveryMessages(uri);
            expect(JSON.stringify(msgs)).not.toContain("会话历史（压缩视图）");
        } finally {
            delete process.env["DIY_CTX_HISTORY_NOTE"];
        }
    });
});
