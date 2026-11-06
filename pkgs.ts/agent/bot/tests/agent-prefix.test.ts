// 这条测试守的是「**总体验证点**」——用户 2026-11-05 的原话：
//   「算法都商量好了、需求都说清楚了，但实际检查 raw request 发现提交错了……
//     即需求：**无论什么变化都不改变请求的消息历史**，这个要求被多次打破，
//     我想原因就是设计上缺少一个总体的验证点，都是零散的算法。」
//
// 所以这里不测某个算法，只测**最终发出去的那份字节**：
//   ① 第二轮请求的前 n 条，必须与第一轮逐字相同（只允许在尾部追加）
//   ② system 必须在段内逐字不变（变量树怎么变都不重写）
import { describe, expect, it } from "vitest";
import {
    assembleFromProviders,
    treeOfGlobals,
    valueHashes,
    type ContextProvider,
    type SchemaDoc,
} from "@diy-agent/context";
import { createBotAgent } from "../src/agent.js";
import type { LlmPort, SessionDelta } from "@diy-agent/session";

/** 一个可控的 provider：`value` 可以在测试中间改，模拟「变量变了」 */
function mutableProvider(key: string, initial: unknown): { provider: ContextProvider; set: (v: unknown) => void } {
    let value = initial;
    return {
        provider: {
            key,
            // 用一份最小的 help（`desc` 就够，形状由 context 包的 SchemaDoc 决定）
            help: { type: "object", desc: `${key} 的说明` } satisfies SchemaDoc,
            provide: () => value,
        },
        set: (v) => {
            value = v;
        },
    };
}

/** 假 LLM：echo 回来，不花钱 */
function echoLlm(): LlmPort {
    return {
        async *chat(messages): AsyncGenerator<SessionDelta> {
            const last = messages[messages.length - 1];
            const text = typeof last?.text === "string" ? last.text : "";
            yield { type: "text", text: `echo:${text}` };
            yield { type: "usage", inputTokens: 1, outputTokens: 1 } as SessionDelta;
            yield { type: "done", stopReason: "stop" } as SessionDelta;
        },
    } as LlmPort;
}

import { openMemorySessionStore } from "@diy-agent/session";

describe("BotAgent：请求的前缀不变（总体验证点）", () => {
    function makeAgent(providers: readonly ContextProvider[]) {
        return createBotAgent({
            id: "s-prefix",
            llm: echoLlm(),
            store: openMemorySessionStore(),
            model: "test/model",
            providers,
            instructions: "",
            initialSnapshot: null,
        });
    }

    /** 上下文树要求的最小 provider 集（都有的那四项） */
    function baseProviders(): ContextProvider[] {
        return [
            { key: "diy", provide: () => ({ cli: "diy", home: "/tmp/x" }) },
            { key: "cwd", provide: () => ({ path: "/tmp/x", note: "", isFallback: false, isTaskDir: false, isAppDir: false }) },
            { key: "chain", provide: () => [] },
            { key: "skills", provide: () => [] },
        ];
    }

    it("变量变化 ⇒ 第二轮的历史前缀逐字不变，system 也不变", async () => {
        const cwdNode = mutableProvider("cwd", {
            path: "/tmp/a",
            note: "",
            isFallback: false,
            isTaskDir: false,
            isAppDir: false,
        });
        const providers = [...baseProviders().filter((p) => p.key !== "cwd"), cwdNode.provider];
        const agent = makeAgent(providers);

        const r1 = await agent.send("第一句");
        expect(r1.request).not.toBeNull();
        const first = r1.request!.messages;

        // 改变量树里的值（模拟「任务 title 变了 / cwd 变了」这类跨轮变化）
        cwdNode.set({ path: "/tmp/b", note: "", isFallback: false, isTaskDir: false, isAppDir: false });

        const r2 = await agent.send("第二句");
        expect(r2.request).not.toBeNull();
        const second = r2.request!.messages;

        // ① 前缀不变：第二轮的**前 first.length 条**必须与第一轮逐字相同
        expect(second.slice(0, first.length)).toEqual(first);
        // ② 只是追加（多了本轮 user + 助手回复）
        expect(second.length).toBeGreaterThan(first.length);
    });

    it("system 在段内逐字不变（变量树变了也不重写）", async () => {
        const cwdNode = mutableProvider("cwd", {
            path: "/tmp/a",
            note: "",
            isFallback: false,
            isTaskDir: false,
            isAppDir: false,
        });
        const providers = [...baseProviders().filter((p) => p.key !== "cwd"), cwdNode.provider];
        const agent = makeAgent(providers);

        const sysBefore = (await agent.send("x")).request!.messages.find((m) => m.role === "system")?.text;
        cwdNode.set({ path: "/tmp/CHANGED", note: "", isFallback: false, isTaskDir: false, isAppDir: false });
        const sysAfter = (await agent.send("y")).request!.messages.find((m) => m.role === "system")?.text;

        expect(sysAfter).toBe(sysBefore);
        // 而且 system 里不该出现变化后的新值（说明没被重算）
        expect(sysAfter).not.toContain("/tmp/CHANGED");
    });

    it("request 记的是**这一次**的快照，不会被后续调用改写", async () => {
        const agent = makeAgent(baseProviders());
        const r1 = await agent.send("a");
        const snapshot1 = r1.request!.messages;
        const len1 = snapshot1.length;
        await agent.send("b");
        // 快照长度不变（是 slice 出来的副本，不是活引用）
        expect(snapshot1.length).toBe(len1);
        // 精确匹配「这一轮 user 消息」，不能用 includes('b') —— help.about 的文本里就有字母 b
        expect(snapshot1.some((m) => m.role === "user" && m.text === "b")).toBe(false);
    });
});

