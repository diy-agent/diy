// tests/core/local-agent-bash-spawn-error.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##332：bash 工具的 **spawn / IO 失败**必须变成 tool 块的 status:"error"
//
// 现象：`bash` 的**进程级失败**（命令根本没跑起来）与命令级失败合流成普通文本，
//   工具行**误标成功 ✓**（比 ##329 的 read 更隐蔽 —— 连文案都不一定显眼）。
//
// 根因：`runBash` 是 `new Promise(resolve)`——**从不 reject**。spawn / IO 失败
//   （cwd 不存在 / 无权限、`/bin/bash` 缺失）落到「收成文本」那一档 ⇒ `execute` 正常 return
//   ⇒ AI SDK 走 `tool-result` 分支 ⇒ patch `status:"done"` ⇒ UI 画 ✓。
//   只有 `tool-error` 分支才 `status:"error"`（与 ##329 同族：catch-and-return 吞错）。
//
// 口径（本任务定，真源 = `runBash` 头注）：
//   ① 命令级非零退出（`err.code` 是**数字**）—— ##353 已复议，本任务不动；
//   ② 超时 / 取消（`err.killed` / AbortError）—— 当数据（保持现状）；
//   ③ spawn / IO 失败（`err.code` **非数字**）—— **失败**：execute 抛 → SDK 发 tool-error。
//
// 为什么必须端到端（照 ##329 的 local-agent-read-error.test.ts）：断言的对象是
//   「execute 抛/不抛 → SDK 发 tool-error 还是 tool-result → ops 落哪个 status」这条链路，
//   单测只能证明"抛了"。
//
// ⚠️ ③ 有**两条到达路径**，本文件各锁一条（实测 node 24 行为不同）：
//   · cwd 不可进入（EACCES）⇒ 走 callback 的 `err`；
//   · cwd 是**普通文件**（ENOTDIR）⇒ execFile **同步抛**，根本不进 callback。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { BlockStore, blocksToMessages, type Op } from "../../src/main/services/local-blocks";

/** cwd 是**普通文件**（ENOTDIR，同步抛路径）的项目 */
let PROJECT_FILE = "1";
/** cwd 是**无权限目录**（EACCES，callback 路径）的项目 */
let PROJECT_NOPERM = "1";
/** 正常目录（①② 对照） */
let PROJECT_OK = "1";
let NOPERM_DIR = "";

beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不用它，但 chat 入口会校验
    // ⚠️ createProject **不建** path 目录（只建 $DIY_HOME/projects/<id>/tasks/）——
    //    目录得测试自己造，否则 resolveCwd 会回退到任务目录（cwd 就不是我们想要的那个了）
    const okDir = join(diyHome(), "bash-spawn-ok");
    mkdirSync(okDir, { recursive: true });
    PROJECT_OK = createProject(okDir);

    // cwd = 普通文件：先按目录建项目（建项目要往 path 写 diy.yaml 名片），再把目录换成同名文件
    const asFile = join(diyHome(), "bash-spawn-file");
    mkdirSync(asFile, { recursive: true });
    PROJECT_FILE = createProject(asFile);
    rmSync(asFile, { recursive: true, force: true });
    writeFileSync(asFile, "");

    // cwd = 无权限目录：建完项目（名片要写进去）再 chmod 000
    NOPERM_DIR = join(diyHome(), "bash-spawn-noperm");
    mkdirSync(NOPERM_DIR, { recursive: true });
    PROJECT_NOPERM = createProject(NOPERM_DIR);
    chmodSync(NOPERM_DIR, 0o000);
});

afterAll(() => {
    // 必须自己收尾：000 目录会让隔离 HOME 的递归删除失败（残留按 24h 清扫逻辑兜底，但不必等）
    chmodSync(NOPERM_DIR, 0o755);
    rmSync(NOPERM_DIR, { recursive: true, force: true });
});

let seq = 0;
const newUri = (project: string): string => createTask({ title: `bash spawn ${++seq}`, project });

// ─── 桩模型（照 local-agent-bash-exit.test.ts / local-agent-read-error.test.ts） ───

const usage: LanguageModelV3Usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function stream(parts: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
    return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
                for (const p of parts) c.enqueue(p);
                c.close();
            },
        }),
    };
}

/** 一段纯文本答复（含 finish，= 该段结束） */
const textReply = (text: string): LanguageModelV3StreamResult =>
    stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ]);

/** 一次 bash 工具调用 */
const bashCallReply = (callId: string, command: string, extra: Record<string, unknown> = {}): LanguageModelV3StreamResult =>
    stream([
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: callId, toolName: "bash" },
        { type: "tool-input-delta", id: callId, delta: JSON.stringify({ command, ...extra }) },
        { type: "tool-input-end", id: callId },
        { type: "tool-call", toolCallId: callId, toolName: "bash", input: JSON.stringify({ command, ...extra }) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
    ]);

