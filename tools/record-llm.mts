#!/usr/bin/env node
/**
 * record-llm.mts — 录制真实 LLM 事件流，产出**源码** fixture（不是数据文件）
 *
 * 用法：
 *   export DIY_TEST_LLM_BASE_URL=... DIY_TEST_LLM_KEY=$OPENCODE_API_KEY DIY_TEST_LLM_MODEL=deepseek-v4.1-flash
 *   node tools/record-llm.mts list                  # 列出所有场景与录制状态
 *   node tools/record-llm.mts <scenario>            # 录一个场景，覆盖写 fixtures/llm/<scenario>.ts
 *   node tools/record-llm.mts <scenario> --dry      # 只打印，不写文件
 *
 * 为什么产物是 .ts 不是 .jsonl（2026-11-04 用户定）：
 *   · 协议变了（LanguageModelV3StreamPart 字段改名）→ **编译报错**，逼你重录；
 *     外部数据文件只会静默失效。
 *   · 存储版本变化不影响 fixture —— 它不读任何数据根，只认 DIY_TEST_LLM_* 环境变量。
 *   · review 时 diff 是带类型的结构，不是一大段 JSON。
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { streamText, tool, jsonSchema } from "ai";
import { z } from "zod";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { testLlm, testLlmConfig, missingEnvText } from "../pkgs.ts/test/llm/src/env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "../pkgs.ts/test/llm/tests/fixtures/llm/gen");

interface Scenario {
    /** 文件里的导出名（camelCase） */
    name: string;
    /** 一句话说明这个场景演什么 */
    about: string;
    /** 给模型的消息 */
    prompt: string;
    /** 是否提供工具（有工具才可能出 tool-call） */
    tools?: boolean;
    /** 录到第 N 个 part 就中断（制造 abort 场景） */
    abortAfter?: number;
    /** 真跑不出来（限流要运气、溢出要烧几十万 token），用协议形状合成。
     *  合成物仍是 .gen.ts、仍走同一个文件格式 —— 只是「来源」不同，注释里会写明。 */
    synthetic?: (parts: LanguageModelV3StreamPart[]) => void;
}