describe("BotAgent：跨轮增量（接在 user 前缀上，不另起一条消息）", () => {
    it("变量变化 ⇒ 增量合进本轮 user 正文，历史仍只追加", async () => {
        const cwdNode = mutableProvider("cwd", {
            path: "/tmp/a",
            note: "",
            isFallback: false,
            isTaskDir: false,
            isAppDir: false,
        });
        const providers = [
            { key: "diy", provide: () => ({ cli: "diy", home: "/tmp/x" }) },
            cwdNode.provider,
            { key: "chain", provide: () => [] },
            { key: "skills", provide: () => [] },
        ];
        const agent = createBotAgent({
            id: "s-delta",
            llm: echoLlm(),
            store: openMemorySessionStore(),
            model: "test/model",
            providers,
            instructions: "",
            initialSnapshot: null,
        });

        const r1 = await agent.send("第一句");
        const n1 = r1.request!.messages.length;
        expect(r1.request!.messages[n1 - 1]!.text).toBe("第一句"); // 首轮无增量

        cwdNode.set({ path: "/tmp/CHANGED", note: "", isFallback: false, isTaskDir: false, isAppDir: false });
        const r2 = await agent.send("第二句");
        const last = r2.request!.messages[r2.request!.messages.length - 1]!;
        // ① 本轮 user 正文里带上了增量（新值）
        expect(String(last.text)).toContain("/tmp/CHANGED");
        expect(String(last.text)).toContain("第二句");
        // ② 增量**没有**变成独立的一条消息（历史只追加 2 条：user + assistant）
        expect(r2.request!.messages.length).toBe(n1 + 2);
    });
});

describe("BotAgent：initialSnapshot 由调用方给（Agent 不决定快照怎么存）", () => {
    it("给了起始快照 ⇒ **第一轮就带增量**（重启后接着上次算，不重发全量）", async () => {
        // 模拟「上一轮的世界」：cwd=/tmp/a —— 快照从它算出来
        const before = treeOfGlobals(
            assembleFromProviders([
                { key: "diy", provide: () => ({ cli: "diy", home: "/tmp/x" }) },
                { key: "cwd", provide: () => ({ path: "/tmp/a", note: "", isFallback: false, isTaskDir: false, isAppDir: false }) },
                { key: "chain", provide: () => [] },
                { key: "skills", provide: () => [] },
            ]),
        );
        const initialSnapshot = { tree: before, valueHashes: valueHashes(before) };

        // 现在世界变成 cwd=/tmp/b
        const agent = createBotAgent({
            id: "s-restart",
            llm: echoLlm(),
            store: openMemorySessionStore(),
            model: "test/model",
            providers: [
                { key: "diy", provide: () => ({ cli: "diy", home: "/tmp/x" }) },
                { key: "cwd", provide: () => ({ path: "/tmp/b", note: "", isFallback: false, isTaskDir: false, isAppDir: false }) },
                { key: "chain", provide: () => [] },
                { key: "skills", provide: () => [] },
            ],
            instructions: "",
            initialSnapshot,
        });

        const r1 = await agent.send("重启后第一句");
        const last = r1.request!.messages[r1.request!.messages.length - 1]!;
        expect(String(last.text)).toContain("/tmp/b");      // 第一轮就有增量
        // 交回的新快照不是 null（调用方据此保存）
        expect(r1.snapshot).not.toBeNull();
    });
});
