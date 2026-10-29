// tests/core/local-agent-ops-seek.test.ts
// 🎯 ##420：ops 读起点 = 压缩账本的字节偏移（会话加载不再全量 replay）
//
// 契约（用户 2026-10-23 的口径）：
//   ① 有 `keptFromOpsOffset` + `keptFromLlmLine` ⇒ 只 replay 起点之后的 op，**块树与全量 replay 等价**
//      （同一份 ops 造两棵树，逐字段比）；
//   ② 没压缩 / 旧账缺行号 ⇒ 退全量，行为与今天一致；
//   ③ `schema` 不符 / 文件比压缩时还短 ⇒ **断代**（起点 EOF、不 replay），且**显式可见**（不许静默空白）；
//   ④ 起点落在 UTF-8 多字节字符中间时不错行（跳到下一个行首，绝不从半个字符开始解）。
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager, compactFile, readOpsFrom, resolveOpsReplay } from "../../src/main/services/local-agent";
import { opsFile } from "../../src/main/core/local-paths";
import { autoCompactFile, loadAutoCompact } from "../../src/main/core/auto-compact-config";
import { llmFile } from "../../src/main/core/local-paths";
import { BlockStore, projectAll, type Op } from "../../src/main/services/local-blocks";
import type { CompactEventRecord } from "@diy/compaction/compaction";