const SCENARIOS: Scenario[] = [
    { name: "textOnly", about: "最基础：纯文本回复，无工具无思考", prompt: "只回复四个字：收到收到。" },
    { name: "think", about: "带推理的回复（模型有 reasoning 面时才有效）", prompt: "9.11 和 9.9 哪个大？先想清楚再回答，只给结论。" },
    { name: "toolOk", about: "一次工具调用 + 拿到结果后的收尾文本", prompt: "用 read 工具读一下 README.md 的第一行，然后告诉我内容。", tools: true },
    { name: "toolError", about: "工具调用返回错误后模型怎么收尾", prompt: "用 read 工具读一个不存在的文件 /nope/does-not-exist.txt，然后说明失败原因。", tools: true },
    { name: "toolMultiStep", about: "连续两次工具调用（step 边界）", prompt: "先读 README.md 第一行，再读 package.json 的 name 字段，最后汇总。", tools: true },
    { name: "abort", about: "流到一半被中断（下游据此进 aborted 分支）", prompt: "写一段 300 字的说明文，讲讲什么是分子料理。", abortAfter: 3 },

    // ── 下面四个**真跑不出来**，用协议形状合成（见 synthetic 字段）──
    {
        name: "modelUnavailable",
        about: "上游 404 model_coming_soon —— 下游要停工 + 顶出提示条，不换模型硬试",
        prompt: "",
        synthetic: (parts) => {
            parts.push(
                { type: "stream-start", warnings: [] } as LanguageModelV3StreamPart,
                {
                    type: "error",
                    error: {
                        name: "AI_APICallError",
                        url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
                        requestBodyValues: { model: "<unavailable>", stream: true },
                        statusCode: 404,
                        responseBody: JSON.stringify({ error: { type: "model_coming_soon", message: "model_coming_soon" } }),
                        isRetryable: false,
                        data: { error: { type: "model_coming_soon", message: "model_coming_soon" } },
                    },
                } as unknown as LanguageModelV3StreamPart,
            );
        },
    },
    {
        name: "rateLimit",
        about: "上游 429 限流 —— 下游要退避重试，不是当成永久失败",
        prompt: "",
        synthetic: (parts) => {
            parts.push(
                { type: "stream-start", warnings: [] } as LanguageModelV3StreamPart,
                {
                    type: "error",
                    error: {
                        name: "AI_APICallError",
                        url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
                        requestBodyValues: { model: "<any>", stream: true },
                        statusCode: 429,
                        responseHeaders: { "retry-after": "2" },
                        responseBody: JSON.stringify({ error: { type: "rate_limit_exceeded", message: "Too many requests" } }),
                        isRetryable: true,
                        data: { error: { type: "rate_limit_exceeded", message: "Too many requests" } },
                    },
                } as unknown as LanguageModelV3StreamPart,
            );
        },
    },
    {
        name: "contextOverflow",
        about: "上下文溢出 —— 上游报超长，下游触发压缩后再试",
        prompt: "",
        synthetic: (parts) => {
            parts.push(
                { type: "stream-start", warnings: [] } as LanguageModelV3StreamPart,
                {
                    type: "error",
                    error: {
                        name: "AI_APICallError",
                        url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
                        requestBodyValues: { model: "<any>", stream: true },
                        statusCode: 400,
                        responseBody: JSON.stringify({
                            error: { type: "context_length_exceeded", message: "This model's maximum context length is 1050000 tokens" },
                        }),
                        isRetryable: false,
                        data: {
                            error: {
                                type: "context_length_exceeded",
                                message: "This model's maximum context length is 1050000 tokens",
                            },
                        },
                    },
                } as unknown as LanguageModelV3StreamPart,
            );
        },
    },
    {
        name: "empty",
        about: "done 但零内容 —— 下游要显示「(空回复)」而不是挂住等",
        prompt: "",
        synthetic: (parts) => {
            parts.push(
                { type: "stream-start", warnings: [] } as LanguageModelV3StreamPart,
                { type: "response-metadata", id: "chatcmpl-empty", modelId: "<any>", timestamp: new Date().toISOString() },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 0 } } },
            );
        },
    },
];

/** 场景用的工具集（真跑时会被真实执行，所以我们只提供只读工具） */
function toolsFor(): Record<string, unknown> {
    return {
        read: tool({
            description: "读文件的第一行",
            inputSchema: jsonSchema(z.object({ path: z.string() }).toJSONSchema()),
            execute: async ({ path }: { path: string }) => {
                const { readFileSync, existsSync } = await import("node:fs");
                if (!existsSync(path)) throw new Error(`文件不存在：${path}`);
                return readFileSync(path, "utf-8").split("\n")[0];
            },
        }),
    };
}

/** 把 parts 生成 TS 源码（每个 part 一行，便于 diff） */
function toSource(scenario: Scenario, parts: unknown[]): string {
    const lines = parts.map((p) => `    ${JSON.stringify(p)},`);
    return `// ${toKebab(scenario.name)}.gen.ts — ${scenario.about}
//
// ⚠️ **自动生成，勿手改**。文件名带 .gen 且住在 gen/ 目录 = 这个区别的唯一标记。
// 重录：node --experimental-strip-types tools/record-llm.mts ${toKebab(scenario.name)}
// 来源：${scenario.synthetic ? "协议形状合成（真跑不出来）" : `真模型 ${process.env["DIY_TEST_LLM_MODEL"] ?? "?"}`} · ${new Date().toISOString()}
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const ${scenario.name}: LanguageModelV3StreamPart[] = [
${lines.join("\n")}
];
`;
}

