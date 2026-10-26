// tests/core/context-refresh.test.ts
// 🎯 ##310：**每步重算上下文**（prepareStep 及时刷新）
//
// 契约：同一轮内变量变了（例如 agent 自己 `diy task edit` 改了任务正文），**下一步**的请求
// 就要用新值，而不是等下一轮 —— 否则一次几小时的 tool 循环全程建在过期数据上。
// 手法同 local-agent-midturn-config：桩模型把「步边界」变成确定事件，断言口径 = 上游实际
// 收到的 prompt（`mock.doStreamCalls[i].prompt`）。

import { describe, it, expect, beforeAll } from "vitest";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel, ModelMessage } from "ai";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask, updateTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { readCtxLog } from "../../src/main/core/context-changelog";
import { isV2Entry, entryToRows } from "../../src/shared/context/changelog";
import * as yaml from "js-yaml";
import { appendUserKey, renderSummaryPart, tailEnvelope } from "../../src/shared/context/envelope";
import { buildDelivery, runtimeDiffDelivery } from "../../src/shared/context/delivery";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "ctx-refresh-work"));
});
let seq = 0;
const newUri = (title: string, body = ""): string => {
    const uri = createTask({ title: `${title} ${++seq}`, project: PROJECT });
    if (body) updateTask(uri, { body });
    return uri;
};

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
const textReply = (text: string) =>
    stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ]);
const toolCallReply = (callId: string, command: string) =>
    stream([
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: callId, toolName: "bash" },
        { type: "tool-input-delta", id: callId, delta: JSON.stringify({ command }) },
        { type: "tool-input-end", id: callId },
        { type: "tool-call", toolCallId: callId, toolName: "bash", input: JSON.stringify({ command }) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
    ]);

/** 上游第 i 次请求的 prompt 全文（system + user + assistant 都算） */
function promptText(model: MockLanguageModelV3, callIndex: number): string {
    const prompt = model.doStreamCalls[callIndex]?.prompt ?? [];
    const out: string[] = [];
    for (const msg of prompt as Array<{ content: unknown }>) {
        const content = msg.content;
        if (typeof content === "string") out.push(content);
        else if (Array.isArray(content)) {
            for (const part of content as Array<{ text?: string }>) if (typeof part.text === "string") out.push(part.text);
        }
    }
    return out.join("\n");
}

describe("信封：尾部各段各占一个顶层键（tailEnvelope / appendUserKey）", () => {
    it("summary 段与 runtime 并列、user 在最后 —— 自动生成的段不混进 user.message", () => {
        const out = tailEnvelope(
            ["summary: 上一次压缩的结论", "runtime:\n  task:\n    body: x"],
            "回复 1",
        );
        expect(out).toBe(
            'summary: 上一次压缩的结论\nruntime:\n  task:\n    body: x\nuser:\n  message: "回复 1"',
        );
        // 关键：`user.message` 只剩用户真话（曾经注记被并进这里，模型把它当任务去查 —— tasks/5 实测）
        expect(out.slice(out.indexOf("\nuser:"))).not.toContain("summary");
        // 自动段在前、user 在最后
        expect(out.indexOf("summary:")).toBeLessThan(out.indexOf("runtime:"));
        expect(out.indexOf("\nuser:")).toBeGreaterThan(out.indexOf("runtime:"));
    });
    it("没有自动段时逐字等于旧形（appendUserKey）", () => {
        expect(tailEnvelope(["runtime:\n  a: 1"], "你好")).toBe(appendUserKey("runtime:\n  a: 1", "你好"));
    });
    it("一个片段都没有 → 原样（不编 user 段）", () => {
        expect(tailEnvelope([], undefined)).toBe("");
    });

    it("摘要也是**自动生成的段** → 顶层键 `summary:`，不混进 user.message（withSummary 的坑）", () => {
        // 用户 2026-10-15：「user.message 消息里不能加其他任何消息」——摘要是自动生成的段，
        // 与注记同法各占一个顶层键（此前它作为普通 user 消息前置 → 被 normalizeUserRuns 并进正文）
        const out = tailEnvelope([renderSummaryPart("上一段的结论"), "runtime:\n  task:\n    body: x"], "新一句");
        const loaded = yaml.load(out, { schema: yaml.JSON_SCHEMA }) as any;
        expect(loaded.summary).toBe("上一段的结论");
        expect(loaded.runtime.task.body).toBe("x");
        expect(loaded.user.message).toBe("新一句");
        // 关键：user.message 只剩用户真话（不含摘要/变量树）
        expect(loaded.user.message).not.toContain("上一段的结论");
        expect(loaded.user.message).not.toContain("body");
        // 顺序：summary 在前，user 在最后
        expect(out.indexOf("summary:")).toBeLessThan(out.indexOf("runtime:"));
        expect(out.indexOf("\nuser:")).toBeGreaterThan(out.indexOf("runtime:"));
    });
    it("空摘要 → 空串（不投递，不编空段）", () => {
        expect(renderSummaryPart("   ")).toBe("");
    });

    it("runtime 之前、user 之后，一份合法 YAML（不是两条相邻 user 被合并出的怪东西）", () => {
        const out = appendUserKey("runtime:\n  task:\n    body: x", "你好");
        expect(out).toBe('runtime:\n  task:\n    body: x\nuser:\n  message: "你好"');
    });
    it("多行输入用块标量（仍是合法 YAML，内容逐字保真）", () => {
        const out = appendUserKey("runtime:\n  a: 1", "第一行\n第二行");
        expect(out).toContain("message: |");
        expect(out).toContain("    第一行\n    第二行");
    });
});

