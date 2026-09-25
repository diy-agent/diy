// src/main/services/local-agent.ts
// 🎯 本地自定义 agent 服务 — ai-sdk streamText 直连 zen/go，实时输出块协议 Op 流
//
// 与 ACP 通道（acp-sessions-v2）完全独立：独立会话、独立存储、独立取消。
// 双日志（$DIY_HOME/local/）：
//   <key>.ops.jsonl — Op 流（UI 重放的权威）
//   <key>.llm.jsonl — ModelMessage[] 完整对话（续聊的权威，含工具链路 id）
// 密钥/上游收敛在 main：renderer 不接触 key；zen/go 无 CORS，代理是硬约束。

import { streamText, tool, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { diyHome, projectFromUri } from "../core/state";
import { resolveCwd as resolveCwdWithNote } from "../core/cwd";
import { BlockStore, blocksToMessages, interruptedToolPatches, type Op, type JSONVal } from "./local-blocks";
import { collectSelfInfo, judgeSelfKill, selfKillNotice } from "./agent-guard";
import { appendAudit } from "./agent-audit";
import { noteTurnEnd, noteTurnStart } from "./runtime-context";
import { assembleSystem } from "./prompt-registry";
import { readFileWindow, formatReadOutput, ReadWindowError, READ_MAX_BYTES, READ_MAX_LINES } from "../core/file-read";
import { SteerQueue } from "../core/steer-queue";
import type { SteerItem, SteerMode } from "../core/drafts";

export const DEFAULT_MODEL = "gpt-5.6-luna";

/**
 * 一次 chat 调用里最多自动续多少轮（每轮由一条插话触发）。
 *
 * 为什么必须有上限：插话会触发新一轮，而新一轮里用户还能再插话 —— 没有闸门时
 * "用户不停插嘴"能让单个 chat 流无限延续（CLI 侧更危险：一条命令永不返回）。
 * 到顶后剩余的插话**留在队列里**（UI 横条照旧显示待发送），并写一条 error 块告知。
 */
export const MAX_STEER_ROUNDS = 8;

/**
 * zen/go 基址：两个 API 面共用（chat/completions 与 responses 只是路径不同）。
 *
 * `DIY_ZEN_BASE_URL` 是**测试/自建代理**的接缝：插话投递时机只与"步/轮边界"有关，
 * 而真实上游无法保证边界何时到来（详见 tests/cli.intent.steer-ui.test.ts 的桩上游）。
 * 缺省不设即官方 zen/go，生产行为不变。
 */
export function zenBaseUrl(): string {
    return process.env["DIY_ZEN_BASE_URL"] || "https://opencode.ai/zen/go/v1";
}

/**
 * 模型走的 API 面。**必须逐个模型标注**，因为 zen/go 的 `GET /models` 不返回 API 面信息
 * （只有 id/object/created/owned_by），标错的表现是「上游 503 Endpoint is unavailable」：
 * responses-only 模型打到 /chat/completions 一律 503（gpt-5.6-luna / gpt-6-luna 2026-09-24 实测）。
 * 真源：pi 的 ~/.pi/agent/models-store.json 的 `api` 字段（opencode-go provider）。
 */
export type LocalModelApi = "chat" | "responses";
export type ReasoningEffort = string;

/** 模型能力的临时手工登记；待模型管理功能接入后由远端配置替换。 */
export interface LocalModelReasoning {
    supported: ReasoningEffort[];
    default: ReasoningEffort;
}

export interface LocalModel {
    id: string;
    name: string;
    /** chat = /chat/completions（@ai-sdk/openai-compatible）；responses = /responses（@ai-sdk/openai） */
    api: LocalModelApi;
    contextLimit: number;
    maxOutputTokens: number;
    reasoning: LocalModelReasoning;
}

/**
 * 可选模型（2026-09-24 实查 /models + models.dev 价格 + 两个 API 面逐个 curl 验证）
 * 价格单位为 $/1M tokens：input / output（cacheRead）
 *
 * `reasoning.supported` 的真源是**上游自己的校验报错**（2026-09-24 逐模型探测）：
 * 给 `reasoning_effort`（chat 面）/ `reasoning.effort`（responses 面）发一个非法值，
 * 上游回 400 并列出 expected one of ...，再逐值实测确认 200 / 400。
 * 实测差异：deepseek-v4.1-flash 多一个 `ultra` 档；两个 luna 都无 `minimal`；
 * mimo-v2.6-flash 只认 none/low/medium/high（minimal/xhigh/max 一律 400 Invalid request parameters）。
 * 注意：这与 pi 的 `thinkingLevelMap` 不同源 —— 那张表是「pi 档位 → 上游 thinking 字段」的映射，
 * 对直传 reasoning_effort 的 diy 不适用（pi 隐藏的档位在 diy 路径上实测有效）。
 */
export const LOCAL_MODELS: LocalModel[] = [
    // maxOutputTokens / contextLimit 来源：models.dev/api.json 的 limit.output / limit.context（2026-09 实查，
    // 取 opencode-go 或同名模型主 provider 的值）。contextLimit 用于推导系统上下文预算（见 prompt-registry）。
    // 首项 = UI 默认选中（localChatStore 取 ms[0]），必须与 DEFAULT_MODEL 一致。
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", api: "responses", contextLimit: 1050000, maxOutputTokens: 128000 , reasoning: { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" } }, // 0.20 / 1.20 (0.02)
    { id: "gpt-6-luna", name: "GPT 6 Luna", api: "responses", contextLimit: 1050000, maxOutputTokens: 128000 , reasoning: { supported: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" } }, // 0.10 / 0.50 (0.01)
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", api: "chat", contextLimit: 1000000, maxOutputTokens: 384000 , reasoning: { supported: ["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"], default: "medium" } }, // 0.15 / 0.60 (0.003)
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", api: "chat", contextLimit: 1048576, maxOutputTokens: 131072 , reasoning: { supported: ["none", "low", "medium", "high"], default: "medium" } }, // 0.14 / 0.28 (0.0028)
];

/** 按 model id 查 API 面；未知模型按 chat 处理（保持历史行为，不静默换面） */
export function reasoningOf(modelId: string): LocalModelReasoning {
    return LOCAL_MODELS.find(m => m.id === modelId)?.reasoning ?? { supported: ["none"], default: "none" };
}

export function apiOf(modelId: string): LocalModelApi {
    return LOCAL_MODELS.find(m => m.id === modelId)?.api ?? "chat";
}

/** 按 model id 查上下文窗口（tokens）；未知返回 undefined（预算回退到硬上限） */
export function contextLimitOf(modelId: string): number | undefined {
    return LOCAL_MODELS.find(m => m.id === modelId)?.contextLimit;
}

/** 按 model id 查 maxOutputTokens，fallback 到全局 limits */
function modelOutputTokens(modelId: string): number {
    return LOCAL_MODELS.find(m => m.id === modelId)?.maxOutputTokens ?? DEFAULT_LIMITS.maxOutputTokens;
}


// ─── 运行限制配置（默认值 < $DIY_HOME/local/limits.json < 环境变量 DIY_LOCAL_*）──
export interface LocalAgentLimits {
    /** 单轮最大模型步数（含工具步）；耗尽仍想调工具 → 强制收尾并 notice 提示 */
    maxSteps: number;
    /** 单次模型请求输出上限（推理模型 reasoning 先吃预算） */
    maxOutputTokens: number;
    /** 单条 bash 命令超时 */
    bashTimeoutMs: number;
    /** bash 输出回喂模型/展示的截断长度（字符） */
    outputClipChars: number;
    /** read 工具单次返回的字节上限（见 core/file-read.ts） */
    readMaxBytes: number;
}

export const DEFAULT_LIMITS: LocalAgentLimits = {
    maxSteps: 60,
    maxOutputTokens: 4000,
    bashTimeoutMs: 30_000,
    outputClipChars: 6000,
    readMaxBytes: READ_MAX_BYTES,
};

function limitsFile(): string {
    return path.join(localDir(), "limits.json");
}

function envPosInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
    const raw = env[key];
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        console.warn(`[local-agent] 非法环境变量 ${key}=${raw}，忽略`);
        return undefined;
    }
    return n;
}

