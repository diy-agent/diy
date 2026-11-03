// tests/core/local-agent-warm-wait.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##486 冷缓存等待的**接线**验证（真跑 runTurn，桩模型，无网络 / 无 Electron）
//
// 判据（任务 body）：
//   1. 上一步全冷 ⇒ 本步前等 1000ms（账上有 `waitedMs` 能证明）
//   2. 上一步正常 ⇒ **零延迟**（账上没有 `waitedMs`，且这一轮明显更快）
//   3. 小请求（输入 ≤ 50000）不等
//   5. `DIY_NO_WARM_WAIT=1` 一律不等
//
// 为什么必须真跑：`waitedMs` 是**落账**的字段，只有走完 prepareStep → finish-step
// 这条链才出现；纯函数测试证明不了「等的那一下真的接在了发请求前」。
// 判据口径与阈值本身在 tests/core/warm-wait.test.ts（那里还有零延迟的对比测试）。
//
// 桩模型的 usage 由用例指定：轮 A 全冷（input 100k / cacheRead 0），轮 B 暖（缓存读 90%）。
// 于是 轮 A 第 1 步 = 首次请求（没有上一步，不等）；轮 B 第 1 步 = 上一步全冷（等 1s）；
// 轮 C 第 1 步 = 上一步正常（不等）。三轮各钉一条判据。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
import type {
    LanguageModelV3StreamPart,
    LanguageModelV3StreamResult,
    LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager, readStepUsages } from "../../src/main/services/local-agent";
import type { Op } from "../../src/main/services/local-blocks";

let PROJECT = "1";
beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不用它，但 chat 入口会校验
    PROJECT = createProject(join(diyHome(), "warm-wait-work"));
});

let seq = 0;
function newUri(): string {
    return createTask({ title: `冷缓存等待测试 ${++seq}`, project: PROJECT });
}

/** 一次性输入 100k 的 usage：`cacheRead` 决定「上一步」是冷还是暖 */
function usageOf(cacheRead: number): LanguageModelV3Usage {
    return {
        inputTokens: { total: 100_000, noCache: 100_000 - cacheRead, cacheRead, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
    };
}

function textReply(text: string, cacheRead: number): LanguageModelV3StreamResult {
    const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usageOf(cacheRead) },
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

/** 按调用序返回预置流；越界复用最末一条 */
function stubModel(replies: LanguageModelV3StreamResult[]): MockLanguageModelV3 {
    let call = 0;
    return new MockLanguageModelV3({
        provider: "stub",
        modelId: "stub-warm-wait",
        doStream: () => Promise.resolve(replies[Math.min(call++, replies.length - 1)]!),
    });
}

/** 跑一轮，返回 { ops, elapsedMs } */
async function runTurn(uri: string, message: string, model: MockLanguageModelV3): Promise<{ ops: Op[]; elapsedMs: number }> {
    const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
    const t0 = Date.now();
    const ops: Op[] = [];
    for await (const op of mgr.chat(uri, message)) ops.push(op);
    return { ops, elapsedMs: Date.now() - t0 };
}

describe("冷缓存等待（##486）—— 账上能证明，且正常路径零延迟", () => {
    it("首次请求不等；上一步全冷 ⇒ 下一步等 1000ms 并落 waitedMs；上一步正常 ⇒ 不等", async () => {
        const uri = newUri();
        // 第 1 轮全冷（这一步之后，「上一步」= 全冷）；第 2 轮起都暖
        const model = stubModel([textReply("甲", 0), textReply("乙", 90_000), textReply("丙", 90_000)]);

        const a = await runTurn(uri, "一", model);
        const b = await runTurn(uri, "二", model);
        const c = await runTurn(uri, "三", model);

        const rows = readStepUsages(uri);
        expect(rows.map((r) => r.step), "每轮一步 ⇒ 三行账").toEqual([1, 1, 1]);
        const [ra, rb, rc] = rows as [(typeof rows)[0], (typeof rows)[0], (typeof rows)[0]];

        // 判据 1/3：轮 A 是首次请求（没有上一步）⇒ 不等、也没有 waitedMs 这个键
        expect(ra.waitedMs, "首次请求不该等").toBeUndefined();

        // 判据 1：轮 B 的上一步（轮 A）全冷 ⇒ 等 1000ms，且**等在这一步的账上**
        expect(rb.waitedMs, "上一步全冷 ⇒ 本步前等 1000ms").toBe(1000);
        // 判据 4 的数据形状：只有等过的步才有这个字段，等多久就是多久
        expect(ra.usage.inputTokenDetails.cacheReadTokens).toBe(0);

        // 判据 2：轮 C 的上一步（轮 B）正常 ⇒ 零延迟（没等待字段）
        expect(rc.waitedMs, "上一步正常 ⇒ 不等").toBeUndefined();

        // 判据 2 的行为侧证据：轮 C 比轮 B 至少省下那 500ms（同一条桩模型，差异只有那 1 秒）
        expect(b.elapsedMs - c.elapsedMs, `轮 B ${b.elapsedMs}ms vs 轮 C ${c.elapsedMs}ms`).toBeGreaterThan(500);

        // 三轮都正常收尾（等待没有把轮次搅坏）
        for (const r of [a, b, c]) {
            const turnIds = r.ops
                .filter((o) => o.op === "start" && o.kind === "turn")
                .map((o) => (o as { id: string }).id);
            expect(turnIds.length, "每轮应有 turn 块").toBe(1);
            const stops = new Set(r.ops.filter((o) => o.op === "stop").map((o) => (o as { id: string }).id));
            expect(stops.has(turnIds[0]!), "轮次应正常收尾").toBe(true);
        }
    });

    it("小请求（输入 ≤ 50000）全冷也不等", async () => {
        const uri = newUri();
        const small = (text: string): LanguageModelV3StreamResult => {
            const parts: LanguageModelV3StreamPart[] = [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: text },
                { type: "text-end", id: "t" },
                {
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                        inputTokens: { total: 20_000, noCache: 20_000, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 5, text: 5, reasoning: 0 },
                    } satisfies LanguageModelV3Usage,
                },
            ];
            return {
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                    start(c) {
                        for (const p of parts) c.enqueue(p);
                        c.close();
                    },
                }),
            };
        };
        const model = stubModel([small("甲"), small("乙")]);
        await runTurn(uri, "一", model);
        await runTurn(uri, "二", model);
        const rows = readStepUsages(uri);
        expect(rows.every((r) => r.waitedMs === undefined), "小请求不启用等待").toBe(true);
    });

    it("DIY_NO_WARM_WAIT=1 ⇒ 全冷也不等", async () => {
        const uri = newUri();
        const model = stubModel([textReply("甲", 0), textReply("乙", 0)]);
        process.env["DIY_NO_WARM_WAIT"] = "1";
        try {
            await runTurn(uri, "一", model);
            await runTurn(uri, "二", model);
        } finally {
            delete process.env["DIY_NO_WARM_WAIT"];
        }
        const rows = readStepUsages(uri);
        expect(rows.every((r) => r.waitedMs === undefined), "开关关掉后一律不等").toBe(true);
    });
});