const toKebab = (s: string) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()).replace(/^-/, "");

async function record(scenario: Scenario, dry: boolean): Promise<void> {
    const { model, config } = testLlm();
    console.error(`▶ 录制 ${scenario.name}（model=${config.model}）…`);

    // ⚠️ 必须录 **provider 层**（model.doStream 的原始 part），不能录 streamText().fullStream ——
    // 后者是 ai-sdk 的抽象层（start / start-step / text-delta …），与 MockLanguageModelV3
    // 期望的 LanguageModelV3StreamPart（stream-start / text-start / text-delta / finish …）不是同一套。
    // 录错层的话回放会抛 "Unhandled chunk type: start"（实测踩到）。
    // 合成场景：不碰网络，直接产出协议形状
    if (scenario.synthetic !== undefined) {
        const parts: LanguageModelV3StreamPart[] = [];
        scenario.synthetic(parts);
        console.error(`  合成 ${parts.length} 个 part（真跑不出来，用协议形状）`);
        const src = toSource(scenario, parts);
        if (dry) { console.log(src); return; }
        mkdirSync(FIXTURE_DIR, { recursive: true });
        const file = join(FIXTURE_DIR, `${toKebab(scenario.name)}.gen.ts`);
        writeFileSync(file, src, "utf-8");
        console.error(`  ✓ ${file}`);
        return;
    }

    const abort = scenario.abortAfter === undefined ? undefined : new AbortController();
    const tools = scenario.tools
        ? Object.fromEntries(
              Object.entries(toolsFor()).map(([k, t]) => [k, (t as { inputSchema?: unknown }).inputSchema ?? { type: "object" }]),
          )
        : undefined;

    const parts: unknown[] = [];
    let n = 0;
    const result = await (model as unknown as {
        doStream: (opts: unknown) => Promise<{ stream: ReadableStream<unknown> }>;
    }).doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: scenario.prompt }] }],
        ...(tools ? { tools: Object.entries(tools).map(([name, schema]) => ({ type: "function", name, inputSchema: schema })) } : {}),
        abortSignal: abort?.signal,
    });

    try {
        for await (const part of result.stream) {
            parts.push(part);
            n += 1;
            if (scenario.abortAfter !== undefined && n >= scenario.abortAfter) {
                abort?.abort(new Error("recorded abort"));
                break;
            }
        }
    } catch (cause) {
        if (scenario.abortAfter === undefined) throw cause;
        console.error("  （按预期中断）");
    }

    console.error(`  录到 ${parts.length} 个 part`);
    const src = toSource(scenario, parts);
    if (dry) {
        console.log(src);
        return;
    }
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const file = join(FIXTURE_DIR, `${toKebab(scenario.name)}.gen.ts`);
    writeFileSync(file, src, "utf-8");
    console.error(`  ✓ ${file}`);
}

const argv = process.argv.slice(2);
const [, , ...rest] = process.argv;

if (rest.length === 0 || rest[0] === "list") {
    const cfg = testLlmConfig();
    console.log(`环境：${cfg ? `✓ ${cfg.model} @ ${cfg.baseURL}` : "✗ 未配置\n" + missingEnvText()}`);
    for (const s of SCENARIOS) {
        const file = join(FIXTURE_DIR, `${toKebab(s.name)}.gen.ts`);
        console.log(`  ${existsSync(file) ? "✓" : "·"} ${toKebab(s.name).padEnd(18)} ${s.about}`);
    }
    process.exit(0);
}

const target = SCENARIOS.find((s) => s.name === rest[0] || toKebab(s.name) === rest[0]);
if (!target) {
    console.error(`未知场景：${rest[0]}\n可用：${SCENARIOS.map((s) => toKebab(s.name)).join(", ")}`);
    process.exit(2);
}
if (!testLlmConfig()) {
    console.error(missingEnvText());
    process.exit(2);
}
await record(target, rest.includes("--dry"));
