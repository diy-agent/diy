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

    // ── 错误场景：**从 32478 条历史真实请求里提取**（~/.diy/log/network/，2.5G）──
    //
    // 全量扫描结果：只有 200 / 400 / 429 三种状态码，没有 5xx、没有 404。
    // 真实错误就三类，下面三份按「出现次数」和「业务重要性」选中：
    //   21× 429 server_error            上游 endpoint 整体不可用
    //   15× 400 invalid_request_error   thinking 模式的 reasoning_content 必须回传（真 bug）
    //    3× 429 rate_limit_error        上游临时不可用
    //
    // ⚠️ 早先我按「常见错误」凭空合成了 context_length_exceeded / model_coming_soon —— 
    //    这两个**在真实数据里一次都没发生过**，已删除（编造场景比没有场景更坏：
    //    它会让下游为不存在的情况写防御代码）。
    {
        name: "endpointUnavailable",
        about: "429 server_error · 上游 endpoint 整体不可用（真实 21 次）—— 下游要退避重试",
        prompt: "",
        synthetic: (parts) => {
            parts.push(
                { type: "stream-start", warnings: [] } as LanguageModelV3StreamPart,
                {
                    type: "error",
                    error: {
                        name: "AI_APICallError",
                        url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
                        requestBodyValues: { model: "deepseek-v4.1-flash", stream: true },
                        statusCode: 429,
                        responseBody: JSON.stringify({
                            error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." },
                        }),
                        isRetryable: true,
                        data: { error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } },
                    },
                } as unknown as LanguageModelV3StreamPart,
            );
        },
    },
    {
        name: "reasoningNotPassed",
        about: "400 invalid_request_error · thinking 模式的 reasoning_content 必须回传（真实 15 次，真 bug）",
        prompt: "",
        synthetic: (parts) => {
            parts.push(
                { type: "stream-start", warnings: [] } as LanguageModelV3StreamPart,
                {
                    type: "error",
                    error: {
                        name: "AI_APICallError",
                        url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
                        requestBodyValues: { model: "deepseek-v4.1-flash", stream: true },
                        statusCode: 400,
                        responseBody: JSON.stringify({
                            error: {
                                param: null,
                                type: "invalid_request_error",
                                code: "invalid_request_error",
                                message:
                                    "Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API.",
                            },
                        }),
                        // 不可重试 —— 重试只会再错一次，要修的是「回传」这个逻辑
                        isRetryable: false,
                        data: {
                            error: {
                                type: "invalid_request_error",
                                message:
                                    "Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API.",
                            },
                        },
                    },
                } as unknown as LanguageModelV3StreamPart,
            );
        },
    },
    {
        name: "rateLimit",
        about: "429 rate_limit_error · 上游模型临时不可用（真实 3 次）—— 短暂退避后可重试",
        prompt: "",
        synthetic: (parts) => {
            parts.push(
                { type: "stream-start", warnings: [] } as LanguageModelV3StreamPart,
                {
                    type: "error",
                    error: {
                        name: "AI_APICallError",
                        url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
                        requestBodyValues: { model: "deepseek-v4.1-flash", stream: true },
                        statusCode: 429,
                        responseBody: JSON.stringify({
                            error: {
                                message: "Upstream model provider is temporarily unavailable. Please try again in a moment.",
                                type: "rate_limit_error",
                            },
                        }),
                        isRetryable: true,
                        data: {
                            error: {
                                message: "Upstream model provider is temporarily unavailable. Please try again in a moment.",
                                type: "rate_limit_error",
                            },
                        },
                    },
                } as unknown as LanguageModelV3StreamPart,
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

// 类型用 `as unknown as` 强转：录制的是**真实线上形状** ——
//   · usage 可能缺 cacheWrite（上游没报就是没有）
//   · response-metadata.timestamp 是 ISO 字符串（JSON 只能存字符串）
// 而 SDK 的 LanguageModelV3StreamPart 是**理想形状**（字段必填、Date 对象）。
// 强行对齐类型等于编造上游没给的数据，所以这里如实保留原始形状。
export const ${scenario.name} = [
${lines.join("\n")}
] as unknown as LanguageModelV3StreamPart[];
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
