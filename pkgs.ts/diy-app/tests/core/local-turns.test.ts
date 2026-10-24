// tests/core/local-turns.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##424 L3 结论数据层：`turns.jsonl` 写入 + ops 降级链
//
// 契约（body 定死）：
//   刀 1 每轮一条 `{v:1, turnId, at, state, user, texts[], ref:{ops:{offset,len,seq}}}`：
//     · offset/len 字节、len 整行含换行、offset 取**写侧**（append 之前的 fileSize）；
//     · `user` = 本轮开场输入原文；`texts` = 本轮**全部** assistant 正文（过程句也留）；
//     · **旁路**：写失败只 warn，绝不影响轮末收口。
//   刀 2 降级链：ops 缺失 / 空 / 格式断代 / 被截断 ⇒ 用 turns 折成只读文本历史 + 显式标记；
//     逐条校 ref，悬空（文件缺失 / 越界 / 行号不符）在该轮上标 `degraded.refDangling`。
//
// 手法：MockLanguageModelV3（与 turn-gate 同一套桩）—— 无网络、无 Electron；
// 每轮两段 assistant 正文，钉住「texts 收全部，不只最后一条」。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { opsFile, turnsFile } from "../../src/main/core/local-paths";
import { LocalAgentManager, compactFile } from "../../src/main/services/local-agent";
import {
    TURN_TEXT_MAX_BYTES,
    appendTurnRecord,
    checkOpsRef,
    clipTurnText,
    readTurnRecords,
    type TurnRecordV1,
} from "../../src/main/services/local-turns";
import type { Op } from "../../src/main/services/local-blocks";

beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不出网，但 chat 入口会校验
});

let PROJECT = "";
beforeAll(() => {
    PROJECT = createProject(join(diyHome(), "local-turns-work"));
});

let seq = 0;
function newTask(): string {
    return createTask({ title: `turns 测试 ${++seq}`, project: PROJECT });
}

// ─── 桩模型：每轮两段正文（钉「texts 收全部」） ──────────────

const usage: LanguageModelV3Usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function twoTextReply(a: string, b: string): LanguageModelV3StreamResult {
    const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "a" },
        { type: "text-delta", id: "a", delta: a },
        { type: "text-end", id: "a" },
        { type: "text-start", id: "b" },
        { type: "text-delta", id: "b", delta: b },
        { type: "text-end", id: "b" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ];
    return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
                for (const p of parts) c.enqueue(p);
                c.close();
            },
        }),
    };
}

function stubModel(answer = "答"): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        provider: "stub",
        modelId: "stub-model",
        doStream: () => Promise.resolve(twoTextReply(answer, "过程句也要留")),
    });
}

function manager(model: MockLanguageModelV3 = stubModel()): LocalAgentManager {
    return new LocalAgentManager(() => model as unknown as LanguageModel);
}

async function collect(gen: AsyncGenerator<Op>): Promise<Op[]> {
    const ops: Op[] = [];
    for await (const op of gen) ops.push(op);
    return ops;
}

/** turns.jsonl 的行（不存在 = 空） */
function turnsOf(uri: string): TurnRecordV1[] {
    return readTurnRecords(uri);
}

// ─── 刀 1：写入 ─────────────────────────────────────