/** 合并链：默认值 < 文件 < 环境变量；非法值逐级忽略。纯函数可单测。 */
export function resolveLimits(
    file: Partial<LocalAgentLimits> | null,
    env: NodeJS.ProcessEnv = process.env,
): LocalAgentLimits {
    const num = (v: unknown, d: number): number =>
        typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d;
    const base = { ...DEFAULT_LIMITS, ...(file ?? {}) };
    return {
        maxSteps: envPosInt(env, "DIY_LOCAL_MAX_STEPS") ?? num(base.maxSteps, DEFAULT_LIMITS.maxSteps),
        maxOutputTokens:
            envPosInt(env, "DIY_LOCAL_MAX_OUTPUT_TOKENS") ?? num(base.maxOutputTokens, DEFAULT_LIMITS.maxOutputTokens),
        bashTimeoutMs: envPosInt(env, "DIY_LOCAL_BASH_TIMEOUT_MS") ?? num(base.bashTimeoutMs, DEFAULT_LIMITS.bashTimeoutMs),
        outputClipChars: envPosInt(env, "DIY_LOCAL_OUTPUT_CLIP_CHARS") ?? num(base.outputClipChars, DEFAULT_LIMITS.outputClipChars),
        readMaxBytes: envPosInt(env, "DIY_LOCAL_READ_MAX_BYTES") ?? num(base.readMaxBytes, DEFAULT_LIMITS.readMaxBytes),
    };
}

// ─── 会话与持久化 ─────────────────────────────────────

interface LocalSession {
    /** 块树（Op 重放）：UI 与 fold 的唯一权威；llm.jsonl 只是观察 dump */
    store: BlockStore;
    messages: ModelMessage[];
    loaded: boolean;
    running: AbortController | null;
}

function localDir(): string {
    const d = path.join(diyHome(), "local");
    mkdirSync(d, { recursive: true });
    return d;
}

/**
 * 会话文件/亲和头共用键。
 * ⚠️ 不能只做字符替换：`a/b` 与 `a:b` 会洗成同一个 `a_b`（碰撞=两任务互相串历史、
 * 共享 zen 会话亲和头）。可读前缀只为便于排查，唯一性由 sha256 前 12 位负责。
 */
function keyOf(taskUri: string): string {
    const readable = taskUri.replace(/[^\w.-]+/g, "_").slice(0, 64);
    const sum = createHash("sha256").update(taskUri).digest("hex").slice(0, 12);
    return `${readable}-${sum}`;
}

function opsFile(taskUri: string): string {
    return path.join(localDir(), `${keyOf(taskUri)}.ops.jsonl`);
}
function llmFile(taskUri: string): string {
    return path.join(localDir(), `${keyOf(taskUri)}.llm.jsonl`);
}

/** 原始流 dump（仅 DIY_RAW_STREAM_DUMP=1 时写）：ai-sdk 的 part 原样落盘，用于研究“Op 是否漏信息” */
function rawFile(taskUri: string): string {
    return path.join(localDir(), `${keyOf(taskUri)}.raw.jsonl`);
}

/** 原始流开关（默认关；读取时快照一次，避免一处开一处关） */
function rawDumpEnabled(): boolean {
    return process.env["DIY_RAW_STREAM_DUMP"] === "1";
}

/** zen/go 会话亲和头：按 task 稳定（实测缺失会被 MissingSessionID 拒绝） */
function sessionIdOf(taskUri: string): string {
    return `local-${keyOf(taskUri)}`;
}

function readJsonl<T>(path: string): T[] {
    if (!existsSync(path)) return [];
    const out: T[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            out.push(JSON.parse(t) as T);
        } catch (e) {
            // 崩溃半行跳过不污染整个日志，但必须出声：丢行=丢历史，可观测才能排查
            console.warn(`[local-agent] 跳过无法解析的 jsonl 行 ${path}:`, String(e).slice(0, 120));
        }
    }
    return out;
}

// ─── 工具（execute 全在 main：副作用不出进程边界）────

function clip(s: string, n = 6000): string {
    return s.length > n
        ? `${s.slice(0, Math.floor(n / 2))}\n…[截断]…\n${s.slice(-Math.floor(n / 2))}`
        : s;
}

/** bash：30s 超时；失败也以文本回喂模型（错误是一等信息，不抛） */
function runBash(command: string, cwd: string, limits: LocalAgentLimits, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve("[已取消]");
            return;
        }
        execFile(
            "/bin/bash",
            ["-c", command],
            { cwd, timeout: limits.bashTimeoutMs, maxBuffer: 1024 * 1024, signal },
            (err, stdout, stderr) => {
                const out = [stdout, stderr].filter(Boolean).join("\n");
                if (err?.name === "AbortError") resolve("[已取消]");
                else if (err?.killed) resolve(`[命令超时被杀]\n${clip(out)}`);
                else if (err)
                    resolve(`[退出码 ${err.code ?? "?"}]\n${clip(out || String(err.message))}`);
                else resolve(out || "(无输出)");
            },
        );
    });
}