/** 造一个按序吐流的桩模型；越界复用最末一条 */
function stubModel(replies: LanguageModelV3StreamResult[]): MockLanguageModelV3 {
    let call = 0;
    return new MockLanguageModelV3({
        provider: "stub",
        modelId: "stub-model",
        doStream: () => Promise.resolve(replies[Math.min(call++, replies.length - 1)]!),
    });
}

/** 上游第 i 次请求的整份 prompt 序列化（判断"模型看见没看见"） */
function promptDump(model: MockLanguageModelV3, callIndex: number): string {
    return JSON.stringify(model.doStreamCalls[callIndex]?.prompt ?? []);
}

async function run(uri: string, model: MockLanguageModelV3): Promise<Op[]> {
    const ops: Op[] = [];
    const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
    for await (const op of mgr.chat(uri, "跑条命令")) ops.push(op);
    return ops;
}

/** 某个 tool 块的终态 status（最后一次 patch 为准） */
function statusOf(ops: Op[], id: string): string | undefined {
    let last: string | undefined;
    for (const op of ops) {
        if (op.op !== "patch" || op.id !== id) continue;
        const s = (op.fields as { status?: unknown }).status;
        if (typeof s === "string") last = s;
    }
    return last;
}

/** 某个 tool 块的 output 正文 */
function outputOf(ops: Op[], id: string): string {
    return ops
        .filter((op): op is Extract<Op, { op: "delta" }> => op.op === "delta" && op.id === id)
        .map((op) => (op.fields as { output?: unknown }).output)
        .filter((v): v is string => typeof v === "string")
        .join("");
}

const toolIds = (ops: Op[]): string[] =>
    ops.filter((o) => o.op === "start" && o.kind === "tool").map((o) => (o as { id: string }).id);

const donePatches = (ops: Op[], id: string): Op[] =>
    ops.filter((o) => o.op === "patch" && o.id === id && (o.fields as { status?: string }).status === "done");

describe("bash spawn / IO 失败 → tool 块 status:error（##332 ③）", () => {
    // Windows 的 chmod 不产生真实权限位（目录仍可进入），EACCES 这条路径只在 POSIX 可复现
    it.skipIf(process.platform === "win32")("cwd 无权限（EACCES，callback 路径）→ status:error，正文给失败文案 + 工作目录", async () => {
        const uri = newUri(PROJECT_NOPERM);
        const model = stubModel([bashCallReply("c1", "echo hi"), textReply("换个目录")]);

        const ops = await run(uri, model);

        const id = toolIds(ops)[0];
        expect(id).toBeTruthy();
        expect(statusOf(ops, id!)).toBe("error");
        const out = outputOf(ops, id!);
        expect(out).toContain("[命令未能启动 EACCES]");
        // 带 cwd 是刻意的：Node 的原文（`spawn /bin/bash EACCES`）会把"目录进不去"说成"bash 有问题"
        expect(out).toContain(NOPERM_DIR);
        // 不能同时又落一条 done —— UI 取最后一次 patch，两条并存说明分支串了
        expect(donePatches(ops, id!)).toHaveLength(0);
    });

    it("cwd 是普通文件（ENOTDIR，execFile 同步抛）→ status:error", async () => {
        const uri = newUri(PROJECT_FILE);
        const model = stubModel([bashCallReply("c1", "echo hi"), textReply("换个目录")]);

        const ops = await run(uri, model);

        const id = toolIds(ops)[0];
        expect(id).toBeTruthy();
        expect(statusOf(ops, id!)).toBe("error");
        // Windows 对「cwd 是普通文件」报 ENOENT（POSIX 是 ENOTDIR）——判据是「没跑起来」，不是具体 errno
        expect(outputOf(ops, id!)).toMatch(/\[命令未能启动 (ENOTDIR|ENOENT)\]/);
    });

    it.skipIf(process.platform === "win32")("模型侧不受影响：失败文案随 tool 结果回灌给下一步，且历史重建是 error-text", async () => {
        const uri = newUri(PROJECT_NOPERM);
        const model = stubModel([bashCallReply("c1", "echo hi"), textReply("换个目录")]);

        const ops = await run(uri, model);

        // 旧行为（吞成文本）能给模型的，现在同样给得到
        expect(promptDump(model, 1)).toContain("[命令未能启动 EACCES]");
        // 判据取**投影**（ops → 块树 → ModelMessage），不取 prompt：同上，见 ##329 的说明
        const store = new BlockStore();
        for (const op of ops) store.apply(op);
        const results = blocksToMessages(store)
            .filter((m) => m.role === "tool")
            .map((m) => (m.content as Array<{ output: { type: string; value: string } }>)[0]!.output);
        expect(results).toHaveLength(1);
        expect(results[0]!.type).toBe("error-text");
        expect(results[0]!.value).toContain("[命令未能启动 EACCES]");
    });

    it("报错不打断这一轮：后续步照常执行、轮次正常收尾", async () => {
        const uri = newUri(PROJECT_FILE);
        const model = stubModel([bashCallReply("c1", "echo hi"), textReply("换条命令试试")]);

        const ops = await run(uri, model);

        expect(model.doStreamCalls).toHaveLength(2);
        const turn = ops.find((o) => o.op === "start" && o.kind === "turn");
        expect(turn).toBeTruthy();
        expect(ops.some((o) => o.op === "stop" && o.id === turn!.id)).toBe(true);
    });
});