describe("turns.jsonl：正常写（一刀一条，形状定死）", () => {
    it("跑两轮 ⇒ 两行；user / texts 与 ops 折叠结果逐字一致；ref 指向该轮第一条 op", async () => {
        const uri = newTask();
        const mgr = manager();
        const ops1 = await collect(mgr.chat(uri, "第一问"));
        const ops2 = await collect(mgr.chat(uri, "第二问"));
        expect(existsSync(turnsFile(uri))).toBe(true);

        const recs = turnsOf(uri);
        expect(recs).toHaveLength(2);
        expect(recs.map((r) => r.user)).toEqual(["第一问", "第二问"]);
        expect(recs.every((r) => r.v === 1 && r.state === "ok")).toBe(true);

        const fp = opsFile(uri);
        const buf = readFileSync(fp);
        for (const [i, rec] of recs.entries()) {
            // ref = 该轮第一条 op 的行首、整行含换行
            const seg = buf.subarray(rec.ref.ops.offset, rec.ref.ops.offset + rec.ref.ops.len).toString("utf-8");
            expect(seg.endsWith("\n")).toBe(true);
            const first = JSON.parse(seg.split("\n")[0]!) as Op;
            expect(first).toMatchObject({ op: "start", kind: "turn", id: rec.turnId });
            // seq = 该行在 ops.jsonl 里的 1-based 物理行号
            const before = buf.subarray(0, rec.ref.ops.offset).toString("utf-8");
            const line = before.split("\n").length; // offset 前有 N 个 \n ⇒ 该行行号 = N+1 ... 见下
            expect(rec.ref.ops.seq).toBe(line);
            // 逐字一致：从该轮 op 流里取 user 文本 + 全部 assistant 文本
            const turnOps = (i === 0 ? ops1 : ops2).filter(
                (o) => o.op === "start" && o.kind === "text" && o.id.startsWith(`${rec.turnId}_`),
            ) as Extract<Op, { op: "start" }>[];
            const contents = turnOps.map((s) => {
                const delta = (i === 0 ? ops1 : ops2).find(
                    (o) => o.op === "delta" && o.id === s.id && typeof o.fields["content"] === "string",
                ) as Extract<Op, { op: "delta" }> | undefined;
                return { role: (s.meta?.["role"] as string) ?? "", content: delta?.fields["content"] ?? "" };
            });
            expect(contents.filter((c) => c.role === "user").map((c) => c.content)).toEqual([rec.user]);
            expect(rec.texts.map((t) => t.text)).toEqual(contents.filter((c) => c.role === "assistant").map((c) => c.content));
        }
        // 第二轮的 ref 必须指向第二轮（偏移严格大于第一轮）
        expect(recs[1]!.ref.ops.offset).toBeGreaterThan(recs[0]!.ref.ops.offset);
    });

    it("写失败不影响轮末收口（turns 路径是目录 ⇒ EISDIR，只 warn，轮次照常 stop）", async () => {
        const uri = newTask();
        // 先把 turns 路径占成目录：appendFileSync 必失败 —— 这就是"磁盘写不进去"的可控等价物
        const fp = turnsFile(uri);
        rmSync(fp, { recursive: true, force: true });
        mkdirSync(fp, { recursive: true });
        const before = existsSync(opsFile(uri)) ? statSync(opsFile(uri)).size : 0;
        const ops = await collect(manager().chat(uri, "写失败也要收口"));
        expect(ops.filter((o) => o.op === "start" && o.kind === "turn")).toHaveLength(1);
        expect(ops.filter((o) => o.op === "stop")).not.toHaveLength(0);
        // ops 真的写了（旁路失败不拦会话）
        expect(statSync(opsFile(uri)).size).toBeGreaterThan(before);
        // 且 turns 一条也没有（写不进去）
        expect(() => readTurnRecords(uri)).not.toThrow();
        expect(readTurnRecords(uri)).toEqual([]);
    });

    it("appendTurnRecord 自身不抛（路径是目录时返回 false）", () => {
        const uri = newTask();
        const fp = turnsFile(uri);
        rmSync(fp, { recursive: true, force: true });
        mkdirSync(fp, { recursive: true });
        const rec: TurnRecordV1 = {
            v: 1,
            turnId: "t1",
            at: new Date().toISOString(),
            state: "ok",
            user: "x",
            texts: [],
            ref: { ops: { offset: 0, len: 1, seq: 1 } },
        };
        expect(appendTurnRecord(uri, rec)).toBe(false);
    });
});

// ─── 64KB 截断 ───────────────────────────────────────

