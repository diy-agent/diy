// tests/core/context-dropped.test.ts
// 🎯 压缩后的**索引注记**（##269 D2 形式 B）—— 纯渲染 + 端到端投递形态
//
// 形式 B 的三条契约：
//   ① 保留消息**原样**（不因注记而变形）—— provider 友好、前缀缓存不砸；
//   ② 被省区间落在**一条 user 消息**里，内容是可回取的 YAML（行号 + 轮 + 回取命令）；
//   ③ 注记与保留首条 user 合并成一条（provider 拒连续同角色），故模型看到的是
//      「索引在前、用户原话在后」的**一条**消息。

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { BlockStore, type Op } from "../../src/main/services/local-blocks";
import {
    compactFile,
    droppedSegmentOf,
    getLocalAgent,
    opsFile,
} from "../../src/main/services/local-agent";
import { collectDroppedFacts, renderDroppedNote, type DroppedSegment } from "../../src/shared/context/dropped";
import { normalizePolicy } from "../../src/shared/context/compaction";

let PROJECT = "";
beforeAll(() => {
    PROJECT = createProject(join(diyHome(), "dropped-work"));
});
let seq = 0;
const newUri = (): string => createTask({ title: `注记测试 ${++seq}`, project: PROJECT });

// ─── 渲染（纯函数）────────────────────────────────────

describe("renderDroppedNote：注释头 + YAML 映射", () => {
    const seg: DroppedSegment = {
        range: [1, 74],
        turns: ["t1000", "t2000"],
        messages: 74,
        tools: ["bash", "read"],
        why: "压缩策略：只保留最近 1 轮（此处含被省去的 2 轮）",
    };
    it("字段齐 + 回取命令里的行号区间与 range 一致", () => {
        const t = renderDroppedNote(seg, { file: "local/k.llm.jsonl" });
        expect(t).toContain("local/k.llm.jsonl");
        expect(t).toContain("sed -n '1,74p'");
        // 行号兜底：按轮次 grep（盘上日志落后时行号会偏，grep 一定命中）
        expect(t).toContain(`grep -n '"turn":"t1000"'`);
        expect(t).toContain("range: [1, 74]");
        expect(t).toContain("turns: [t1000, t2000]");
        expect(t).toContain("messages: 74");
        expect(t).toContain("tools: [bash, read]");
        // why 可能含中文冒号/括号 → 走双引号标量，别成非法 YAML
        expect(t).toContain('why: "压缩策略');
    });
    it("gist 缺省不写那一行（不留空字段假装有内容）", () => {
        expect(renderDroppedNote(seg, { file: "f" })).not.toContain("gist:");
        expect(renderDroppedNote({ ...seg, gist: "改了 3 个文件" }, { file: "f" })).toContain('gist: "改了 3 个文件"');
    });
});

describe("collectDroppedFacts：只认结构化字段", () => {
    it("轮去重保序 + 工具名去重；content 是字符串也不炸", () => {
        const facts = collectDroppedFacts([
            { role: "user", content: "话", turn: "t1" },
            { role: "assistant", content: [{ type: "tool-call", toolName: "bash", toolCallId: "c1" }], turn: "t1" },
            { role: "tool", content: [{ type: "tool-result", toolName: "bash", toolCallId: "c1" }], turn: "t1" },
            { role: "tool", content: [{ type: "tool-result", toolName: "read", toolCallId: "c2" }], turn: "t2" },
        ]);
        expect(facts.turns).toEqual(["t1", "t2"]);
        expect(facts.tools).toEqual(["bash", "read"]);
    });
});

// ─── 区间事实（droppedSegmentOf）──────────────────────