describe("runtimeDiff：只写**变化**的原子单元 → 变更后的当前值", () => {
    const globals = (body: string): Record<string, unknown> => ({
        diy: { cli: "/d", home: "/h" },
        task: { uri: "projects/1/tasks/1", title: "T", state: "active", dir: "/h/t", body },
        skills: [],
    });
    it("变了的单元出现（值 = 新值全量），没变的单元不出现", () => {
        const next = buildDelivery(globals("新值"), ["diy"]);
        const diff = runtimeDiffDelivery(next.tree, ["task.body"]);
        expect(diff.text).toBe('runtimeDiff:\n  task:\n    body: "新值"');
        expect(diff.text).not.toContain("title");
    });
    it("无变化 → 空串（调用方据此**不注入**，不砸前缀缓存）", () => {
        const next = buildDelivery(globals("x"), ["diy"]);
        expect(runtimeDiffDelivery(next.tree, []).text).toBe("");
        expect(runtimeDiffDelivery(next.tree, []).bytes).toBe(0);
    });
});

describe("轮内重算：变量变了 → 下一步请求即用新值", () => {
    it("轮内改任务正文（runtime）→ 第二步请求已含新正文", async () => {
        const uri = newUri("轮内改正文", "正文旧值-AAAAAAAAAA");
        let call = 0;
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => {
                // 第一步发出后，模拟 agent 自己改掉了任务正文（tool 执行 `diy task edit` 的效果）
                if (call === 0) updateTask(uri, { body: "正文新值-BBBBBBBBBB" });
                const r = call === 0 ? toolCallReply("c1", "echo one") : textReply("done");
                call++;
                return Promise.resolve(r);
            },
        });
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
        for await (const _op of mgr.chat(uri, "开始")) void _op;

        expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2);
        // 第一步：旧值
        expect(promptText(model, 0)).toContain("正文旧值-AAAAAAAAAA");
        expect(promptText(model, 0)).not.toContain("正文新值-BBBBBBBBBB");
        // 第二步：新值（不必等下一轮）—— 且形态是**追加的 runtimeDiff 段**（让模型知道"哪几个单元变了"）
        const p1 = promptText(model, 1);
        expect(p1).toContain("正文新值-BBBBBBBBBB");
        expect(p1).toContain("runtimeDiff:");
    });

    it("轮内改任务标题（system）→ 第二步请求的 system 已刷新", async () => {
        const uri = newUri("标题旧值-AAAAAAAAAA");
        let call = 0;
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => {
                if (call === 0) updateTask(uri, { title: "标题新值-BBBBBBBBBB" });
                const r = call === 0 ? toolCallReply("c1", "echo two") : textReply("done");
                call++;
                return Promise.resolve(r);
            },
        });
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
        for await (const _op of mgr.chat(uri, "开始")) void _op;

        expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2);
        expect(promptText(model, 0)).toContain("标题旧值-AAAAAAAAAA");
        expect(promptText(model, 1)).toContain("标题新值-BBBBBBBBBB");
    });

    it("没变就不注入：第二步请求里不出现重复的 runtime 段", async () => {
        const uri = newUri("不变量", "正文固定值-CCCCCCCCCC");
        let call = 0;
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => {
                const r = call === 0 ? toolCallReply("c1", "echo three") : textReply("done");
                call++;
                return Promise.resolve(r);
            },
        });
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
        for await (const _op of mgr.chat(uri, "开始")) void _op;

        const count = (s: string, sub: string): number => s.split(sub).length - 1;
        // runtime 只出现一次（若每步都追加而非"变了才注入"，这里会 > 1）
        expect(count(promptText(model, 1), "正文固定值-CCCCCCCCCC")).toBe(1);
    });
});

