// tests/core/local-llm-log.test.ts
// 🎯 llm.jsonl = **append-only 全量消息日志**（##269 D1）
//
// 三条契约（每条都对应一个真实会踩的坑）：
//   ① 只增：新一轮追加，已写行的字节永远不变（D2 的索引锚点是行号，行号一动索引就废）
//   ② 与压缩解耦：压缩只改**投递**，日志仍是全量 —— 否则"被压掉的轮"就真的没了
//   ③ 崩溃自愈：加载时补 stop + 补齐日志（旧实现靠"下轮整份重写"糊过去，append 后不会自愈）

import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { DEFAULT_COMPACT_POLICY } from "../../src/shared/context/compaction";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_ZEN_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "llm-log-work"));
});

let seq = 0;
const newUri = (): string => createTask({ title: `日志测试 ${++seq}`, project: PROJECT });

const usage: LanguageModelV3Usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textReply(text: string): LanguageModelV3StreamResult {
    const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ];
    return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
}

function stubModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        provider: "stub",
        modelId: "stub-model",
        doStream: () => Promise.resolve(textReply("答复")),
    });
}

async function run(mgr: LocalAgentManager, uri: string, message: string): Promise<void> {
    for await (const _op of mgr.chat(uri, message)) void _op;
}

/** 该任务的三份文件路径（keyOf 规则：字符净化前 64 + sha256 前 12） */
function filesOf(uri: string) {
    const readable = uri.replace(/[^\w.-]+/g, "_").slice(0, 64);
    const key = `${readable}-${createHash("sha256").update(uri).digest("hex").slice(0, 12)}`;
    const dir = join(diyHome(), "local");
    return {
        ops: join(dir, `${key}.ops.jsonl`),
        llm: join(dir, `${key}.llm.jsonl`),
        compact: join(dir, `${key}.compact.jsonl`),
    };
}

const readLines = (fp: string): string[] =>
    existsSync(fp) ? readFileSync(fp, "utf-8").split("\n").filter((l) => l.trim() !== "") : [];

describe("llm 全量日志：只增 + 与压缩解耦", () => {
    it("① 一轮对话 → 写出全量消息（行 = 原生 ModelMessage）", async () => {
        const uri = newUri();
        await run(new LocalAgentManager(() => stubModel() as unknown as LanguageModel), uri, "你好");
        const lines = readLines(filesOf(uri).llm);
        expect(lines.length).toBeGreaterThanOrEqual(2);
        const roles = lines.map((l) => (JSON.parse(l) as { role: string }).role);
        expect(roles[0]).toBe("user");
        expect(roles).toContain("assistant");
    });

    it("② 第二轮 = 追加：已写行逐字不变（行号即索引）", async () => {
        const uri = newUri();
        const mgr = new LocalAgentManager(() => stubModel() as unknown as LanguageModel);
        await run(mgr, uri, "第一句");
        const first = readLines(filesOf(uri).llm);
        await run(mgr, uri, "第二句");
        const second = readLines(filesOf(uri).llm);
        expect(second.length).toBeGreaterThan(first.length);
        // 前缀逐字相同 —— 这是"只增"的定义，也是 D2 索引行号能对上的前提
        expect(second.slice(0, first.length)).toEqual(first);
    });

    it("③ 压缩只改投递：全量日志不缩水、被压掉的轮仍在", async () => {
        const uri = newUri();
        const mgr = new LocalAgentManager(() => stubModel() as unknown as LanguageModel);
        await run(mgr, uri, "会被压掉的旧话");
        const before = readLines(filesOf(uri).llm);
        // 造一条压缩账（keepTurns=0 = 全清；keepFromOpIndex 越界 → 投递侧空历史）
        writeFileSync(
            filesOf(uri).compact,
            JSON.stringify({
                kind: "compact",
                v: 1,
                id: "test-c1",
                ts: new Date().toISOString(),
                by: "cli",
                policy: { ...DEFAULT_COMPACT_POLICY, keepTurns: 0 },
                boundary: { keptFromTurnId: null, keepFromOpIndex: 99999, keptTurns: 0, droppedTurns: 1 },
                before: { turns: 1, messages: 2, bytes: 0, estTokens: 0 },
                after: { turns: 0, messages: 0, bytes: 0, estTokens: 0 },
            }) + "\n",
            "utf-8",
        );
        await run(mgr, uri, "压缩之后的新话");
        const after = readLines(filesOf(uri).llm);
        expect(after.length).toBeGreaterThan(before.length);
        expect(after.slice(0, before.length)).toEqual(before);
        // 被压掉的那句**仍在全量日志里**（压缩是投递期投影，不是销毁）
        expect(after.join("\n")).toContain("会被压掉的旧话");
    });
});

describe("崩溃残留自愈（加载时收敛 + 补齐日志）", () => {
    it("停在半轮的 ops：加载补 stop，且旧轮进了全量日志", async () => {
        const uri = newUri();
        const f = filesOf(uri);
        // 手工造一个"被杀在半路"的轮：turn 未 stop、user 文本块未 stop
        writeFileSync(
            f.ops,
            [
                JSON.stringify({ op: "start", id: "t_half", kind: "turn" }),
                JSON.stringify({ op: "start", id: "t_half_u", kind: "text", parent: "t_half", meta: { role: "user" } }),
                JSON.stringify({ op: "delta", id: "t_half_u", fields: { content: "半截的话" } }),
            ].join("\n") + "\n",
            "utf-8",
        );
        await run(new LocalAgentManager(() => stubModel() as unknown as LanguageModel), uri, "新的一句");
        const opsText = readFileSync(f.ops, "utf-8");
        expect(opsText).toContain('"op":"stop","id":"t_half"');
        expect(opsText).toContain('"op":"stop","id":"t_half_u"');
        expect(readLines(f.llm).join("\n")).toContain("半截的话");
    });

    it("日志尾部被写脏：加载对账整份重建并出声", async () => {
        const uri = newUri();
        const f = filesOf(uri);
        await run(new LocalAgentManager(() => stubModel() as unknown as LanguageModel), uri, "正常一句");
        const clean = readLines(f.llm);
        // 追加一行不属于投影的脏行
        writeFileSync(f.llm, clean.join("\n") + "\n" + JSON.stringify({ role: "user", content: "脏行" }) + "\n", "utf-8");
        await run(new LocalAgentManager(() => stubModel() as unknown as LanguageModel), uri, "再来一句");
        const after = readLines(f.llm);
        expect(after.join("\n")).not.toContain("脏行");
        expect(after.slice(0, clean.length)).toEqual(clean);
    });
});