export function buildTools(cwd: string, limits: LocalAgentLimits, taskUri: string) {
    return {
        bash: tool({
            description: "在项目目录执行 bash 命令并返回输出（查文件、跑命令、看系统信息）。",
            inputSchema: z.object({ command: z.string().describe("要执行的 bash 命令") }),
            execute: async ({ command }, opts) => {
                const home = diyHome();
                // ① 自杀护栏：执行前拦（kill -9 不可捕获，事后补救不可能）
                const self = collectSelfInfo(home);
                if (self) {
                    const verdict = judgeSelfKill(command, self);
                    if (verdict.blocked) {
                        appendAudit(home, {
                            phase: "bash-blocked",
                            taskUri,
                            cwd,
                            command,
                            result: verdict.reason,
                        });
                        return selfKillNotice(verdict);
                    }
                }
                // ② write-ahead 审计：先落盘再执行，保证最后一幕不丢
                appendAudit(home, { phase: "bash-start", taskUri, cwd, command });
                const t0 = Date.now();
                const out = await runBash(
                    command,
                    cwd,
                    limits,
                    (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal,
                );
                appendAudit(home, {
                    phase: "bash-end",
                    taskUri,
                    cwd,
                    command,
                    ms: Date.now() - t0,
                    result: clip(out, 500),
                });
                return out;
            },
        }),
        read: tool({
            description:
                "读取文件的文本内容（带行号；相对路径按项目目录解析）。" +
                `单次最多 ${READ_MAX_LINES} 行 / ${Math.round(READ_MAX_BYTES / 1024)}KB，` +
                "超限时输出尾部会给出下一段 offset —— 用 offset 继续读，不要重复读同一段。",
            inputSchema: z.object({
                path: z.string().describe("文件路径"),
                offset: z.number().optional().describe("起始行，1-based（缺省 1；续读时传上次提示的 offset）"),
                limit: z.number().optional().describe("最大行数（缺省 2000）"),
            }),
            execute: async ({ path: filePath, offset, limit }) => {
                const abs = path.resolve(cwd, filePath);
                try {
                    // 与 `diy tool read` 共用同一实现：窗口语义只有一份（见 core/file-read.ts）
                    const window = await readFileWindow(abs, abs, { offset, limit, maxBytes: limits.readMaxBytes });
                    // style: "tool" —— 续读提示写成工具参数 offset=N（不是 shell 的 --offset）
                    return formatReadOutput(window, { maxBytes: limits.readMaxBytes, style: "tool" });
                } catch (e) {
                    if (e instanceof ReadWindowError) return `[读取失败] ${e.message}`;
                    return `[读取失败] ${e instanceof Error ? e.message : e}`;
                }
            },
        }),
    };
}

// ─── fullStream 取值兜底（v7 字段命名跨 part 不一致）──

function pick(part: unknown, ...keys: string[]): string {
    const p = part as Record<string, unknown>;
    for (const k of keys) {
        const v = p[k];
        if (typeof v === "string") return v;
    }
    return "";
}

function outText(output: unknown): string {
    if (typeof output === "string") return output;
    const o = output as Record<string, unknown> | null;
    if (o && typeof o.value === "string") return o.value;
    return JSON.stringify(output);
}

function errText(e: unknown): string {
    if (e instanceof Error) return e.message;
    const o = e as Record<string, unknown> | null;
    if (o && typeof o.message === "string") return o.message;
    return String(e ?? "未知错误");
}

// ─── 服务 ────────────────────────────────────────────

export class LocalAgentManager {
    private sessions = new Map<string, LocalSession>();
    /**
     * 插话队列（「插入到下一步 / 下一次对话后」）。
     *
     * 权威落盘在任务目录 .diy/drafts.yaml（与聊天草稿同文件、同类数据：都是"丢了 = 用户白打"），
     * 因此重启应用、切 Electron/serve 模式后队列仍在；本对象只是无状态门面（每次现读盘）。
     */
    private queue = new SteerQueue();
    /** chat 面 provider（/chat/completions）；与 responses 面各自单例，key 同生命周期 */
    private provider: ReturnType<typeof createOpenAICompatible> | null = null;
    /** responses 面 provider（/responses）—— responses-only 模型打 chat 面必 503，见 apiOf 注释 */
    private respProvider: ReturnType<typeof createOpenAI> | null = null;
    private _limits: LocalAgentLimits | null = null;

    /**
     * 语言模型解析的可注入出口（缺省按 API 面走 zen/go）。
     *
     * 存在理由：插话投递的时机（下一个模型步之前 / 下一轮）只能用**受控的上游**验证 ——
     * 真实 LLM 无法保证"这一步一定调工具、下一步一定给答复"，断言会假红。单测注入桩
     * 模型（`ai/test` 的 MockLanguageModelV3）后，步/轮边界变成确定事件，可逐条断言。
     */
    private readonly modelResolver?: (id: string, key: string) => LanguageModel;

    constructor(modelResolver?: (id: string, key: string) => LanguageModel) {
        this.modelResolver = modelResolver;
    }

    /** 按 API 面取语言模型：同一 baseURL，路径由 provider 决定（/chat/completions vs /responses） */
    private modelFor(id: string, key: string): LanguageModel {
        if (this.modelResolver) return this.modelResolver(id, key);
        if (apiOf(id) === "responses") {
            this.respProvider ??= createOpenAI({ name: "zen-go", baseURL: zenBaseUrl(), apiKey: key });
            return this.respProvider.responses(id);
        }
        this.provider ??= createOpenAICompatible({ name: "zen-go", baseURL: zenBaseUrl(), apiKey: key });
        return this.provider(id);
    }

    /** 生效限制：首次使用读 limits.json 并缓存（改文件需重启应用，与 zen key 同生命周期语义） */
    getLimits(): LocalAgentLimits {
        if (!this._limits) {
            let file: Partial<LocalAgentLimits> | null = null;
            try {
                if (existsSync(limitsFile())) {
                    file = JSON.parse(readFileSync(limitsFile(), "utf-8")) as Partial<LocalAgentLimits>;
                }
            } catch (e) {
                console.warn(`[local-agent] limits.json 解析失败，用默认值:`, e);
            }
            this._limits = resolveLimits(file);
            console.log(`[local-agent] 生效运行限制: ${JSON.stringify(this._limits)}`);
        }
        return this._limits;
    }

    private getSession(taskUri: string): LocalSession {
        let s = this.sessions.get(taskUri);
        if (!s) {
            s = { store: new BlockStore(), messages: [], loaded: false, running: null };
            this.sessions.set(taskUri, s);
        }
        if (!s.loaded) {
            // ops 日志 → 块树 → LLM 历史（wire = store = UI = LLM 单一权威路径）
            for (const op of readJsonl<Op>(opsFile(taskUri))) s.store.apply(op);
            s.messages = blocksToMessages(s.store) as unknown as ModelMessage[];
            s.loaded = true;
        }
        return s;
    }

    listModels(): LocalModel[] {
        return LOCAL_MODELS;
    }

    history(taskUri: string): Op[] {
        return readJsonl<Op>(opsFile(taskUri));
    }

    cancel(taskUri: string): boolean {
        const s = this.sessions.get(taskUri);
        if (!s?.running) return false;
        s.running.abort();
        return true;
    }

    /**
     * 提交一条插话（"插嘴"）。只入队，不唤醒任何东西：
     * 正在跑的轮次会在下一个模型步（step）或本轮末尾（turn）取走；没有在跑就先留在队列里，
     * 由 UI 横条展示（可取消），下一次对话开始后生效。
     */
    steerAdd(taskUri: string, mode: SteerMode, text: string): SteerItem[] {
        return this.queue.add(taskUri, mode, text);
    }

    /** 当前待投递的插话（FIFO，顺序即投递顺序） */
    steerList(taskUri: string): SteerItem[] {
        return this.queue.list(taskUri);
    }

    /** 取消一条待投递插话（幂等：id 不存在就返回原队列） */
    steerCancel(taskUri: string, id: string): SteerItem[] {
        return this.queue.remove(taskUri, id);
    }

    clear(taskUri: string): boolean {
        this.cancel(taskUri);
        this.sessions.delete(taskUri);
        // 会话都要删了，排队中的插话无处可投 —— 一并清掉（否则横条会一直挂着"待发送"）
        try {
            this.queue.clear(taskUri);
        } catch (e) {
            console.error(`[local-agent] 清空插话队列失败 ${taskUri}:`, e);
            return false;
        }
        for (const f of [opsFile(taskUri), llmFile(taskUri), rawFile(taskUri)]) {
            try {
                rmSync(f, { force: true });
            } catch (e) {
                // force:true 已吸收 ENOENT；能到这里的都是真故障（权限/只读盘），不能冒充成功
                console.error(`[local-agent] 删除日志失败 ${f}:`, e);
                return false;
            }
        }
        return true;
    }

    /**
     * 一轮对话：实时产出块协议 Op；op 即传即落盘（存储=传输）。同 task 并发拒绝。
     *
     * 「插嘴」在同一个流里投递：首轮用调用方的 message，本轮（及后续自动轮）由插话队列喂
     * （见 MAX_STEER_ROUNDS）。对消费端（renderer 的 for await）而言始终只是一个流，
     * 中途换没换轮次不需要它知道。
     */
    async *chat(taskUri: string, message: string, model?: string, reasoningEffort?: ReasoningEffort): AsyncGenerator<Op> {
        const key = process.env.OPENCODE_ZEN_API_KEY;
        if (!key) throw new Error("缺少 OPENCODE_ZEN_API_KEY（main 进程环境变量）");
        const sess = this.getSession(taskUri);
        if (sess.running) throw new Error(`任务 ${taskUri} 的本地会话正在生成中`);
        const ctrl = new AbortController();
        sess.running = ctrl;
        let done = false;
        try {
            const fp = opsFile(taskUri);
            // 落盘与投递解耦：sink 在 emission 时直接写文件，即使消费端提前断开，日志也不丢尾
            const sink = (op: Op) => {
                try {
                    appendFileSync(fp, `${JSON.stringify(op)}\n`, "utf-8");
                } catch (e) {
                    // 落盘失败不阻断流，但必须出声（否则丢行不可观测）
                    console.error(`[local-agent] ops 落盘失败 ${fp}:`, e);
                }
            };
            // ── 先收敛上一轮遗留的中断 tool 块（写进 ops，而不是投影时现造）──
            // 不收敛的后果：每次重建历史都现场合成一句「未完成→请重试」，agent 重载会话后
            // 会把被截断的命令再跑一次（任务 92 的「一对话就自杀」）。落盘后它变成已结束的
            // 历史事实，投影与 UI 都只是翻译它。
            for (const op of interruptedToolPatches(sess.store)) {
                sink(op);
                sess.store.apply(op);
                yield op;
            }

            // ── 轮次循环：首轮 = 调用方消息，之后各轮 = 插话队列喂进来的消息 ──
            // "插入到下一次对话后"（turn 模式）就是在这里落地的：本轮结束前发现队列非空，
            // 自动接着开新一轮 —— 用户不必再敲一次回车。
            let pending: { text: string; kind: "user" | SteerMode } | null = { text: message, kind: "user" };
            for (let round = 0; pending && !ctrl.signal.aborted; round++) {
                // 手动驱动内层生成器（而不是 `yield*` 委托）：委托会把 op 直接交给消费端，
                // 跳过这里的 `sess.store.apply` —— 而 store 是本模块的**单一权威**
                // （wire = store = UI = LLM），漏一次 apply 就会让下一段重建 messages 时看不到
                // 刚发出的 user 块（实测症状：`InvalidPromptError: messages must not be empty`）。
                // 手动驱动同时还能拿到内层的返回值（failed），for-await 会把它丢掉。
                const inner = this.runTurn(
                    taskUri, sess, pending.text, pending.kind, model, reasoningEffort, ctrl.signal, key, sink,
                );
                let failed = false;
                try {
                    for (;;) {
                        const r = await inner.next();
                        if (r.done) {
                            failed = r.value.failed;
                            break;
                        }
                        sess.store.apply(r.value);
                        yield r.value;
                    }
                } finally {
                    // 消费端提前断开（切页/停止）：把内层也关掉，别让它的收尾悬在半路
                    await inner.return({ failed: false });
                }
                if (failed || ctrl.signal.aborted) break;
                // 上限保护：插话会不断延长对话（每一轮都可能又冒出新的插话），没有上限时
                // "用户不停插嘴 → 无限自我续命"（CLI 一条命令永不返回）。
                // ⚠️ 必须**先判上限再取项**：取项是"取出即落盘删除"（投递的唯一入口），
                // 取出来再丢弃就是真丢用户的话。故上限分支只读队列、不取项 —— 剩余插话留在盘上
                // （UI 横条照旧显示待发送、可取消），并写显式 error 块，不静默吞。
                let queued: SteerItem[];
                try {
                    queued = this.queue.list(taskUri);
                } catch (e) {
                    // 队列读不出来也不许静默：剩余的插话仍在盘上，只是本轮不再续
                    console.error(`[local-agent] 插话队列读取失败，停止自动续轮 ${taskUri}:`, e);
                    break;
                }
                if (queued.length === 0) break;
                if (round + 1 >= MAX_STEER_ROUNDS) {
                    const id = `${queued[0]!.id}-limit`;
                    const msg = `连续插话已达 ${MAX_STEER_ROUNDS} 轮上限，剩余 ${queued.length} 条插话未投递（仍在队列里，可取消或再发一条消息触发）`;
                    const ops: Op[] = [
                        { op: "start", id, kind: "error", meta: { source: "steer" } },
                        { op: "delta", id, fields: { message: msg } },
                        { op: "stop", id },
                    ];
                    for (const op of ops) {
                        sink(op);
                        yield op;
                    }
                    break;
                }
                let item: SteerItem | undefined;
                try {
                    // turn 优先于 step：turn 模式的语义本就是"下一轮"；step 模式走到这里说明本轮
                    // 已经收尾（模型给出了最终答复、或步数用尽），降级为下一轮 —— 否则它永远发不出去。
                    item = this.queue.takeFirst(taskUri, "turn") ?? this.queue.takeFirst(taskUri, "step");
                } catch (e) {
                    console.error(`[local-agent] 插话取项失败，停止自动续轮 ${taskUri}:`, e);
                    break;
                }
                if (!item) break;
                pending = { text: item.text, kind: item.mode };
            }
            done = true;
            // 轮末：从块树重建 LLM 历史（含本轮 user/tool 链路与插话块），整体覆盖 llm 日志
            sess.messages = blocksToMessages(sess.store) as unknown as ModelMessage[];
            // dump 整文件覆盖 → tmp+rename 原子化：读取方永不见半文件（权威仍是 ops append-only）
            const dump = llmFile(taskUri);
            writeFileSync(`${dump}.tmp`, sess.messages.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");
            renameSync(`${dump}.tmp`, dump);
        } finally {
            // 消费端提前断开（切 tab/刷新/杀 CLI）：停掉上游，不让 LLM/工具在无人处继续烧 token
            // （AbortController.abort() 按规范不抛错，此处无需 try/catch）
            if (!done) ctrl.abort();
            sess.running = null;
        }
    }

    /**
     * 生成器本体：ai-sdk fullStream → Op。唯一认识 ai-sdk 事件名的地方。
     *
     * 分「段」（segment）跑：一段 = 一次 streamText 调用（内含若干模型步）。段在两种情况下
     * 再来一段，都在同一个 turn 里：
     *   ① 段内还有后续步 → prepareStep 把队列里的 step 插话插进那一步之前（最贴近"下一步"）；
     *   ② 段已结束（模型不再请求工具）但队列里还有 step 插话 → 续一段把它们递出去
     *      —— 等效于 dsh 的「turn-stopping 时有 steering 就再跑一步」，否则"模型直接给最终
     *      答复"这种常见情形下，插话永远等不到下一步。
     */
    private async *runTurn(
        taskUri: string,
        sess: LocalSession,
        message: string,
        userKind: "user" | SteerMode,
        model: string | undefined,
        reasoningEffort: ReasoningEffort | undefined,
        signal: AbortSignal,
        key: string,
        sink: (op: Op) => void,
    ): AsyncGenerator<Op, { failed: boolean }, void> {
        const turnId = `t${Date.now()}`;
        const uid = `${turnId}_u`;
        const cwd0 = resolveCwdWithNote(diyHome(), taskUri).cwd;
        noteTurnStart({ taskUri, model: model || DEFAULT_MODEL, cwd: cwd0 });
        appendAudit(diyHome(), {
            phase: "turn-start",
            taskUri,
            model: model || DEFAULT_MODEL,
            cwd: cwd0,
            command: message.slice(0, 300),
        });
        // emission 即落盘：yield 前先过 sink，消费端断开也不丢尾
        const started = new Set<string>();
        const emit = function* (op: Op): Generator<Op, void, void> {
            sink(op);
            if (op.op === "start") started.add(op.id);
            yield op;
        };
        // provider 不保证 *-start 先到：用数据前先确保 start 已发（wire 永远干净，补救只在适配层）
        const ensure = function* (
            id: string,
            kind: "think" | "text" | "tool",
            parent: string,
            meta?: Record<string, JSONVal>,
        ): Generator<Op, void, void> {
            if (!started.has(id)) yield* emit({ op: "start", id, kind, parent, meta });
        };
        yield* emit({ op: "start", id: turnId, kind: "turn", meta: { model: model || DEFAULT_MODEL } });
        // user 块：插话带 steer 标记 —— UI 据此把这条标成"插嘴进来的"，
        // 也是重放/续聊时唯一能区分"用户主动说"与"插嘴补一句"的线索
        yield* emit({
            op: "start",
            id: uid,
            kind: "text",
            parent: turnId,
            meta: { role: "user", ...(userKind === "user" ? {} : { steer: userKind }) },
        });
        yield* emit({ op: "delta", id: uid, fields: { content: message } });
        yield* emit({ op: "stop", id: uid });

        let eN = 0;
        const errorBlock = function* (source: string, text: string): Generator<Op, void, void> {
            const id = `${turnId}_e${++eN}`;
            yield* emit({ op: "start", id, kind: "error", parent: turnId, meta: { source } });
            yield* emit({ op: "delta", id, fields: { message: text } });
            yield* emit({ op: "stop", id });
        };
        // part id → 块 id（think/text）；tool 块直接用 toolCallId
        const partBlock = new Map<string, string>();
        let stepId = turnId;
        let stepN = 0;
        let rN = 0;
        let aN = 0;
        let uN = 0;
        // turn 级 usage 累加器（finish-step 逐轮累加；finish 到达时按段覆盖为权威值）
        const acc = { in: 0, out: 0, total: 0 };
        // 收尾原因追踪：步数耗尽检测（最后动作是 tool 且 step 用满 = 模型还想干活被掐）
        let lastAct: "none" | "text" | "tool" = "none";

        // ── 插话投递 ─────────────────────────────────────────────
        // prepareStep 是同步回调（不是生成器），只能先把 op 排队、由流循环 flush 出去
        let pendingSteerOps: Op[] = [];
        /** 插话的 user 块（三个 op）；parent 一律 = turn —— 该块在文档序上就是"某步之后、下一步之前" */
        const steerBlockOps = (item: SteerItem): Op[] => {
            const id = `${turnId}_su${++uN}`;
            return [
                { op: "start", id, kind: "text", parent: turnId, meta: { role: "user", steer: item.mode } },
                { op: "delta", id, fields: { content: item.text } },
                { op: "stop", id },
            ];
        };
        /**
         * 取出一条 step 模式插话：先落盘（+排队待 yield），返回文本供注入 messages；无则 null。
         *
         * 取不出来（队列写盘失败）就当没有 —— 绝不能"模型看见了、文件里还留着"：
         * 那会让同一条插话在下一步被投递第二次。
         */
        const takeStepSteer = (): string | null => {
            let item: SteerItem | undefined;
            try {
                item = this.queue.takeFirst(taskUri, "step");
            } catch (e) {
                console.error(`[local-agent] 插话队列取项失败 ${taskUri}：`, e);
                return null;
            }
            if (!item) return null;
            for (const op of steerBlockOps(item)) {
                // 先落盘：即使随后流被中断，重放历史里仍有这条插话（谁也不会"没看见就没了"）
                sink(op);
                pendingSteerOps.push(op);
            }
            return item.text;
        };
        /** 把排队中的插话 op 交给消费端（必须在下一步开始前调用：块的落点决定消息顺序） */
        const flushSteer = function* (): Generator<Op, void, void> {
            if (pendingSteerOps.length === 0) return;
            const ops = pendingSteerOps;
            pendingSteerOps = [];
            for (const op of ops) yield op;
        };

        /** 收尾必闭合（幂等）：step 先于 turn，摘掉活跃轮次并落 turn-end 审计。
         *  抽成生成器是为了让「超预算早退」也走同一套收尾 —— 历史 bug：早退的 return 在 try 之前，
         *  绕过 finally → activeTurns 留僵尸轮次、落盘 ops 缺 turn 的 stop、审计缺 turn-end。
         *  跨段之后 turn 的 stop 只能在这里发：只有走到这里才知道不会再续一段。 */
        const closeTurn = function* (currentStepId: string, steps: number): Generator<Op, void, void> {
            if (currentStepId !== turnId) yield* emit({ op: "stop", id: currentStepId });
            yield* emit({ op: "stop", id: turnId });
            noteTurnEnd(taskUri);
            appendAudit(diyHome(), {
                phase: "turn-end",
                taskUri,
                model: model || DEFAULT_MODEL,
                result: `steps=${steps} usage=${acc.in}/${acc.out}`,
            });
        };

        // 系统上下文：分节装配（身份/自述/项目规范/任务/规则/护栏）——与试验场预览同一入口
        const asm = assembleSystem(diyHome(), projectFromUri(taskUri), {
            taskUri,
            // 预算与当前模型的上下文窗口挂钩（小窗口模型拿更小预算，大窗口封顶 64KB）
            contextLimitTokens: contextLimitOf(model || DEFAULT_MODEL),
        });
        if (asm.overBudget) {
            const kb = (n: number) => (n / 1024).toFixed(1);
            yield* errorBlock(
                "budget",
                `系统上下文超出预算（${kb(asm.overBudget.used)} KB > ${kb(asm.overBudget.budget)} KB），本轮未发送。` +
                    `请精简提示词模版或项目 AGENTS.md。`,
            );
            // 拒绝发送也是一轮完整生命周期：必须闭合，否则 UI/崩溃报告/审计三处都会认为它还在跑
            yield* closeTurn(stepId, stepN);
            return { failed: false };
        }

        const cwd = cwd0;
        const L = this.getLimits();
        const modelMax = modelOutputTokens(model || DEFAULT_MODEL);
        // 研究用：把“发给上游的 messages”与 fullStream 的每个 part 原样落盘
        const raw = rawDumpEnabled() ? rawFile(taskUri) : null;
        let rawSeq = 0;
        const rawSink = (row: Record<string, unknown>): void => {
            if (!raw) return;
            try {
                appendFileSync(raw, `${JSON.stringify(row)}\n`, "utf-8");
            } catch (e) {
                console.error(`[local-agent] raw dump 写入失败 ${raw}:`, e);
            }
        };

        let failed = false;
        for (let seg = 0; !signal.aborted; seg++) {
            // 每段都从块树重建 messages：上一段的产出 + 中途落下的插话块都在里面，
            // 「wire = store = UI = LLM」这条链不能因为分段而破例
            const sent: ModelMessage[] = blocksToMessages(sess.store) as unknown as ModelMessage[];
            // 本段开始前的 usage 快照：段级 totalUsage 只代表本段，换算成 turn 累计要加它
            const segStart = { ...acc };
            rawSink({
                kind: "request",
                seg,
                ts: new Date().toISOString(),
                model: model || DEFAULT_MODEL,
                system: asm.system,
                tools: Object.keys(buildTools(cwd, L, taskUri)),
                settings: { maxSteps: L.maxSteps, maxOutputTokens: modelMax, maxRetries: 2, reasoningEffort: reasoningEffort ?? "none" },
                messages: sent,
            });
            const result = streamText({
                model: this.modelFor(model || DEFAULT_MODEL, key),
                system: asm.system,
                messages: sent,
                tools: buildTools(cwd, L, taskUri),
                stopWhen: stepCountIs(L.maxSteps),
                abortSignal: signal,
                headers: { "x-opencode-session": sessionIdOf(taskUri) },
                maxOutputTokens: modelMax, // 按模型硬上限（models.dev），reasoning 模型会先吃一部分
                // none 用 AI SDK 标准关闭语义；其他值由 OpenAI-compatible provider 原样转发。
                // provider 配置可以提供 minimal/xhigh/max 等非通用值，不能压缩成固定枚举。
                ...(reasoningEffort === "none"
                    ? { reasoning: "none" as const }
                    : reasoningEffort
                      ? { providerOptions: { openaiCompatible: { reasoningEffort } } }
                      : {}),
                maxRetries: 2,
                // 每个模型步开始前的唯一钩子：把队列里的 step 插话插进这一步的 messages。
                // 返回的 messages 会 carry forward 到后续步（SDK 语义），所以模型一开口就能看到插话。
                //
                // 只在第二步及之后注入（stepNumber > 0）：用户点的是"插到**下一步**" ——
                // 本轮的第一个请求不是"下一步"，它是这一轮本身（在它之前插入等于把插话
                // 当成了本轮开场的用户消息）。第一步之前的插话由段末续段逻辑递出，两条路径合起来
                // 才能覆盖全部情形（见 runTurn 段循环末尾）。
                prepareStep: ({ messages, stepNumber }) => {
                    if (signal.aborted || stepNumber === 0) return {};
                    const text = takeStepSteer();
                    return text === null ? {} : { messages: [...messages, { role: "user" as const, content: text }] };
                },
            });

            try {
                for await (const part of result.fullStream) {
                    // prepareStep 里落的插话 op 在这里递出去：此刻 start-step 还没发，
                    // 所以块的文档序正确落在"上一步之后、这一步之前"
                    yield* flushSteer();
                    rawSink({ kind: "part", seg, seq: ++rawSeq, ts: new Date().toISOString(), part });
                    switch (part.type) {
                        case "start-step":
                            stepN++;
                            stepId = `${turnId}_s${stepN}`;
                            yield* emit({ op: "start", id: stepId, kind: "step", parent: turnId });
                            break;
                        case "reasoning-start": {
                            const id = `${turnId}_r${++rN}`;
                            partBlock.set(part.id, id);
                            yield* emit({ op: "start", id, kind: "think", parent: stepId });
                            break;
                        }
                        case "reasoning-delta": {
                            let id = partBlock.get(part.id);
                            if (!id) {
                                id = `${turnId}_r${++rN}`;
                                partBlock.set(part.id, id);
                                yield* ensure(id, "think", stepId);
                            }
                            yield* emit({ op: "delta", id, fields: { content: pick(part, "text", "delta") } });
                            break;
                        }
                        case "reasoning-end": {
                            const id = partBlock.get(part.id);
                            if (id) yield* emit({ op: "stop", id });
                            break;
                        }
                        case "text-start": {
                            lastAct = "text";
                            const id = `${turnId}_a${++aN}`;
                            partBlock.set(part.id, id);
                            yield* emit({ op: "start",
                                id,
                                kind: "text",
                                parent: stepId,
                                meta: { role: "assistant" },
                            });
                            break;
                        }
                        case "text-delta": {
                            let id = partBlock.get(part.id);
                            if (!id) {
                                id = `${turnId}_a${++aN}`;
                                partBlock.set(part.id, id);
                                yield* ensure(id, "text", stepId, { role: "assistant" });
                            }
                            yield* emit({ op: "delta", id, fields: { content: pick(part, "text", "delta") } });
                            break;
                        }
                        case "text-end": {
                            const id = partBlock.get(part.id);
                            if (id) yield* emit({ op: "stop", id });
                            break;
                        }
                        case "tool-input-start":
                            lastAct = "tool";
                            partBlock.set(part.id, part.id);
                            yield* emit({ op: "start",
                                id: part.id,
                                kind: "tool",
                                parent: stepId,
                                meta: { tool: part.toolName, status: "streaming" },
                            });
                            break;
                        case "tool-input-delta": {
                            const tid =
                                (part as { id?: string; toolCallId?: string }).id
                                ?? (part as { toolCallId?: string }).toolCallId
                                ?? stepId;
                            yield* ensure(tid, "tool", stepId, { tool: "tool", status: "streaming" });
                            partBlock.set(tid, tid);
                            yield* emit({ op: "delta",
                                id: tid,
                                fields: {
                                    input: pick(part, "text", "delta", "partialText", "inputTextDelta"),
                                },
                            });
                            break;
                        }
                        case "tool-call": {
                            yield* ensure(part.toolCallId, "tool", stepId, { tool: part.toolName, status: "streaming" });
                            const input = (part as { input?: JSONVal }).input;
                            const title =
                                input &&
                                typeof input === "object" &&
                                !Array.isArray(input) &&
                                "command" in input
                                    ? String((input as Record<string, unknown>).command)
                                    : JSON.stringify(input ?? "").slice(0, 120);
                            yield* emit({ op: "patch",
                                id: part.toolCallId,
                                fields: {
                                    tool: part.toolName,
                                    input: JSON.stringify(input ?? {}),
                                    args: input ?? null,
                                    status: "running",
                                    title,
                                },
                            });
                            break;
                        }
                        case "tool-result":
                            yield* ensure(part.toolCallId, "tool", stepId, { tool: part.toolName ?? "tool" });
                            yield* emit({ op: "delta",
                                id: part.toolCallId,
                                fields: { output: outText(part.output) },
                            });
                            yield* emit({ op: "patch", id: part.toolCallId, fields: { status: "done" } });
                            yield* emit({ op: "stop", id: part.toolCallId });
                            break;
                        case "tool-error": {
                            const id = (part as { toolCallId?: string }).toolCallId ?? stepId;
                            if (id !== stepId) yield* ensure(id, "tool", stepId, { tool: "tool", status: "streaming" });
                            yield* emit({ op: "delta",
                                id,
                                fields: { output: errText((part as { error?: unknown }).error) },
                            });
                            yield* emit({ op: "patch", id, fields: { status: "error" } });
                            yield* emit({ op: "stop", id });
                            break;
                        }
                        case "error":
                            yield* errorBlock("llm", errText((part as { error?: unknown }).error));
                            break;
                        case "abort":
                            yield* errorBlock("abort", "生成已取消");
                            break;
                        case "finish-step": {
                            // 每步 usage 累加进 turn（zen 流尾 totalUsage 偶发缺失，双保险）
                            const su = (part as unknown as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }).usage;
                            if (su) {
                                acc.in += su.inputTokens ?? 0;
                                acc.out += su.outputTokens ?? 0;
                                acc.total += su.totalTokens ?? (su.inputTokens ?? 0) + (su.outputTokens ?? 0);
                                yield* emit({ op: "patch", id: turnId, fields: { usage: { ...acc } } });
                            }
                            if (stepId !== turnId) yield* emit({ op: "stop", id: stepId });
                            break;
                        }
                        case "finish": {
                            const usage = (
                                part as unknown as {
                                    totalUsage?: {
                                        inputTokens?: number;
                                        outputTokens?: number;
                                        totalTokens?: number;
                                    };
                                }
                            ).totalUsage;
                            // 截断/耗尽显式化：写进 turn.notice，UI 页脚展示（限制值来自动态配置）
                            const fr = (part as { finishReason?: string }).finishReason;
                            let notice: string | undefined;
                            if (fr === "length") {
                                notice = `输出达到 maxOutputTokens=${modelMax} 被截断（${model || DEFAULT_MODEL} 硬上限），可再发一条消息接上`;
                            } else if (stepN >= L.maxSteps && lastAct === "tool") {
                                notice = `达到 maxSteps=${L.maxSteps} 步上限，本轮强制收尾（模型仍在请求工具）；继续发消息可接力`;
                            }
                            if (notice) yield* emit({ op: "patch", id: turnId, fields: { notice } });
                            if (usage) {
                                // totalUsage 是**这一段**的权威值（不是整个 turn）：按段快照换算累计，
                                // 直接覆盖会让后一段把前一段的用量抹掉
                                acc.in = segStart.in + (usage.inputTokens ?? 0);
                                acc.out = segStart.out + (usage.outputTokens ?? 0);
                                acc.total =
                                    segStart.total
                                    + (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
                                yield* emit({ op: "patch", id: turnId, fields: { usage: { ...acc } } });
                            }
                            // turn 的 stop 不在这里发：可能还有下一段（插话），只有 closeTurn 知道是不是真的结束
                            break;
                        }
                    }
                }

                // LLM 历史由外层 chat() 从块树统一重建（见 chat 末尾），此处不操作
            } catch (e) {
                // 取消（消费端断开 / 停止按钮）与真实错误分流：前者是预期收尾，后者记 error 块
                if (signal.aborted) yield* errorBlock("abort", "生成已取消");
                else {
                    yield* errorBlock("stream", errText(e));
                    failed = true;
                }
            }
            // 段末兜底 flush：被中断的那段里 prepareStep 落过的插话 op 也要见天日
            // （sink 已落盘，这里负责让当前会话的 UI 立刻看到）
            yield* flushSteer();
            if (failed || signal.aborted) break;
            if (stepN >= L.maxSteps) break; // 步数用尽：剩下的插话留给下一轮（chat 外层会取走）
            // 段已结束（模型不再请求工具）：若队列里还有 step 插话，续一段把它递出去。
            // 不这么做的话，"模型一步一步做完直接给最终答复"这种最常见的情形下，插话永远
            // 等不到下一个模型步 —— 用户点了"插入到下一步"却要等到下次对话才生效。
            const text = takeStepSteer();
            if (text === null) break;
            // 立刻把插话块递给消费端：下一段要从 store 重建 messages，必须先由外层 apply 落进块树
            yield* flushSteer();
        }

        // 收尾必闭合：step 先于 turn（stop 幂等，重复无害）；
        // 轮次审计收尾：崩溃后能区分"死在生成中"还是"生成已结束"
        yield* closeTurn(stepId, stepN);
        return { failed };
    }
}

/** 单例（api-impl 懒加载，同 getSessionPool 模式） */
let _manager: LocalAgentManager | null = null;
export function getLocalAgent(): LocalAgentManager {
    if (!_manager) _manager = new LocalAgentManager();
    return _manager;
}

// ─── 仿真预览：走真实组装链、发送前掐断 ─────────────────────────

/** 预览专用 provider（单例复用）：带 transformRequestBody 钩子的实例不能直接用业务单例，
 *  但也不必每次预览新建一个 —— 进程内复用一个即可。 */
let simProviderCache: ReturnType<typeof createOpenAICompatible> | null = null;
/** 预览专用 provider（responses 面）：无 transformRequestBody 钩子，body 改在 fetch 桩里捕获 */
let simRespProviderCache: ReturnType<typeof createOpenAI> | null = null;
/** 当前在飞预览的 body 收集器（单飞即可：试验场防抖 300ms，重叠时后一次覆盖前一次） */
let simBodySink: ((b: Record<string, unknown>) => void) | null = null;

function getSimProvider(model: string): ReturnType<typeof createOpenAICompatible> {
    if (simProviderCache) return simProviderCache;
    simProviderCache = createOpenAICompatible({
        name: "preview-sim",
        baseURL: "http://127.0.0.1:1/unreachable",
        apiKey: "preview-no-key",
        transformRequestBody: (args) => {
            simBodySink?.(args as Record<string, unknown>);
            return args;
        },
        // fetch 桩：body 已在 hook 里捕获，这里回一段合法 SSE 把流干干净净收尾
        // （比 throw 更好：不打印 SDK 错误，dry-run 的「零副作用」才成立）
        fetch: (async () => {
            const sse = [
                `data: ${JSON.stringify({
                    id: "preview-sim",
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                })}\n\n`,
                "data: [DONE]\n\n",
            ].join("");
            return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch,
    });
    return simProviderCache;
}

/** responses 面预览桩：SDK 没有 transformRequestBody 钩子，所以在 fetch 里读 init.body。
 *  回一段最小合法 SSE（response.completed）把流干净收尾 —— 与 chat 面同样「零副作用」。 */
function getSimResponsesProvider(model: string): ReturnType<typeof createOpenAI> {
    if (simRespProviderCache) return simRespProviderCache;
    simRespProviderCache = createOpenAI({
        name: "preview-sim",
        baseURL: "http://127.0.0.1:1/unreachable",
        apiKey: "preview-no-key",
        fetch: (async (_input: unknown, init?: { body?: unknown }) => {
            try {
                simBodySink?.(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
            } catch (e) {
                console.warn("[local-agent] 预览 body 解析失败:", e);
            }
            const completed = {
                type: "response.completed",
                response: {
                    id: "preview-sim",
                    object: "response",
                    created_at: Math.floor(Date.now() / 1000),
                    status: "completed",
                    model,
                    output: [],
                    error: null,
                    incomplete_details: null,
                    instructions: null,
                    metadata: {},
                    parallel_tool_calls: true,
                    previous_response_id: null,
                    reasoning: null,
                    store: false,
                    temperature: 1,
                    tool_calls: [],
                    top_p: 1,
                    truncation: "disabled",
                    usage: null,
                    user: null,
                },
            };
            const sse = `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`;
            return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch,
    });
    return simRespProviderCache;
}

/** 预览包含的历史消息上限：**0 = 全量**（当前取值，让日常使用直接暴露真实数据量；
 *  想省内存/渲染时间就改成正数，例如 40 —— note 会自动标注「截尾」）。 */
const PREVIEW_HISTORY_MAX = 0;

/** 上次真发落盘的 messages（llm.jsonl 就是 blocksToMessages 的转储）；无日志/解析失败则空 */
function historyFromLog(taskUri: string, maxMessages: number): { messages: ModelMessage[]; total: number } {
    try {
        const fp = llmFile(taskUri);
        if (!existsSync(fp)) return { messages: [], total: 0 };
        const lines = readFileSync(fp, "utf-8").split("\n").filter((l) => l.trim() !== "");
        const tail = maxMessages > 0 ? lines.slice(-maxMessages) : lines;
        return { messages: tail.map((l) => JSON.parse(l) as ModelMessage), total: lines.length };
    } catch (e) {
        console.warn(`[local-agent] 预览历史读取失败 ${taskUri}:`, e);
        return { messages: [], total: 0 };
    }
}

export interface SimulatedRequest {
    /** 定稿 HTTP body（request.json 同形）；无任务场景时为 null */
    body: Record<string, unknown> | null;
    note: string;
}

/**
 * 仿真预览请求：用与 runTurn 完全相同的参数调 streamText，
 * 经 transformRequestBody 捕获定稿 body 后由 fetch 桩吞掉发送（一字节不出网）。
 * 保真关键：system/tools/limits/headers/messages 都走真实数据，只在最后一毫米掐断。
 * - messages：缺省从任务的真实 LLM 日志（上次真发的那份）取历史，末尾补一条占位 user —— 这才是「下一轮会发出的请求」。
 * - 无副作用：不写审计/日志，工具 execute 永不触发；桩返回**合法 SSE**，连 SDK 的 console.error 都不产生。
 */
export async function previewSimulatedRequest(opts: {
    taskUri: string;
    /** 已渲染的 system 全文（调用方经 prompt-registry 模板链得到） */
    system: string;
    /** 模型 id；缺省 DEFAULT_MODEL。试验场传当前会话选中的模型才算「真发的」 */
    model?: string;
    /** 历史消息；缺省 = 读任务 LLM 日志（无日志则仅占位，即首轮形态） */
    messages?: ModelMessage[];
}): Promise<SimulatedRequest> {
    if (!opts.taskUri) {
        return { body: null, note: "无任务场景：仅渲染 system 文本" };
    }
    const taskUri = opts.taskUri;
    const model = opts.model || DEFAULT_MODEL;
    const cwd = resolveCwdWithNote(diyHome(), taskUri).cwd;
    const L = getLocalAgent().getLimits();
    const modelMax = modelOutputTokens(model);
    // 历史：优先用调用方传的，否则读上次真发落盘的 llm 日志（上限见 PREVIEW_HISTORY_MAX）
    const hist = opts.messages?.length
        ? { messages: opts.messages, total: opts.messages.length }
        : historyFromLog(taskUri, PREVIEW_HISTORY_MAX);
    const messages: ModelMessage[] = [
        ...hist.messages,
        { role: "user", content: "[仿真占位]真实下一轮此处为用户输入" },
    ];
    let body: Record<string, unknown> | null = null;
    simBodySink = (b) => {
        body = b;
    };
    // 按 API 面取预览模型：与真发同一条链（chat 面 transformRequestBody / responses 面 fetch 桩）
    const simModel =
        apiOf(model) === "responses"
            ? getSimResponsesProvider(model).responses(model)
            : getSimProvider(model).chatModel(model);
    // 桩响应合法时不会走 catch；以下 catch 只为兼容 SDK 行为变化（body 已到手就算成功）
    try {
        const result = streamText({
            model: simModel,
            system: opts.system,
            messages,
            tools: buildTools(cwd, L, taskUri),
            stopWhen: stepCountIs(L.maxSteps),
            headers: { "x-opencode-session": sessionIdOf(taskUri) },
            maxOutputTokens: modelMax,
            maxRetries: 0,
        });
        for await (const part of result.fullStream) void part;
    } catch {
        /* 预期内：SDK 行为变化时仍可能抛，body 已到手就继续 */
    } finally {
        simBodySink = null;
    }
    if (!body) {
        return { body: null, note: "仿真未触达组装（SDK 行为变更？）" };
    }
    const histNote =
        hist.messages.length === 0
            ? "无历史：首轮形态"
            : hist.total > hist.messages.length
              ? `含历史 ${hist.messages.length}/${hist.total} 条（截尾；取自上次真发日志）`
              : `含历史 ${hist.total} 条（全量，取自上次真发日志）`;
    return {
        body,
        note: `dry-run：与真发同一条组装链（${apiOf(model)} 面），${histNote}；fetch 桩拦截未发送`,
    };
}