describe("体量控制：单条超 64KB 只截该条（不丢整轮）", () => {
    it("clipTurnText：超限标 truncated + 原字节数，且不切在多字节字符中间", () => {
        const head = "汉".repeat(Math.ceil(TURN_TEXT_MAX_BYTES / 3) + 100); // 3 字节/字 ⇒ 必超限
        const r = clipTurnText(head);
        expect(r.truncated).toBe(true);
        expect(r.bytes).toBe(Buffer.byteLength(head, "utf-8"));
        expect(Buffer.byteLength(r.text, "utf-8")).toBeLessThanOrEqual(TURN_TEXT_MAX_BYTES);
        expect(r.text).not.toContain("\uFFFD"); // 无替换符 = 没切坏字符
    });

    it("不超限 ⇒ 原样返回、无 truncated 字段", () => {
        expect(clipTurnText("短句")).toEqual({ text: "短句" });
    });

    it("落盘侧：超长 user 截断但轮次仍写成功，texts 也在", () => {
        const uri = newTask();
        const huge = "长".repeat(30_000); // ~90KB
        appendTurnRecord(uri, {
            v: 1,
            turnId: "t1",
            at: "2026-10-24T00:00:00.000Z",
            state: "ok",
            ...(() => {
                const c = clipTurnText(huge);
                return { user: c.text, userTruncated: true as const, userBytes: c.bytes! };
            })(),
            texts: [{ seq: 3, text: "结论" }],
            ref: { ops: { offset: 0, len: 1, seq: 1 } },
        });
        const [rec] = turnsOf(uri);
        expect(rec!.userTruncated).toBe(true);
        expect(rec!.userBytes).toBe(Buffer.byteLength(huge, "utf-8"));
        expect(rec!.texts).toEqual([{ seq: 3, text: "结论" }]);
    });
});

// ─── ref 悬空三种（刀 2 §3） ─────────────────────────

describe("ref 校验：三种悬空各有判据", () => {
    /** 造一份"一条 op 一行"的 ops 文件 + 对应的 turns 记录（offset/len/seq 全对） */
    function fixture(): { uri: string; rec: TurnRecordV1 } {
        const uri = newTask();
        const fp = opsFile(uri);
        mkdirSync(join(fp, ".."), { recursive: true });
        const line = `${JSON.stringify({ op: "start", id: "t1", kind: "turn" })}\n`;
        writeFileSync(fp, line, "utf-8");
        const rec: TurnRecordV1 = {
            v: 1,
            turnId: "t1",
            at: "2026-10-24T00:00:00.000Z",
            state: "ok",
            user: "问",
            texts: [],
            ref: { ops: { offset: 0, len: Buffer.byteLength(line, "utf-8"), seq: 1 } },
        };
        return { uri, rec };
    }

    it("正常 ⇒ ok（对照组）", () => {
        const { uri, rec } = fixture();
        expect(checkOpsRef(uri, rec)).toEqual({ ok: true });
    });

    it("① 文件缺失 ⇒ dangling（missing）", () => {
        const { uri, rec } = fixture();
        rmSync(opsFile(uri), { force: true });
        expect(checkOpsRef(uri, rec)).toEqual({ ok: false, reason: "missing" });
    });

    it("② 越界（offset+len > size）⇒ dangling（range）", () => {
        const { uri, rec } = fixture();
        const bigger = { ...rec, ref: { ops: { ...rec.ref.ops, len: rec.ref.ops.len + 64 } } };
        expect(checkOpsRef(uri, bigger)).toEqual({ ok: false, reason: "range" });
    });

    it("③ 行号不符（前面被插了一行）⇒ dangling（seq）", () => {
        const { uri, rec } = fixture();
        const fp = opsFile(uri);
        const prev = readFileSync(fp, "utf-8");
        // 在行首插一行 ⇒ offset/len 仍指向原来那一行，但它的物理行号变成 2
        writeFileSync(fp, `${JSON.stringify({ op: "start", id: "t0", kind: "turn" })}\n${prev}`, "utf-8");
        const shifted = { ...rec, ref: { ops: { ...rec.ref.ops, offset: rec.ref.ops.offset + Buffer.byteLength(`${JSON.stringify({ op: "start", id: "t0", kind: "turn" })}\n`) } } };
        expect(checkOpsRef(uri, shifted)).toEqual({ ok: false, reason: "seq" });
    });
});

// ─── 刀 2：降级链（真删一次 ops） ─────────────────────