describe("既有语义不回归（本任务只动 ③）", () => {
    it("① 非零退出：有 stderr = 失败、静默非零 = 数据（##353 口径不被 ③ 溢出）", async () => {
        // 有错误输出
        const uriA = newUri(PROJECT_OK);
        const modelA = stubModel([bashCallReply("c1", "echo 炸了-332 >&2; exit 1"), textReply("收到")]);
        const opsA = await run(uriA, modelA);
        const idA = toolIds(opsA)[0];
        expect(statusOf(opsA, idA!)).toBe("error");
        expect(outputOf(opsA, idA!)).toContain("[退出码 1]");

        // 静默非零（grep 无匹配）—— 仍是数据 ✓，判据没被 ③ 的"非数字 code"波及
        const uriB = newUri(PROJECT_OK);
        const modelB = stubModel([bashCallReply("c1", "grep -q zzz-332 /dev/null"), textReply("没匹配到")]);
        const opsB = await run(uriB, modelB);
        const idB = toolIds(opsB)[0];
        expect(statusOf(opsB, idB!)).toBe("done");
        expect(outputOf(opsB, idB!)).toContain("[退出码 1]");
    });

    it("② 超时仍当数据（done + [命令超时被杀]），不因 ③ 变 ✗", async () => {
        // ##454：缺省不再设超时（`DIY_LOCAL_BASH_TIMEOUT_MS` 也不再是工具的缺省），
        // 限时只能由**这一步的 `timeout` 实参**指定 —— 用例照这条新口径走。
        const uri = newUri(PROJECT_OK);
        const model = stubModel([bashCallReply("c1", "sleep 5", { timeout: 400 }), textReply("太慢了")]);

        const ops = await run(uri, model);

        const id = toolIds(ops)[0];
        expect(statusOf(ops, id!)).toBe("done");
        expect(outputOf(ops, id!)).toContain("[命令超时被杀]");
    });

    it("② 取消不落入 ③（不许被当成 spawn 失败画 ✗）", async () => {
        // ⚠️ 这条防的是一个**具体的**陷阱：取消的 err 是 `{ name: "AbortError", code: "ABORT_ERR" }`
        //    —— code 也是**字符串**。判据「`err.code` 非数字 ⇒ ③」本来会把它吃进去，全靠
        //    `err.name === "AbortError"` 那一档排在前面兜住（实测）。用例锁的是这个顺序不许被重排。
        // ⚠️ 断言口径刻意放宽到「不是 error」：本用例只守 ③ 的边界。**现状**（不在本任务范围）是
        //    abort 不串到 execFile —— 命令跑满、工具块停在 `running`（见任务 body 的遗留）。
        //    别把这里改成 `toBe("done")`：那是在给另一个行为立规格，得另开任务。
        const uri = newUri(PROJECT_OK);
        const model = stubModel([bashCallReply("c1", "sleep 1"), textReply("停了")]);
        const ac = new AbortController();
        const ops: Op[] = [];
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
        const t = setTimeout(() => ac.abort(), 200);
        try {
            for await (const op of mgr.chat(uri, "跑条命令", undefined, undefined, ac.signal)) ops.push(op);
        } catch {
            // 取消以异常收尾这一轮；轮次收尾形态不在本用例断言范围
        } finally {
            clearTimeout(t);
        }

        const id = toolIds(ops)[0];
        expect(id).toBeTruthy();
        expect(statusOf(ops, id!)).not.toBe("error");
        expect(outputOf(ops, id!)).not.toContain("[命令未能启动");
    });

    it("成功路径不受影响：done + 正文", async () => {
        const uri = newUri(PROJECT_OK);
        const model = stubModel([bashCallReply("c1", "echo 你好-332"), textReply("好了")]);

        const ops = await run(uri, model);

        const id = toolIds(ops)[0];
        expect(statusOf(ops, id!)).toBe("done");
        expect(outputOf(ops, id!)).toContain("你好-332");
    });
});
