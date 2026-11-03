// tests/core/context-changelog-baseline.test.ts
// 🎯 ##310：**起点的写入时机** —— 变更日志里 baseline 什么时候写。
//
// 契约（用户 2026-10-15 拍板）：
//   · `baseline` 的语义是**一段会话的起点**，一个文件里**可以有多条**（每段一条）；
//   · 判据 = 「文件里还没有二版记录」**或**「有重置标记」；
//   · 重置入口 = `LocalAgentManager.markRebaseline`（会话清零 / `diy context rebaseline` 命令）——
//     **临时**手段：会话注册表落地后由「会话启动」自动置位，动作一模一样（置标记 → 下一次真发写起点）；
//   · **进程重启不算会话边界**（标记是内存态，重启即清空 —— 对话从盘上重建、继续）。
//
// 手法同 context-refresh.test.ts：桩模型把「轮/步边界」变成确定事件，断言口径 = 落盘文件。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { readCtxLog } from "../../src/main/core/context-changelog";
import { isV2Entry, type CtxLogEntry } from "../../src/shared/context/changelog";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "ctx-baseline-work"));
});
let seq = 0;
const newUri = (): string => createTask({ title: `起点写入 ${++seq}`, project: PROJECT });

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
    return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
                for (const p of parts) c.enqueue(p);
                c.close();
            },
        }),
    };
}

/** 一个 manager 管一个任务的多轮（`markRebaseline` 是实例级内存态，跨轮要复用同一个实例） */
function makeMgr(): LocalAgentManager {
    const model = new MockLanguageModelV3({
        provider: "stub",
        modelId: "stub-model",
        doStream: () => Promise.resolve(textReply("好")),
    });
    return new LocalAgentManager(() => model as unknown as LanguageModel);
}
async function turn(mgr: LocalAgentManager, uri: string, text: string): Promise<void> {
    for await (const _op of mgr.chat(uri, text)) void _op;
}

const v2 = (uri: string): CtxLogEntry[] => readCtxLog(uri).filter(isV2Entry);

describe("起点的写入时机（##310）：首轮落一条；重置后再落一条", () => {
    it("新任务第一轮落一条 baseline；第二轮没变仍是那一条（不空写）", async () => {
        const uri = newUri();
        const mgr = makeMgr();
        await turn(mgr, uri, "开始");
        expect(v2(uri).map((e) => e.type)).toEqual(["baseline"]);

        await turn(mgr, uri, "继续");
        expect(v2(uri).map((e) => e.type)).toEqual(["baseline"]);
    });

    it("★ markRebaseline → 下一次真发再落一条起点（一个文件可有多段）", async () => {
        const uri = newUri();
        const mgr = makeMgr();
        await turn(mgr, uri, "开始");
        expect(v2(uri).map((e) => e.type)).toEqual(["baseline"]);

        mgr.markRebaseline(uri);
        await turn(mgr, uri, "继续");
        const after = v2(uri);
        expect(after.map((e) => e.type)).toEqual(["baseline", "baseline"]);
        // seq 是文件内单调序号：起点接着上一段续写，不是另起一个文件
        expect(after.map((e) => e.seq)).toEqual([0, 1]);
        // ref 指向**写这条起点的那一步**（重置是"下一步作数"，不是"重置那一刻"）
        expect(after[1]!.ref.step).toBe(1);
    });

    it("标记是一次性的：写掉之后下一步不再写起点", async () => {
        const uri = newUri();
        const mgr = makeMgr();
        await turn(mgr, uri, "开始");
        mgr.markRebaseline(uri);
        await turn(mgr, uri, "继续"); // 这一步销掉标记
        await turn(mgr, uri, "再来"); // 这一步不该再写起点
        expect(v2(uri).map((e) => e.type)).toEqual(["baseline", "baseline"]);
    });
});
