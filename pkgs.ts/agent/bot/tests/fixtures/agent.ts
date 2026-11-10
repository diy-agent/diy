/**
 * fixtures/agent.ts —— BotAgent 测试的**公共夹具**（##518）
 *
 * 为什么要有它：`baseProviders()` 那四项（diy / cwd / chain / skills）是上下文树的硬要求，
 * 少任何一项 delivery 的 zod 校验都会报「expected object/array, received undefined」。
 * 在写行为测试的过程中，同一份「最小合法 provider 集」被拼了 6 次才试对 ——
 * 这种**结构性的、试错成本高**的常量就该只有一处，改 schema 时也只改这里。
 *
 * 只放两样：最小 provider 集、可编排的假 LLM（唯一允许的替身）。
 */
import { openMemorySessionStore } from "@diy-agent/session";
import type { LlmPort, SessionDelta } from "@diy-agent/session";
import type { ContextProvider } from "@diy-agent/context";
import { createBotAgent, type BotAgent } from "../../src/agent.js";

/**
 * 上下文树要的**最小合法** provider 集。
 *
 * `diy` 的 payload 必须是 `{ cli, home }`（见 `context/src/schema/prompt-schema.ts`）；
 * `cwd` 的五个字段也都必填。改 schema 时这里是唯一要跟的地方。
 */
export function baseProviders(overrides: Partial<Record<string, () => unknown>> = {}): ContextProvider[] {
    const base: Record<string, () => unknown> = {
        diy: () => ({ cli: "diy", home: "/tmp/diy-home" }),
        cwd: () => ({ path: "/tmp/ws", note: "", isFallback: false, isTaskDir: false, isAppDir: false }),
        chain: () => [],
        skills: () => [],
    };
    return Object.entries({ ...base, ...overrides }).map(([key, provide]) => ({ key, provide }) as ContextProvider);
}

export interface ScriptedLlm extends LlmPort {
    /** 被调用了几次（断言「只调一次」这类行为） */
    readonly calls: number;
    /** 每次调用看到的 messages（断言「发了什么」） */
    readonly seen: readonly { readonly role?: string; readonly text?: string }[][];
}

/**
 * 可编排的假 LLM：`script(callIndex)` 返回该次调用要吐的 delta 序列。
 * 抛错即模拟上游失败 —— 「失败之后还能不能继续」这条就是靠它测的。
 */
export function scriptedLlm(script: (call: number, messages: readonly { role?: string; text?: string }[]) => SessionDelta[]): ScriptedLlm {
    const seen: { role?: string; text?: string }[][] = [];
    const port = {
        get calls(): number {
            return seen.length;
        },
        get seen(): readonly { readonly role?: string; readonly text?: string }[][] {
            return seen;
        },
        async *chat(messages: readonly { role?: string; text?: string }[]): AsyncGenerator<SessionDelta> {
            seen.push([...messages]);
            for (const delta of script(seen.length - 1, messages)) yield delta;
        },
    };
    return port as unknown as ScriptedLlm;
}

/** 固定回一句话的 LLM（最常见的场景） */
export function replyingLlm(text = "好"): ScriptedLlm {
    return scriptedLlm(() => [
        { type: "text", text } as SessionDelta,
        { type: "done", stopReason: "stop" } as SessionDelta,
    ]);
}

/** 建一个不写盘的 agent：内存 store + 最小 provider 集 */
export function makeAgent(opts: {
    llm: LlmPort;
    providers?: readonly ContextProvider[];
    initialMessages?: Parameters<typeof createBotAgent>[0]["initialMessages"];
    id?: string;
}): BotAgent {
    return createBotAgent({
        id: opts.id ?? "s-fixture",
        llm: opts.llm,
        store: openMemorySessionStore(),
        model: "test/model",
        providers: opts.providers ?? baseProviders(),
        instructions: "",
        initialSnapshot: null,
        ...(opts.initialMessages === undefined ? {} : { initialMessages: opts.initialMessages }),
    });
}