/** 一轮的行（user 文本 + 一个 assistant 文本 = 每轮 2 条消息）；中文内容制造多字节字节序列 */
function turnLines(i: number): string[] {
    const t = `t${String(i).padStart(4, "0")}`;
    const push = (o: unknown) => JSON.stringify(o);
    return [
        push({ op: "start", id: t, kind: "turn", meta: { model: "0@test/m" } }),
        push({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } }),
        push({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 问（中文会跨字节）` } }),
        push({ op: "stop", id: `${t}_u` }),
        push({ op: "start", id: `${t}_s1`, kind: "step", parent: t }),
        push({ op: "start", id: `${t}_a`, kind: "text", parent: `${t}_s1`, meta: { role: "assistant" } }),
        push({ op: "delta", id: `${t}_a`, fields: { content: `第 ${i} 答：好的` } }),
        push({ op: "stop", id: `${t}_a` }),
        push({ op: "stop", id: `${t}_s1` }),
        push({ op: "stop", id: t }),
    ];
}

const TURNS = 6;
/** 保留起点 = 第 4 轮（前 3 轮被压缩掉） */
const KEEP_FROM = 4;

const CANON = Array.from({ length: TURNS }, (_, k) => turnLines(k + 1).join("\n")).join("\n") + "\n";

/** 第 n 轮的 turn start 行在文件里的**字节偏移**（= 账本记的那个 offset 的真身） */
function turnOffset(text: string, turnId: string): number {
    const line = `{"op":"start","id":"${turnId}","kind":"turn"`;
    const at = text.indexOf(line);
    if (at < 0) throw new Error(`fixture 里找不到 ${turnId}`);
    return Buffer.byteLength(text.slice(0, at), "utf-8");
}

/** 块树快照（结构 + 终值字段；`touched` 是 fold 序号，不参与比较） */
function snapshot(store: BlockStore) {
    const STRUCT = new Set(["id", "kind", "parent", "children", "stopped", "touched"]);
    return [...store.blocks.values()]
        .map((b) => ({
            id: b.id,
            kind: b.kind,
            parent: b.parent ?? null,
            children: [...b.children],
            stopped: b.stopped,
            fields: Object.fromEntries(
                Object.entries(b).filter(([k]) => !STRUCT.has(k)).sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0)),
            ),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 全量块树里「根轮 ∈ keptTurns」的那棵子树（= 跳前缀之后应当得到的东西） */
function subForest(store: BlockStore, keptTurns: Set<string>) {
    const rootTurnOf = (id: string): string | null => {
        let cur = store.blocks.get(id);
        while (cur && cur.parent) cur = store.blocks.get(cur.parent);
        return cur ? cur.id : null;
    };
    const keep = new Set(
        [...store.blocks.keys()].filter((id) => {
            const r = rootTurnOf(id);
            return r !== null && keptTurns.has(r);
        }),
    );
    const all = snapshot(store).filter((b) => keep.has(b.id));
    // children 里被剔除的（属于别的轮）要一并剪掉，否则逐字节比不了
    return all.map((b) => ({ ...b, children: b.children.filter((c) => keep.has(c)) }));
}

const foldAll = (ops: readonly Op[]): BlockStore => {
    const s = new BlockStore();
    for (const op of ops) s.apply(op);
    return s;
};
const parseOps = (text: string): Op[] =>
    text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Op);

let manager: LocalAgentManager;
let project = "";
const uris: string[] = [];

beforeAll(() => {
    manager = new LocalAgentManager();
    project = createProject(join(diyHome(), "ops-seek-work"));
});

/** 每个用例一个全新任务（块树缓存 / 会话缓存不互相污染） */
function newTask(opsText: string, ledger?: (ctx: { from: number; llmLine: number; size: number }) => unknown[]): string {
    const uri = createTask({ title: `ops seek ${uris.length + 1}`, project });
    uris.push(uri);
    const fp = opsFile(uri);
    mkdirSync(join(fp, ".."), { recursive: true });
    writeFileSync(fp, opsText, "utf-8");
    // llm.jsonl：按「每轮 2 条」落一份全量（对账 / 行号口径的真身）
    const llm = Array.from({ length: TURNS }, (_, k) => [
        JSON.stringify({ role: "user", content: `第 ${k + 1} 问（中文会跨字节）`, turn: `t${String(k + 1).padStart(4, "0")}` }),
        JSON.stringify({ role: "assistant", content: `第 ${k + 1} 答：好的`, turn: `t${String(k + 1).padStart(4, "0")}` }),
    ])
        .flat()
        .join("\n");
    mkdirSync(join(llmFile(uri), ".."), { recursive: true });
    writeFileSync(llmFile(uri), `${llm}\n`, "utf-8");
    if (ledger) {
        const from = turnOffset(opsText, `t${String(KEEP_FROM).padStart(4, "0")}`);
        // 每轮 2 条消息 ⇒ 第 4 轮第一条 = 第 7 行（1-based）
        const llmLine = (KEEP_FROM - 1) * 2 + 1;
        const size = statSync(fp).size;
        const lines = ledger({ from, llmLine, size }).map((e) => JSON.stringify(e));
        writeFileSync(compactFile(uri), `${lines.join("\n")}\n`, "utf-8");
    }
    return uri;
}

/** 一条「真压缩」账（schema / 偏移 / 行号 / opsBytes 齐备） */
function compactEvent(ctx: { from: number; llmLine: number; size: number }, over: Partial<CompactEventRecord> = {}) {
    return {
        kind: "compact",
        v: 4,
        id: "2026-10-23T00:00:00.000Z",
        ts: "2026-10-23T00:00:00.000Z",
        schema: 1,
        by: "cli",
        trigger: "manual",
        policy: { mode: "budget", modeData: { budgetBytes: 61440 }, summary: false },
        boundary: {
            keptFromTurnId: `t${String(KEEP_FROM).padStart(4, "0")}`,
            keepFromOpIndex: (KEEP_FROM - 1) * 10,
            keptFromOpsOffset: ctx.from,
            keptFromLlmLine: ctx.llmLine,
            opsBytes: ctx.size,
        },
        size: { before: { turns: 6, messages: 12, bytes: 1, estTokens: 1 }, after: { turns: 3, messages: 6, bytes: 1, estTokens: 1 }, keptTurns: 3, droppedTurns: 3 },
        ...over,
    };
}

describe("resolveOpsReplay：起点判定", () => {
    it("从未压缩 ⇒ 全量（from=0、lineBase=0）", () => {
        const uri = newTask(CANON);
        const r = resolveOpsReplay(uri);
        expect(r).toMatchObject({ from: 0, lineBase: 0, kind: "full", anchor: null });
    });

    it("有完整锚点 ⇒ 起点 = 账本偏移、lineBase = 行号-1", () => {
        const uri = newTask(CANON, (ctx) => [compactEvent(ctx)]);
        const r = resolveOpsReplay(uri);
        expect(r.kind).toBe("offset");
        expect(r.from).toBe(turnOffset(CANON, "t0004"));
        expect(r.lineBase).toBe(6); // 前 3 轮 × 2 条
        expect(r.note).toBeUndefined(); // 正常路径不出声（不打扰）
    });

    it("旧账缺 keptFromLlmLine ⇒ 退全量（行号没法换算就不跳）", () => {
        const uri = newTask(CANON, (ctx) => [compactEvent(ctx, { boundary: { ...compactEvent(ctx).boundary, keptFromLlmLine: undefined } })]);
        expect(resolveOpsReplay(uri)).toMatchObject({ from: 0, lineBase: 0, kind: "full" });
    });

    it("被 undo 的压缩不再是起点 ⇒ 全量", () => {
        const uri = newTask(CANON, (ctx) => [
            compactEvent(ctx),
            { kind: "undo", v: 1, ref: "2026-10-23T00:00:00.000Z", ts: "2026-10-23T00:01:00.000Z" },
        ]);
        expect(resolveOpsReplay(uri)).toMatchObject({ from: 0, lineBase: 0, kind: "full" });
    });

    it("schema 不符 ⇒ 断代（起点 EOF）且**有可见标记**", () => {
        const uri = newTask(CANON, (ctx) => [compactEvent(ctx, { schema: 2 })]);
        const r = resolveOpsReplay(uri);
        expect(r.kind).toBe("schema-break");
        expect(r.from).toBe(statSync(opsFile(uri)).size);
        expect(r.note).toContain("格式断代");
        expect(r.lineBase).toBe(12); // llm.jsonl 现有 12 行 ⇒ 偏移 = 12（往后追加不断档）
    });

    it("文件比压缩时还短 ⇒ 也只断代，**不回退从 0 读**", () => {
        const uri = newTask(CANON, (ctx) => [compactEvent(ctx, { boundary: { ...compactEvent(ctx).boundary, opsBytes: ctx.size + 4096 } })]);
        const r = resolveOpsReplay(uri);
        expect(r.kind).toBe("truncated");
        expect(r.from).toBe(statSync(opsFile(uri)).size);
        expect(r.from).not.toBe(0);
        expect(r.note).toContain("起点作废");
    });
});

describe("readOpsFrom：跳前缀读", () => {
    it("块树与全量 replay **逐字节等价**（只少掉被跳过的轮）", () => {
        const uri = newTask(CANON);
        const from = turnOffset(CANON, "t0004");
        const full = foldAll(parseOps(CANON));
        const seek = foldAll(readOpsFrom(opsFile(uri), from));
        const keptTurns = new Set([4, 5, 6].map((i) => `t${String(i).padStart(4, "0")}`));
        expect(snapshot(seek)).toEqual(subForest(full, keptTurns));
        // 且确实少了东西（否则这个用例什么都没验）
        expect(snapshot(seek).length).toBeLessThan(snapshot(full).length);
    });

    it("from=0 与全量 replay 同日而语（旧行为不变）", () => {
        const uri = newTask(CANON);
        expect(snapshot(foldAll(readOpsFrom(opsFile(uri), 0)))).toEqual(snapshot(foldAll(parseOps(CANON))));
    });

    it("起点落在 UTF-8 多字节字符中间 ⇒ 跳到下一个行首，不错行", () => {
        const uri = newTask(CANON);
        const fp = opsFile(uri);
        const buf = Buffer.from(CANON, "utf-8");
        // 第 4 轮 user 文本「第 4 问」的「问」字中间（往后找 1~2 个字节处）
        const marker = buf.indexOf(Buffer.from("第 4 问", "utf-8"));
        expect(marker).toBeGreaterThan(0);
        const mid = marker + Buffer.byteLength("第 4 ", "utf-8") + 1; // 「问」的第 2 个字节
        expect(buf[mid - 1]).not.toBe(0x0a); // 前提：确实不在行首
        const ops = readOpsFrom(fp, mid);
        // 第一条必须是**完整**的行（能从 JSON 解出 id 的 op），且不是半行脏数据
        expect(ops.length).toBeGreaterThan(0);
        expect(ops.every((o) => typeof o.op === "string" && typeof o.id === "string")).toBe(true);
        // 跳过的半行属于被截断的那一行 ⇒ 从这里开始的第一条不可能是「第 4 问」那条 delta 的残片
        expect(JSON.stringify(ops[0])).not.toContain("（中文会跨字节）");
    });
});

describe("读者接线：deliveryMessages 只 replay 保留段", () => {
    beforeEach(() => {
        process.env["DIY_CTX_HISTORY_NOTE"] = "1";
    });

    it("有锚点 ⇒ 消息只含保留段（与全量投递的尾部逐字相同）", () => {
        const uriFull = newTask(CANON);
        const uriSeek = newTask(CANON, (ctx) => [compactEvent(ctx)]);
        const fullMsgs = manager.deliveryMessages(uriFull).messages;
        const seek = manager.deliveryMessages(uriSeek);
        expect(seek.messages.length).toBeGreaterThan(0);
        // 保留段 = 全量投影的后 6 条（3 轮 × 2 条），逐字相同
        expect(seek.messages).toEqual(fullMsgs.slice(-6));
        expect(seek.replay?.kind).toBe("offset");
    });

    it("##432 刀 2：未超单条上限 ⇒ **不产生注记**（压缩是事件，不是每步的重新决策）", () => {
        const compactCfg = autoCompactFile(diyHome());
        const saved = existsSync(compactCfg) ? readFileSync(compactCfg, "utf-8") : null;
        writeFileSync(
            compactCfg,
            JSON.stringify({
                policy: { mode: "budget", modeData: { toolResult: { render: "asis" } }, summary: false },
                // 窗口放大 ⇒ 小会话永远不该被压（旧实现会按预算切，切出空注记）。
                history: { limit: { windowTokens: 10_000_000, summary: { mode: "model" } } },
            }),
            "utf-8",
        );
        try {
            expect(loadAutoCompact(diyHome()).history?.limit?.windowTokens).toBe(10_000_000);
            const uriFull = newTask(CANON);
            const uriSeek = newTask(CANON, (ctx) => [compactEvent(ctx)]);
            // ##442 刀 2：注记已删 ⇒ 两种读法都必须**没有任何** `history:` 段（不存在「空注记」这回事）
            expect(JSON.stringify(manager.deliveryMessages(uriFull).messages)).not.toContain("history:");
            expect(JSON.stringify(manager.deliveryMessages(uriSeek).messages)).not.toContain("history:");
        } finally {
            if (saved !== null) writeFileSync(compactCfg, saved, "utf-8");
        }
    });

    it("断代 ⇒ 空会话 + 可见标记（不许静默空白）", () => {
        const uri = newTask(CANON, (ctx) => [compactEvent(ctx, { schema: 9 })]);
        const d = manager.deliveryMessages(uri);
        expect(d.messages).toEqual([]);
        expect(d.replay?.kind).toBe("schema-break");
        expect(d.replay?.note).toContain("格式断代");
    });
});

describe("账本自证：compact() 写 schema / opsBytes / keptFromLlmLine", () => {
    // 20 轮（预算只够必保的 6 步）⇒ 真会有轮被丢，压缩才不是 noop（noop 不写账）
    const BIG = Array.from({ length: 20 }, (_, k) => turnLines(k + 1).join("\n")).join("\n") + "\n";

    it.skip("落盘的旧 compact 账本三样锚点 —— 依赖旧预算触发真压；##432 刀 2 后压缩边界在 turns.jsonl，随旧策略面一起删", () => {
        const uri = newTask(BIG);
        const rec = manager.compact(uri, { mode: "budget", modeData: { budgetBytes: 1 }, summary: false }, "cli");
        expect(rec.noop).toBeUndefined();
        expect(rec.schema).toBe(1);
        expect(rec.boundary.opsBytes).toBe(Buffer.byteLength(BIG, "utf-8"));
        expect(rec.boundary.keptFromTurnId).not.toBeNull();
        const kept = rec.boundary.keptFromTurnId!;
        const keptIdx = Number(kept.slice(1)) - 1; // t00NN → 0-based 轮序
        // 账本里的行号 = 该轮第一条消息在 llm.jsonl 的行号（每轮 2 条）
        expect(rec.boundary.keptFromLlmLine).toBe(keptIdx * 2 + 1);
        expect(rec.boundary.keptFromOpsOffset).toBe(turnOffset(BIG, kept));
        // 写进去的锚点必须真能读回去当起点用（读侧的第一道自证）
        const r = resolveOpsReplay(uri);
        expect(r.kind).toBe("offset");
        expect(r.from).toBe(rec.boundary.keptFromOpsOffset);
        expect(r.lineBase).toBe(keptIdx * 2);
    });

    it("##432 刀 2：`budgetBytes: 0` 不再有「清零」语义（选择只按已落盘边界），账本锚点照写", () => {
        const uri = newTask(BIG);
        const rec = manager.compact(uri, { mode: "budget", modeData: { budgetBytes: 0 }, summary: false }, "cli");
        expect(rec.schema).toBe(1);
        expect(rec.boundary.opsBytes).toBe(Buffer.byteLength(BIG, "utf-8"));
        // 旧账本仍会记锚点（compact() 是旧手动压缩面），但**投递侧不再用它决定保留集**：
        // 保留集只由 turns 里的 compaction entry 决定（此处没有 ⇒ 全量投递）。
        expect(rec.boundary.keptFromTurnId).not.toBeNull();
    });
});

// 让「每轮 2 条」这个假定在 fixture 里当场可见：改 projection 口径时这里先红
it("fixture 口径：每轮 2 条消息（keptFromLlmLine 的推导依据）", () => {
    const uri = newTask(CANON);
    const store = foldAll(parseOps(CANON));
    const all = projectAll(store);
    expect(all.length).toBe(TURNS * 2);
    expect(all.findIndex((m) => m.turn === "t0004")).toBe((KEEP_FROM - 1) * 2);
    void uri;
});
