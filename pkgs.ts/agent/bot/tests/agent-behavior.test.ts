// agent-behavior.test.ts —— BotAgent 的**行为级**测试（##518 新口径样板）
//
// 与 `agent-prefix.test.ts` 的分工：那里守「前缀逐字不变」这一个总体验证点；
// 这里守**调用方（bot / chat 页面）看得到的行为**：一次 send 返回什么、system 注入没注入、
// 历史是不是只追加。
//
// 写法（见 docs/test-ownership.md）：只走公开 API（`createBotAgent` → `send`）；只在一处用替身（LLM）；
// 会话存储用内存真实现；断言调用方看得到的东西，不碰内部字段。
//
// ⚠️ 上下文树的最小 provider 集是 **4 项**（`diy` / `cwd` / `chain` / `skills`）：
//    少任何一个，delivery 的 zod 校验就会报「expected object/array, received undefined」。
//    这是踩了 6 次才定位到的 —— 记在这里，下一个人别再试。
import { describe, expect, it } from "vitest";
import { openMemorySessionStore } from "@diy-agent/session";
import type { LlmPort, SessionDelta } from "@diy-agent/session";
import type { ContextProvider } from "@diy-agent/context";
import { createBotAgent } from "../src/agent.js";

/** LLM 是唯一允许的替身（花钱且不确定）：固定回一句，并数被调用了几次 */
function scriptedLlm(): LlmPort & { calls: number } {
    const port = {
        calls: 0,
        async *chat(): AsyncGenerator<SessionDelta> {
            port.calls += 1;
            yield { type: "text", text: "好" } as SessionDelta;
            yield { type: "done", stopReason: "stop" } as SessionDelta;
        },
    };
    return port as unknown as LlmPort & { calls: number };
}

/** 上下文树要求的最小 provider 集（四项都得有） */
function baseProviders(): ContextProvider[] {
    return [
        { key: "diy", provide: () => ({ cli: "diy", home: "/tmp/x" }) },
        { key: "cwd", provide: () => ({ path: "/tmp/x", note: "", isFallback: false, isTaskDir: false, isAppDir: false }) },
        { key: "chain", provide: () => [] },
        { key: "skills", provide: () => [] },
    ];
}

function makeAgent(llm: LlmPort) {
    return createBotAgent({
        id: "s-behavior",
        llm,
        store: openMemorySessionStore(),
        model: "test/model",
        providers: baseProviders(),
        instructions: "",
        initialSnapshot: null,
    });
}

describe("BotAgent：send 给调用方什么", () => {
    it("返回拼接文本；deltas 以 done 收尾；LLM 只被调用一次", async () => {
        const llm = scriptedLlm();
        const agent = makeAgent(llm);
        const result = await agent.send("在吗");

        expect(result.text).toBe("好");
        expect(result.deltas.at(-1)?.type).toBe("done");
        expect(llm.calls).toBe(1);
    });

    it("两轮之后历史只追加：两轮的用户正文都在，顺序不变", async () => {
        const agent = makeAgent(scriptedLlm());
        await agent.send("第一句");
        const second = await agent.send("第二句");

        const users = (second.request?.messages ?? []).filter((m) => m.role === "user");
        expect(users.length).toBeGreaterThanOrEqual(2);
        expect(String(users.at(-2)?.text ?? "")).toContain("第一句");
        expect(String(users.at(-1)?.text ?? "")).toContain("第二句");
    });
});

describe("BotAgent：system 注入", () => {
    it("新会话 ⇒ 第一条是 system，且非空（由 providers 渲染而来）", async () => {
        const agent = makeAgent(scriptedLlm());
        const result = await agent.send("hi");
        const first = result.request?.messages?.[0];
        expect(first?.role).toBe("system");
        expect(String(first?.text ?? "").length).toBeGreaterThan(0);
    });
});