describe("压缩注记的位置：自占一条 user 消息，挂在历史第一条之前（##421）", () => {
    it("##442 刀 2：注记已删 —— 压缩后 prompt[1] **不得**再是 `history:` 段，且两段头必须逐字稳定", async () => {
        // 历史上限调到下限（4000 token）→ 两轮长正文一定触发注记
        // （##432 刀 2：投递只按 history.limit.limitTokens 切，旧 policy.budgetBytes 已不决定）
        writeFileSync(
            join(diyHome(), "auto-compact.yaml"),
            JSON.stringify({
                mode: "notify",
                triggers: { systemContextChanged: true, cacheExpired: true, contextWindowOver: 0.8 },
                policy: { mode: "budget", modeData: { budgetBytes: 64, toolResult: { render: "asis" } }, summary: false },
                history: { limit: { limitTokens: 4000, summary: { enabled: false } } },
            }),
            "utf-8",
        );
        const uri = newUri("注记位置", "正文-AAAAAAAAAA");
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => Promise.resolve(textReply("好")),
        });
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
        for await (const _op of mgr.chat(uri, `第一轮 ${"问".repeat(20000)}`)) void _op;
        for await (const _op of mgr.chat(uri, `第二轮 ${"问".repeat(20000)}`)) void _op;

        const prompt = (model.doStreamCalls[1]?.prompt ?? []) as Array<{ role: string; content: unknown }>;
        const prompt0 = (model.doStreamCalls[0]?.prompt ?? []) as Array<{ role: string; content: unknown }>;
        // ⚠️ 经 SDK 后 user 的 content 一律是 part 数组（可能是单 part 或多 part）→ 取文本
        const textOf = (c: unknown): string =>
            typeof c === "string" ? c : ((c ?? []) as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");

        // ① system 仍是第一条，紧随其后**没有**自动生成的注记段
        expect(prompt[0]?.role).toBe("system");
        const hasHistoryKey = (t: string): boolean => /^history:/m.test(t);
        for (const m of prompt) {
            if (m.role !== "user") continue;
            expect(hasHistoryKey(textOf(m.content))).toBe(false);
        }
        // ② 不变量：两轮之间 **system 逐字节相等**（头部出现任何每轮变的量，整段历史前缀缓存全废）
        expect(textOf(prompt[0]?.content)).toBe(textOf(prompt0[0]?.content));

        // 尾部信封只剩 runtime + user
        const tail = textOf(prompt[prompt.length - 1]?.content);
        expect(tail).toContain("runtime:");
        expect(hasHistoryKey(tail)).toBe(false);
        expect(tail).toContain('user:\n  message: "第二轮');
    });
});

