// replay.test.ts — 证明「录制的 fixture 能在各层复用」
//
// 这里只在**最小层**验：fixture 结构对、replay 能喂给 streamText。
// 真正的业务断言（渲染出什么块 / journal 写什么）由各包自己的测试做 ——
// 同一份 fixture 被不同层 import 即可，不需要重复录制。

import { describe, expect, it } from "vitest";
import { streamText } from "ai";
import { replay } from "../src/replay.js";
import { textOnly, toolOk, abort } from "./fixtures/llm/index.js";

describe("fixture 结构", () => {
    it("textOnly：provider 层形状（stream-start / reasoning / text-delta / finish）", () => {
        const types = textOnly.map((p) => p.type);
        expect(types[0]).toBe("stream-start");
        expect(types).toContain("text-delta");
        expect(types).toContain("finish");
    });

    it("toolOk：含 tool-call（模型给的参数），**不含 tool-result**（那是我们的代码执行出来的）", () => {
        const calls = toolOk.filter((p) => p.type === "tool-call");
        expect(calls.length).toBeGreaterThan(0);
        // 关键分工：provider 层只录模型输出；工具执行属于被测代码，
        // 由测试注入真跑或 stub —— 所以 fixture 里**不该有** tool-result。
        expect(toolOk.filter((p) => p.type === "tool-result")).toHaveLength(0);
        for (const c of calls) expect((c as { toolName?: string }).toolName).toBeTruthy();
    });

    it("abort：录到中断点就停（不该出现 finish）", () => {
        expect(abort.length).toBeGreaterThan(0);
        expect(abort.map((p) => p.type)).not.toContain("finish");
    });
});

describe("回放", () => {
    it("asModel() 能被 streamText 消费，且每次调用都从头发", async () => {
        const r = replay(textOnly);
        const taken = async (): Promise<number> => {
            let n = 0;
            for await (const _ of streamText({ model: r.asModel(), prompt: "x" }).fullStream) n += 1;
            return n;
        };
        const first = await taken();
        const second = await taken();
        expect(first).toBeGreaterThan(0);
        expect(second).toBe(first); // fixture 不被消费 —— 可重复回放
    });
});
