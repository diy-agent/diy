// tests/core/user-speaker.test.ts
// 🎯 ##422：历史 user 消息带 `from:`（发言者）段的四条判据
//
//   ① 有 speaker 的 user 块 ⇒ 投影出 `from:` 段且**正文原样**
//   ② 无 speaker ⇒ **裸文本逐字不变**（存量行为不动，不造 `from: unknown`）
//   ③ `from:` 段不进 `user.message`（顶层键**并列**）
//   ④ 信封合并规则不把 `from:` 并进相邻消息（复用 ##421 的「信封形态不合并」判据）
//
// 口径：①~③ 取在**桩模型实际收到的 prompt** 上（与 `room-self-context-inject.test.ts` 同一把尺），
// ④ 是 `normalizeUserRuns` 的纯函数判据（合并规则影响的是**消息之间**，纯函数最能钉死）。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { ensureRoom, upsertMember } from "../../src/main/core/room";
import { LocalAgentManager, normalizeUserRuns } from "../../src/main/services/local-agent";
import { isEnvelopeText, renderFromPart, tailEnvelope } from "../../src/shared/context/envelope";
import type { Op } from "../../src/main/services/local-blocks";
import type { ModelMessage } from "ai";
import { appendCompactionEntry } from "../../src/main/services/local-turns";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key"; // 桩模型不用它，但 chat 入口会校验
    PROJECT = createProject(join(diyHome(), "user-speaker-work"));
});

let seq = 0;
const newUri = (): string => createTask({ title: `发言者 ${++seq}`, project: PROJECT });

const PERSONA_NAME = "deepseek-4.1-flash";

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

/** 桩模型：把每次真发的 prompt 原样记下（判据取在模型收到的那份上） */
function stubModel(sink: { prompts: unknown[] }): LanguageModel {
    return new MockLanguageModelV3({
        provider: "stub",
        modelId: "stub-model",
        doStream: (options) => {
            sink.prompts.push(options.prompt);
            return Promise.resolve(textReply("收到"));
        },
    }) as unknown as LanguageModel;
}

