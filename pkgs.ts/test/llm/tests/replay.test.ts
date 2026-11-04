// replay.test.ts — 证明「录制的 fixture 能在各层复用」
//
// 这里只在**最小层**验：fixture 结构对、replay 能喂给 streamText。
// 真正的业务断言（渲染出什么块 / journal 写什么）由各包自己的测试做 ——
// 同一份 fixture 被不同层 import 即可，不需要重复录制。

import { describe, expect, it } from "vitest";
import { streamText } from "ai";
import { replay } from "../src/replay.js";
import * as fx from "./fixtures/llm/index.js";

type ErrPart = { error: { statusCode: number; isRetryable: boolean } };
const errOf = (parts: readonly { type: string }[]): ErrPart | undefined =>
    parts.find((p) => p.type === "error") as ErrPart | undefined;

describe("正常路径", () => {
    it("textOnly：provider 层形状（stream-start / text-delta / finish）", () => {
        const types = fx.textOnly.map((p) => p.type);
        expect(types[0]).toBe("stream-start");
        expect(types).toContain("text-delta");
        expect(types).toContain("finish");
    });

    it("think：含 reasoning-delta（思考流）", () => {
        expect(fx.think.map((p) => p.type)).toContain("reasoning-delta");
    });

    it("toolOk：含 tool-call（模型给的参数），**不含 tool-result**（那是我们的代码执行出来的）", () => {
        const calls = fx.toolOk.filter((p) => p.type === "tool-call");
        expect(calls.length).toBeGreaterThan(0);
        // 关键分工：provider 层只录模型输出；工具执行属于被测代码，由测试注入。
        expect(fx.toolOk.filter((p) => p.type === "tool-result")).toHaveLength(0);
    });

    it("toolMultiStep：两次以上 tool-call（step 边界）", () => {
        expect(fx.toolMultiStep.filter((p) => p.type === "tool-call").length).toBeGreaterThan(1);
    });

    it("abort：录到中断点就停（不该出现 finish）", () => {
        expect(fx.abort.length).toBeGreaterThan(0);
        expect(fx.abort.map((p) => p.type)).not.toContain("finish");
    });
});

describe("错误路径（真实历史样本）", () => {
    it("endpointUnavailable：429 server_error「Endpoint is unavailable」· 可重试", () => {
        const e = errOf(fx.endpointUnavailable);
        expect(e?.error.statusCode).toBe(429);
        expect(e?.error.isRetryable).toBe(true);
        expect(JSON.stringify(fx.endpointUnavailable)).toContain("Endpoint is unavailable");
    });

    it("reasoningNotPassed：400 invalid_request_error · **不可重试**（要修回传逻辑）", () => {
        const e = errOf(fx.reasoningNotPassed);
        expect(e?.error.statusCode).toBe(400);
        expect(e?.error.isRetryable).toBe(false);
        expect(JSON.stringify(fx.reasoningNotPassed)).toContain("reasoning_content");
    });

    it("rateLimit：429 rate_limit_error「temporarily unavailable」", () => {
        const e = errOf(fx.rateLimit);
        expect(e?.error.statusCode).toBe(429);
        expect(JSON.stringify(fx.rateLimit)).toContain("temporarily unavailable");
    });
});

describe("回放", () => {
    it("asModel() 能被 streamText 消费，且每次调用都从头发", async () => {
        const r = replay(fx.textOnly);
        const taken = async (): Promise<number> => {
            let n = 0;
            for await (const _ of streamText({ model: r.asModel(), prompt: "x" }).fullStream) n += 1;
            return n;
        };
        const first = await taken();
        const second = await taken();
        expect(first).toBeGreaterThan(0);
        expect(second).toBe(first); // fixture 不被消费
    });
});