/** 三轮 ops：每轮 user + assistant 文本 + 一个 tool */
function threeTurns(): { store: BlockStore; turns: string[]; turnStarts: number[] } {
    const ops: Op[] = [];
    const turns: string[] = [];
    const turnStarts: number[] = [];
    for (let i = 1; i <= 3; i++) {
        const t = `t${1000 + i}`;
        turns.push(t);
        turnStarts.push(ops.length);
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
    return { store, turns, turnStarts };
}

describe("droppedSegmentOf：区间事实", () => {
    const policy = normalizePolicy({ keepTurns: 1 });

    it("保留最后一轮 → 行号区间 [1, 被省条数]、轮/工具如实", () => {
        const { store, turns } = threeTurns();
        const seg = droppedSegmentOf(store, turns[2]!, policy)!;
        expect(seg).toBeTruthy();
        expect(seg.range[0]).toBe(1);
        expect(seg.messages).toBe(seg.range[1]);
        expect(seg.turns).toEqual([turns[0], turns[1]]);
        expect(seg.tools).toEqual(["bash", "read"]);
        expect(seg.why).toContain("只保留最近 1 轮");
    });

    it("keepTurns=0 的 why 是「会话清零」", () => {
        const { store, turns } = threeTurns();
        // 全清那刻尚无新轮 → sinceTurnId=null（全部都在被省侧）
        const seg = droppedSegmentOf(store, null, normalizePolicy({ keepTurns: 0 }))!;
        expect(seg.why).toContain("会话清零");
    });

    it("未压缩（undefined）→ null（调用方本就不会问）", () => {
        const { store } = threeTurns();
        expect(droppedSegmentOf(store, undefined, policy)).toBeNull();
    });

    it("保留起点就是第一轮 → null（没有消息被省）", () => {
        const { store, turns } = threeTurns();
        expect(droppedSegmentOf(store, turns[0]!, policy)).toBeNull();
    });

    it("保留起点找不到 → null（投影实际退化为全投，注记会说谎）", () => {
        const { store } = threeTurns();
        expect(droppedSegmentOf(store, "t9999", policy)).toBeNull();
    });
});

// ─── 端到端：deliveryMessages 的投递形态 ──────────────

describe("deliveryMessages：注记落在投递里，且保留部分原样", () => {
    /** 造一个「已压缩」的落盘状态（真 ops + 真 compact 账本），走真发同一条链 */
    function compactedTask(): string {
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
                policy: { ...normalizePolicy({ keepTurns: 1 }) },
                boundary: {
                    keptFromTurnId: turns[2],
                    keepFromOpIndex: turnStarts[2],
                    keptTurns: 1,
                    droppedTurns: 2,
                },
                before: { turns: 3, messages: 12, bytes: 0, estTokens: 0 },
                after: { turns: 1, messages: 4, bytes: 0, estTokens: 0 },
            }) + "\n",
            "utf-8",
        );
        return uri;
    }

    it("首条 = 索引注记；被省内容不在投递里，保留轮原样在", () => {
        const uri = compactedTask();
        const msgs = getLocalAgent().deliveryMessages(uri);
        const first = msgs[0]!;
        expect(first.role).toBe("user");
        const text = typeof first.content === "string" ? first.content : JSON.stringify(first.content);
        expect(text).toContain("# ── 会话历史（压缩视图）");
        expect(text).toContain("local/projects_"); // 原文相对路径（回取用）
        expect(text).toContain(".llm.jsonl");
        expect(text).toContain("range: [1, ");
        expect(text).toContain("turns: [t2001, t2002]");
        // 被省的两轮的用户原话不在投递里，最后一轮的在
        const all = JSON.stringify(msgs);
        expect(all).not.toContain("第 1 句");
        expect(all).not.toContain("第 2 句");
        expect(all).toContain("第 3 句");
        // 工具结果原样（未裁剪策略下不写 marker）
        expect(all).toContain("out3");
    });

    it("DIY_CTX_HISTORY_NOTE=0 → 退回纯原生（对照实验的开关）", () => {
        const uri = compactedTask();
        process.env["DIY_CTX_HISTORY_NOTE"] = "0";
        try {
            const msgs = getLocalAgent().deliveryMessages(uri);
            expect(JSON.stringify(msgs)).not.toContain("会话历史（压缩视图）");
        } finally {
            delete process.env["DIY_CTX_HISTORY_NOTE"];
        }
    });
});