type PromptMsg = { role: string; content: unknown };
const textOf = (c: unknown): string =>
    typeof c === "string" ? c : ((c ?? []) as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n");

/** 建一间「人 + 主人格」的房间（display name 是 speaker.name 的唯一来源，见 `speakerOf`） */
function seedRoom(roomId: string, taskUri: string): void {
    ensureRoom(roomId);
    upsertMember(roomId, {
        id: "agent:main",
        name: PERSONA_NAME,
        kind: "agent",
        backend: { type: "task", data: { taskUri } },
        main: true,
    });
    upsertMember(roomId, { id: "human:chen56", name: "chen56", kind: "human", backend: null });
}

type Origin = Parameters<LocalAgentManager["chat"]>[6];

async function turn(
    uri: string,
    mgr: LocalAgentManager,
    text: string,
    origin: Origin,
    sink: { prompts: unknown[] },
): Promise<{ ops: Op[]; prompt: PromptMsg[] }> {
    const ops: Op[] = [];
    for await (const op of mgr.chat(uri, text, undefined, undefined, undefined, undefined, origin)) ops.push(op);
    return { ops, prompt: (sink.prompts.at(-1) ?? []) as PromptMsg[] };
}

/**
 * 压缩**事件**注入（##432 的口径：边界是事件落盘、之后每步只读）—— 照抄 `history-note.test.ts`：
 * `history.keep` 只留 `ladder` 一级（没有 `steps` 托底，小会话才压得掉东西）。
 */
const writeBoundary = (uri: string, cutLine: number, headLine = 1, dropped = 1): void => {
    appendCompactionEntry(uri, {
        at: new Date().toISOString(),
        limitTokens: 20_000,
        dropped,
        headLine,
        cut: { llmLine: cutLine, turnId: null },
    });
};

/** 单条 user 消息的**投递**字节（与 `costOfWith` 同口径：`{role, content}` 的 JSON） */

/** 历史里那条 user 消息（= prompt 里第一条 role=user 的正文；尾部信封另算） */
const firstUserText = (prompt: PromptMsg[]): string => textOf(prompt.find((m) => m.role === "user")?.content);

describe("##422 历史 user 消息带 from（发言者）", () => {
    it("① 有 speaker 的 user 块 ⇒ 投影出 from: 段（id + 显示名）且正文原样", async () => {
        const uri = newUri();
        seedRoom(uri, uri);
        const sink = { prompts: [] as unknown[] };
        const mgr = new LocalAgentManager(() => stubModel(sink));
        // 第一轮 = 「投递来的」：author 落了 meta.author（agent 投给主人格不触发 §44.2 A 的掐除）
        const { ops } = await turn(uri, mgr, "第一句", { author: "agent:main" }, sink);
        // 块上两个字段都落：author 给 UI，speaker 给模型
        const start = ops.find((o) => o.op === "start" && o.id.endsWith("_u")) as
            | { meta?: Record<string, unknown> }
            | undefined;
        expect(start?.meta?.["author"]).toBe("agent:main");
        expect(start?.meta?.["speaker"]).toEqual({ id: "agent:main", name: PERSONA_NAME });

        // 第二轮再问一句 ⇒ 第一轮那条成了**历史**，投影里带 chat.from
        await turn(uri, mgr, "第二句", undefined, sink);
        const hist = firstUserText((sink.prompts.at(-1) ?? []) as PromptMsg[]);
        expect(hist.startsWith("chat:\n")).toBe(true);
        expect(hist).toContain("  - from: agent:main");
        // 正文原样（不是被改写、不是被塞进别处）
        expect(hist).toContain('text: "第一句"');
        expect(hist).not.toContain("第二句");
    });

    it("② 无 speaker（任务页本人发言）⇒ from 落默认 human:chen56", async () => {
        const uri = newUri();
        seedRoom(uri, uri);
        const sink = { prompts: [] as unknown[] };
        const mgr = new LocalAgentManager(() => stubModel(sink));
        await turn(uri, mgr, "第一句", undefined, sink);
        const { ops } = await turn(uri, mgr, "第二句", undefined, sink);
        const start = ops.find((o) => o.op === "start" && o.id.endsWith("_u")) as
            | { meta?: Record<string, unknown> }
            | undefined;
        // 不落 speaker 键（也不落 author —— 与存量逐字一致）
        expect(start?.meta?.["speaker"]).toBeUndefined();
        expect(start?.meta?.["author"]).toBeUndefined();
        // 历史里那条也是 chat 信封；没有 speaker 时 from = 本机用户
        const hist = firstUserText((sink.prompts.at(-1) ?? []) as PromptMsg[]);
        expect(hist).toBe('chat:\n  - from: human:chen56\n    text: "第一句"');
    });

    it("③ from: 段不进 user.message（顶层键并列）—— 末尾那轮也照此（不嵌套）", async () => {
        const uri = newUri();
        seedRoom(uri, uri);
        const sink = { prompts: [] as unknown[] };
        const mgr = new LocalAgentManager(() => stubModel(sink));
        await turn(uri, mgr, "第一句", { author: "agent:main" }, sink);
        // 本轮输入**也**带 speaker ⇒ from 在 chat 项里（与 text 同级，不是顶层键）
        const { prompt } = await turn(uri, mgr, "第二句", { author: "agent:main" }, sink);
        const last = textOf(prompt[prompt.length - 1]?.content);
        // 可能带跨轮控制增量（room 变化）→ chat 不一定在首行，但必须在同一份信封里
        expect(last).toContain("chat:");
        expect(last).toContain("  - from: agent:main");
        expect(last).toContain('text: "第二句"');
        // from 不在顶层（顶格 `from:` 是旧格式；新格式只在 chat 项里缩进出现）
        expect(last).not.toMatch(/^from:/m);
    });
});

describe("##422 合并规则：from 信封不参与相邻 user 合并（判据 ④）", () => {
    const fromMsg = (id: string, text: string): ModelMessage =>
        ({ role: "user", content: `from:\n  id: ${id}\nuser:\n  message: ${text}` }) as ModelMessage;

    it("两条相邻的 from 信封各自成条（并被 isEnvelopeText 认成信封）", () => {
        const a = fromMsg("agent:main", "一");
        const b = fromMsg("human:chen56", "二");
        expect(isEnvelopeText(a.content as string)).toBe(true);
        expect(isEnvelopeText(b.content as string)).toBe(true);
        const out = normalizeUserRuns([a, b]);
        expect(out).toHaveLength(2);
        expect(out[0]!.content).toBe(a.content);
        expect(out[1]!.content).toBe(b.content);
    });

    it("普通正文夹在两条 from 信封之间也不被并（三条各占一条）", () => {
        const out = normalizeUserRuns([
            fromMsg("agent:main", "一"),
            { role: "user", content: "裸文本" } as ModelMessage,
            fromMsg("human:chen56", "二"),
        ]);
        expect(out).toHaveLength(3);
        expect(out[1]!.content).toBe("裸文本");
    });

    it("##442：压缩后头部是 notify.compact，随后才是保留的历史消息（chat 信封）", async () => {
        // 边界切在 3 ⇒ 旧 user（from 信封）留下、assistant 被丢（真压缩）
        const uri = newUri();
        seedRoom(uri, uri);
        const sink = { prompts: [] as unknown[] };
        const mgr = new LocalAgentManager(() => stubModel(sink));
        await turn(uri, mgr, "第一句", { author: "agent:main" }, sink);
        writeBoundary(uri, 3);
        const { prompt } = await turn(uri, mgr, "第二句", undefined, sink);
        expect(prompt[0]?.role).toBe("system");
        // ##442：system 之后先一条压缩通知（只有 source / summary），再是保留的历史发言
        const notice = textOf(prompt[1]?.content);
        expect(notice.startsWith("notify:\n")).toBe(true);
        expect(notice).toContain("kind: compact");
        expect(notice).toContain("source:");
        expect(notice).not.toContain("history:");
        const hist = textOf(prompt[2]?.content);
        expect(hist.startsWith("chat:\n")).toBe(true);
        expect(hist).toContain("  - from: human:chen56");
        expect(hist).toContain("第二句");
    });
});