describe("跨轮变更：上一轮之后改的东西，下一轮必须落一条 changed", () => {
    /**
     * 这条钉的是一个**实测到的 bug**（##310 五轮）：
     * 变更的比较基准曾经是"**本轮**轮首那份投递"（`let ctxPrevSnap = 轮首值`）—— 于是它只看得见
     * 一轮**之内**的变化；而最常见的变化（用户改了正文/标题，再来问一句）发生在**两轮之间**：
     * 新轮次的轮首值已经是改后的值 ⇒ diff 恒为空 ⇒ 变更日志里永远只有 baseline，没有 changed。
     * 真发复现：`diy task edit --title X` → 下一轮 changelog 无任何 changed（只有 baseline）。
     *
     * 修法 = 比较基准改成**跨轮游标**（`LocalAgentManager.ctxSnap`，每任务一份）。
     */
    it("两轮之间改任务正文 → 第二轮落 changed 且 path = task.body", async () => {
        const uri = newUri("跨轮变更", "旧正文-AAAAAAAAAA");
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => Promise.resolve(textReply("好")),
        });
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);

        for await (const _op of mgr.chat(uri, "第一轮")) void _op;
        // 两轮之间改（用户编辑任务正文 —— 最常见的那类变化）
        updateTask(uri, { body: "新正文-BBBBBBBBBB" });
        for await (const _op of mgr.chat(uri, "第二轮")) void _op;

        const v2 = readCtxLog(uri).filter(isV2Entry);
        expect(v2.map((e) => e.type)).toEqual(["baseline", "changed"]);
        const changed = v2[1]!;
        const changes = "changes" in changed.data ? changed.data.changes : [];
        expect(changes.map((c) => c.path)).toContain("task.body");
        // 变更单位是原子单元：数组不下钻（chain 整体一条，不该出现 chain.0.content）
        expect(changes.every((c) => !/^chain\.\d/.test(c.path))).toBe(true);
        // 读侧能给出旧→新（before/after 自带，不回放）
        const row = entryToRows(changed).find((c) => c.path === "task.body")!;
        expect(row.before).toContain("旧正文");
        expect(row.after).toContain("新正文");
    }, 60_000);

    /**
     * 承接上一条：游标是**内存 Map**，进程重启即空 —— 不播种则重启后第一轮又退回"轮首为基准"，
     * 跨轮变化静默漏报。这里用**两个 manager 实例**模拟重启（新实例的 ctxSnap 必空），
     * 断言重启后第一轮**仍**落得出 changed 且 before 是旧值（来自盘上 changelog 重放）。
     */
    it("进程重启（新 manager 实例）后第一轮：游标从盘上播种，跨轮变更不漏报", async () => {
        const uri = newUri("重启播种", "旧正文-EEEEEEEEEE");
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => Promise.resolve(textReply("好")),
        });
        const mk = () => new LocalAgentManager(() => model as unknown as LanguageModel);
        for await (const _op of mk().chat(uri, "第一轮")) void _op;

        updateTask(uri, { body: "新正文-FFFFFFFFFF" });

        // 新实例 = 内存游标为空（等价于重启后第一次真发）
        for await (const _op of mk().chat(uri, "第二轮")) void _op;

        const v2 = readCtxLog(uri).filter(isV2Entry);
        expect(v2.map((e) => e.type)).toEqual(["baseline", "changed"]);
        const row = entryToRows(v2[1]!).find((c) => c.path === "task.body")!;
        expect(row.before).toContain("旧正文");
        expect(row.after).toContain("新正文");
    }, 60_000);

    it("跨轮没变就不写（基准对了也不能凭空造记录）", async () => {
        const uri = newUri("跨轮无变", "正文一直不动不动不动");
        const model = new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => Promise.resolve(textReply("好")),
        });
        const mgr = new LocalAgentManager(() => model as unknown as LanguageModel);
        for await (const _op of mgr.chat(uri, `第一轮 ${"问".repeat(20000)}`)) void _op;
        for await (const _op of mgr.chat(uri, `第二轮 ${"问".repeat(20000)}`)) void _op;
        const v2 = readCtxLog(uri).filter(isV2Entry);
        expect(v2.map((e) => e.type)).toEqual(["baseline"]);
    }, 60_000);
});
