// agent-behavior.test.ts —— BotAgent 的**行为级**测试（##518 新口径样板）
//
// 与 `agent-prefix.test.ts` 的分工：那里守「前缀逐字不变」这一个总体验证点；
// 这里守**调用方（bot / chat 页面）看得到的行为** —— 发出去什么、返回什么、失败了怎么办。
//
// 写法（见 docs/test-ownership.md）：
//   · 只走公开 API（`createBotAgent` → `send` → `result.{text,deltas,request}`），不碰内部字段；
//   · 只在一处用替身：LLM（花钱且不确定）；
//   · 会话存储用**内存真实现**；上下文用真装配（`fixtures/agent.ts` 的最小 provider 集）；
//   · 断言调用方看得到的东西：返回文本、deltas 序列、messages 的形状。
import { describe, expect, it } from "vitest";
import type { SessionDelta } from "@diy-agent/session";
import { baseProviders, makeAgent, replyingLlm, scriptedLlm } from "./fixtures/agent.js";

describe("BotAgent：一次 send 给调用方什么", () => {
    it("返回拼接文本；deltas 以 done 收尾；LLM 只被调用一次", async () => {
        const llm = replyingLlm("好");
        const agent = makeAgent({ llm });
        const result = await agent.send("在吗");

        expect(result.text).toBe("好");
        expect(result.deltas.at(-1)?.type).toBe("done");
        expect(llm.calls).toBe(1);
    });

    it("多块文本按到达顺序拼接（流式输出对调用方是透明的）", async () => {
        const llm = scriptedLlm(() => [
            { type: "text", text: "你" } as SessionDelta,
            { type: "text", text: "好" } as SessionDelta,
            { type: "done", stopReason: "stop" } as SessionDelta,
        ]);
        const result = await makeAgent({ llm }).send("在吗");
        expect(result.text).toBe("你好");
    });

    // ⚠️ 行为记录（实测）：`usage` **不会**出现在 deltas 里 —— `session.send` 在内部把它
    // 累加进 token 统计（见 session/src/session.ts 的 `delta.type === 'usage'` 分支），不转发。
    // 所以「页面显示 token / 成本」不能读 deltas，得读 session 状态（这就是被测出来的分工）。
    it("usage 不进 deltas（由 session 内部累计，调用方要另取）", async () => {
        const llm = scriptedLlm(() => [
            { type: "text", text: "好" } as SessionDelta,
            { type: "usage", inputTokens: 7, outputTokens: 3 } as SessionDelta,
            { type: "done", stopReason: "stop" } as SessionDelta,
        ]);
        const result = await makeAgent({ llm }).send("在吗");

        expect(result.deltas.some((d) => d.type === "usage")).toBe(false);
        expect(result.text).toBe("好"); // 正文照常透传
    });

    it("两轮之后历史只追加：两轮用户正文都在，顺序不变", async () => {
        const agent = makeAgent({ llm: replyingLlm() });
        await agent.send("第一句");
        const second = await agent.send("第二句");

        const users = (second.request?.messages ?? []).filter((m) => m.role === "user");
        expect(users.length).toBeGreaterThanOrEqual(2);
        expect(String(users.at(-2)?.text ?? "")).toContain("第一句");
        expect(String(users.at(-1)?.text ?? "")).toContain("第二句");
    });
});

describe("BotAgent：失败之后调用方还能继续", () => {
    it("LLM 抛错 ⇒ send 拒绝；下一次 send 正常返回（不把 agent 用坏）", async () => {
        const llm = scriptedLlm((call) => {
            if (call === 1) throw new Error("upstream 500");
            return [
                { type: "text", text: "好了" } as SessionDelta,
                { type: "done", stopReason: "stop" } as SessionDelta,
            ];
        });
        const agent = makeAgent({ llm });

        await agent.send("第一轮"); // 成功
        await expect(agent.send("第二轮")).rejects.toThrow(/upstream 500/);
        const third = await agent.send("第三轮");

        expect(third.text).toBe("好了");
        expect(llm.calls).toBe(3);
        // 失败那一轮的正文必须已经进了历史（否则调用方回了话、模型却没看见）
        const texts = (third.request?.messages ?? []).map((m) => String(m.text ?? ""));
        expect(texts.some((t) => t.includes("第二轮"))).toBe(true);
        expect(texts.some((t) => t.includes("第三轮"))).toBe(true);
    });
});

describe("BotAgent：system 注入规则", () => {
    it("新会话 ⇒ 第一条是 system，且非空（由 providers 渲染而来）", async () => {
        const result = await makeAgent({ llm: replyingLlm() }).send("hi");
        const first = result.request?.messages?.[0];
        expect(first?.role).toBe("system");
        expect(String(first?.text ?? "").length).toBeGreaterThan(0);
    });

    it("历史里已有 system ⇒ 尊重它，不追加第二条（升级后老会话不被改写）", async () => {
        const agent = makeAgent({
            llm: replyingLlm(),
            // 恢复历史的消息必须带 seq（session 用它排序与续号）
            initialMessages: [{ seq: 1, role: "system", text: "旧的 system" } as never],
        });
        const result = await agent.send("hi");
        const systems = (result.request?.messages ?? []).filter((m) => m.role === "system");
        expect(systems).toHaveLength(1);
        expect(systems[0]?.text).toBe("旧的 system");
    });

    it("system 建会话时算一次：变量之后怎么变，已发出的 system 不重写", async () => {
        let value = { cli: "diy", home: "/tmp/a" };
        const small = baseProviders({ diy: () => value });
        const agent = makeAgent({ llm: replyingLlm(), providers: small });

        const first = await agent.send("第一轮");
        value = { cli: "diy", home: "/tmp/b-changed" };
        const second = await agent.send("第二轮");

        const systemOf = (r: typeof first): string =>
            String((r.request?.messages ?? []).find((m) => m.role === "system")?.text ?? "");
        expect(systemOf(second)).toBe(systemOf(first));
        expect(systemOf(second)).toContain("/tmp/a");
    });
});