describe("降级链：ops 不可用时用 turns 重建只读文本历史", () => {
    it("删掉 ops.jsonl ⇒ historyWindow 走 missing 降级：N 轮文本 + 横幅标记 + 行内悬空", async () => {
        const uri = newTask();
        const mgr = manager();
        await collect(mgr.chat(uri, "第一问"));
        await collect(mgr.chat(uri, "第二问"));
        const recs = turnsOf(uri);
        expect(recs).toHaveLength(2);

        rmSync(opsFile(uri), { force: true }); // 真删一次（自动化里的"oper 被清理"）
        const fresh = manager(); // 新 manager = 冷会话（不借用内存块树）
        const w = fresh.historyWindow(uri, {});
        expect(w.degraded).toMatchObject({ cause: "missing", turns: 2, dangling: 2 });
        expect(w.degraded!.note).toContain("不存在");
        expect(w.hasMore).toBe(false);

        // 折成文本历史：两轮 turn 块，每轮 user + assistant
        const turns = w.ops.filter((o) => o.op === "start" && o.kind === "turn") as Extract<Op, { op: "start" }>[];
        expect(turns).toHaveLength(2);
        const contents = w.ops
            .filter((o): o is Extract<Op, { op: "delta" }> => o.op === "delta" && typeof o.fields["content"] === "string")
            .map((o) => o.fields["content"]);
        expect(contents).toContain("第一问");
        expect(contents).toContain("第二问");
        // 每轮都标 refDangling（锚点指向的 ops 已经不在了）
        const patches = w.ops.filter(
            (o): o is Extract<Op, { op: "patch" }> => o.op === "patch" && typeof o.fields["degraded"] === "object",
        );
        expect(patches).toHaveLength(2);
        expect(patches.every((p) => (p.fields["degraded"] as { refDangling?: boolean }).refDangling === true)).toBe(true);

        // `history()`（CLI 口径）同一份
        expect(fresh.history(uri).length).toBe(w.ops.length);
    });

    it("截断 ops（账本说压缩时更长 ⇒ truncated）⇒ 同样降级，且不报 stale / 不空栏", async () => {
        const uri = newTask();
        const mgr = manager();
        await collect(mgr.chat(uri, "第一问"));
        const fp = opsFile(uri);
        const size = statSync(fp).size;
        // 账本：opsBytes 比现在大 ⇒ resolveOpsReplay 判 truncated（文件比压缩时短）
        writeFileSync(
            compactFile(uri),
            `${JSON.stringify({
                kind: "compact",
                v: 4,
                id: "2026-10-24T00:00:00.000Z",
                ts: "2026-10-24T00:00:00.000Z",
                schema: 1,
                by: "cli",
                trigger: "manual",
                policy: { mode: "budget", modeData: { budgetBytes: 61440 }, summary: false },
                boundary: {
                    keptFromTurnId: null,
                    keepFromOpIndex: 0,
                    keptFromOpsOffset: size,
                    keptFromLlmLine: 1,
                    opsBytes: size + 4096,
                },
                size: {
                    before: { turns: 1, messages: 2, bytes: 1, estTokens: 1 },
                    after: { turns: 1, messages: 2, bytes: 1, estTokens: 1 },
                    keptTurns: 1,
                    droppedTurns: 0,
                },
            })}\n`,
            "utf-8",
        );
        const fresh = manager();
        const w = fresh.historyWindow(uri, {});
        expect(w.degraded?.cause).toBe("truncated");
        expect(w.stale).toBe(false);
        expect(w.ops.filter((o) => o.op === "start" && o.kind === "turn")).toHaveLength(1);
    });

    it("正常路径（ops 可读）不降级：degraded 缺省 undefined、行为与改动前一致", async () => {
        const uri = newTask();
        const mgr = manager();
        await collect(mgr.chat(uri, "正常一问"));
        const w = manager().historyWindow(uri, {});
        expect(w.degraded).toBeUndefined();
        expect(w.ops.length).toBeGreaterThan(0);
        // turns 只是旁路材料：正常路径**不消费**它（回包里的轮来自 ops）
        expect(w.ops.some((o) => o.op === "patch" && o.fields["degraded"] !== undefined)).toBe(false);
    });
});
