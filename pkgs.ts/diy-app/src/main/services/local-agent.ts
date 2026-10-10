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
import { diyHome, projectDir, projectFromUri } from "../core/state";
import { resolveCwd as resolveCwdWithNote } from "../core/cwd";
import { BlockStore, blocksToMessages, interruptedToolPatches, type Op, type JSONVal } from "./local-blocks";
import { appendAudit } from "./agent-audit";
import { noteTurnEnd, noteTurnStart } from "./runtime-context";
import { addStepUsage, newUsageAcc, setTurnUsage, type TurnUsage } from "./turn-usage";
import {
    bucketsOf,
    costBreakdown,
    snapshotUsage,
    sumBuckets,
    sumCosts,
    turnUsagePatch,
    type CostBreakdown,
    type StepUsageRecord,
    type UsageBuckets,
    type UsageLike,
} from "../../shared/usage";
import { buildDelivery } from "../../shared/context/delivery";
import { loadSystemPlaces } from "../core/context-config";
import { appendContextStat } from "../core/context-stats";
import { statFromStep } from "../../shared/context/stats";
import type { DeliveryStepRecord } from "../../shared/context/steps";
import { assembleGlobals, systemOverBudget } from "./prompt-registry";
import { readFileWindow, formatReadOutput, ReadWindowError, READ_MAX_BYTES, READ_MAX_LINES } from "../core/file-read";
import { SteerQueue } from "../core/steer-queue";
import type { SteerItem, SteerMode } from "../core/drafts";

import {
    apiOf,
    contextLimitOf,
    costOf,
    DEFAULT_MODEL,
    MODEL_COST_AS_OF,
    isKnownModel,
    LOCAL_MODELS,
    maxOutputTokensOf,
    reasoningOf,
    ZEN_BASE_URL,
    type LocalModel,
    type LocalModelApi,
    type LocalModelReasoning,
    type ReasoningEffort,
} from "../../shared/models";
import { personaForTask } from "../core/persona";

// 模型清单（LOCAL_MODELS / apiOf / reasoningOf / contextLimitOf …）已抽到 shared/models.ts：
//   core/persona 要「默认模型 + 能力查询」，而 core 不能被 services 反向依赖（会循环 import）。
// 这里**原样 re-export**：历史引用路径（tests/…/local-models-*.test.ts）保持不变。
export {
    apiOf,
    contextLimitOf,
    DEFAULT_MODEL,
    isKnownModel,
    LOCAL_MODELS,
    maxOutputTokensOf,
    reasoningOf,
    ZEN_BASE_URL,
};
export type { LocalModel, LocalModelApi, LocalModelReasoning, ReasoningEffort };

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
    return process.env["DIY_ZEN_BASE_URL"] || ZEN_BASE_URL;
}

/** 按 model id 查 maxOutputTokens，fallback 到全局 limits */
function modelOutputTokens(modelId: string): number {
    return maxOutputTokensOf(modelId) ?? DEFAULT_LIMITS.maxOutputTokens;
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

/**
 * 一条开场消息（runTurn 可能收到一批）。kind 决定它是否带 steer 标记：
 *   "user"     —— 用户在对话里正常发的消息
 *   SteerMode  —— 插话（steer）投递进来的话：投递时机只影响**标记与投递点**，
 *                 块本身都是 user 发言；steerId 指回队列项（`steer/N`）供回查。
 */
interface TurnInput {
    text: string;
    kind: "user" | SteerMode;
    steerId?: string;
}

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

/**
 * 会话 Op 流文件路径。
 * 导出供测试构造「历史对话已存在」的落盘状态：测试与产品共用同一路径实现
 * （key = 可读前缀 + uri 哈希），不复制 key 算法到测试里。
 */
export function opsFile(taskUri: string): string {
    return path.join(localDir(), `${keyOf(taskUri)}.ops.jsonl`);
}
function llmFile(taskUri: string): string {
    return path.join(localDir(), `${keyOf(taskUri)}.llm.jsonl`);
}

/** 投递快照（每轮真发一条）：投递**事实**，与 raw 那种旁路观测不同 —— UI 的 step/diff 靠它 */
function stepsFile(taskUri: string): string {
    return path.join(localDir(), `${keyOf(taskUri)}.steps.jsonl`);
}

/**
 * 逐步用量账本（每步一行；见 ##211 §六）。
 * **独立文件**：不塞进 steps.jsonl —— 那份是「投递事实」（UI 的 step/diff 靠它），
 * 掺进观测数据会让「投递了什么」与「花了多少」两件事互相污染（一个写失败拖累另一个）。
 */
function usageFile(taskUri: string): string {
    return path.join(localDir(), `${keyOf(taskUri)}.usage.jsonl`);
}

/** 读取某任务的逐步用量（时间正序；文件不存在 = 还没实现落盘之前的会话） */
export function readStepUsages(taskUri: string): StepUsageRecord[] {
    return readJsonl<StepUsageRecord>(usageFile(taskUri));
}

/** 追加一条用量记录（append-only；写失败只出声 —— 观测不能阻断会话） */
function appendUsage(taskUri: string, rec: StepUsageRecord): void {
    const fp = usageFile(taskUri);
    try {
        appendFileSync(fp, `${JSON.stringify(rec)}\n`, "utf-8");
    } catch (e) {
        console.error(`[local-agent] 用量记录写入失败 ${fp}:`, e);
    }
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

/**
 * runtime 容器作为**尾部 user 消息**插在本轮输入之前（144 的投递设计）。
 * 易变项（任务正文、技能清单等）放这里，稳定项在 system 参数里；两者合起来才是完整上下文。
 * runtime 为空 → 原样返回（不硬塞空消息：白耗 token 且让模型困惑）。
 */
function withRuntime(hist: ModelMessage[], runtime: string): ModelMessage[] {
    if (!runtime.trim()) return hist;
    const last = hist[hist.length - 1];
    if (last && last.role === "user") {
        return [...hist.slice(0, -1), { role: "user", content: runtime }, last];
    }
    return [...hist, { role: "user", content: runtime }];
}

/** 读某任务的投递快照（时间正序；文件不存在 = 还没真发过） */
export function readDeliverySteps(taskUri: string): DeliveryStepRecord[] {
    // 读侧兜底（review RV-12）：`systemPlaces` 首版即写，正常不会缺；但 renderer 已当它必填
    // （`sysCauses(changed, undefined)` 会 `for..of undefined` 打断渲染），坏行/手写快照给个 [] 更稳。
    return readJsonl<DeliveryStepRecord>(stepsFile(taskUri)).map((r) => ({
        ...r,
        systemPlaces: r.systemPlaces ?? [],
        runtimePlaces: r.runtimePlaces ?? [],
    }));
}

/** 追加一条投递快照（append-only；写失败只出声 —— 观测不能阻断发送） */
function appendStep(fp: string, rec: DeliveryStepRecord): void {
    try {
        appendFileSync(fp, `${JSON.stringify(rec)}\n`, "utf-8");
    } catch (e) {
        console.error(`[local-agent] 投递快照写入失败 ${fp}:`, e);
    }
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
                // 自杀护栏（agent-guard.ts）已停用（2026-10-02）：
                // 判据是命令文本，无法区分「宿主进程」与「agent 自己起的实例」——
                // 实测两类误拦（同 pgid、命令行含 out/main/index.mjs）把本仓库任意
                // worktree/测试实例都算宿主家人，连 agent 收自己起的实例都被拒。
                // 恢复方式：还原本处调用 + import（模块与单测均保留，见 agent-guard.ts）。
                // 现仅保留 write-ahead 审计：先落盘再执行，保证最后一幕不丢
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

    /** 入队一条插话（只入队，不唤醒轮次；正在跑的轮次按投递时机取走，没有则留待下一轮）。 */
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

    /** 切换一条插话的投递时机（next-step ⇄ next-turn；差别只在投递点，两者都整批投）。 */
    steerToggleMode(taskUri: string, id: string): SteerItem[] {
        return this.queue.toggleMode(taskUri, id);
    }

    /** 重排待投递插话的顺序（横条上的拖拽排序；顺序即投递顺序） */
    steerReorder(taskUri: string, ids: string[]): SteerItem[] {
        return this.queue.reorder(taskUri, ids);
    }

    /**
     * 清空会话：中断在途生成 + 清插话队列 + 删 ops/llm/raw 日志。
     *
     * 顺序原则：**先把所有可失败的事做完，最后才丢内存态**。
     * 反过来（先 sessions.delete 再删文件）一旦中途失败，内存里会话没了、盘上文件还在，
     * 调用方拿到 false 而界面保留旧内容 —— 一次 reload 历史又全长回来，内存与盘上长期分叉。
     * 现在：失败也照样丢内存态（下次进入从盘上重建，两边一致），返回值只表示「盘上是否清干净」。
     */
    clear(taskUri: string): boolean {
        this.cancel(taskUri);
        let ok = true;
        // 会话都要删了，排队中的插话无处可投 —— 一并清掉（否则横条会一直挂着"待发送"）
        try {
            this.queue.clear(taskUri);
        } catch (e) {
            console.error(`[local-agent] 清空插话队列失败 ${taskUri}:`, e);
            ok = false;
        }
        for (const f of [opsFile(taskUri), llmFile(taskUri), rawFile(taskUri), stepsFile(taskUri)]) {
            try {
                rmSync(f, { force: true });
            } catch (e) {
                // force:true 已吸收 ENOENT；能到这里的都是真故障（权限/只读盘），不能冒充成功
                console.error(`[local-agent] 删除日志失败 ${f}:`, e);
                ok = false;
            }
        }
        // 内存态无论如何都丢：留着它才是真的不一致（盘上文件仍在 → 重进会重新加载）
        this.sessions.delete(taskUri);
        return ok;
    }

    /**
     * 一轮对话：实时产出块协议 Op；op 即传即落盘（存储=传输）。同 task 并发拒绝。
     *
     * 「插嘴」在同一个流里投递：首轮用调用方的 message，本轮（及后续自动轮）由插话队列喂
     * （见 MAX_STEER_ROUNDS）。对消费端（renderer 的 for await）而言始终只是一个流，
     * 中途换没换轮次不需要它知道。
     *
     * 模型与参数来自**任务绑定的人物**（personas.yaml），入参只是本次临时覆盖
     * （CLI 调试用，UI 不传）——这是「配置真源唯一」的落点：旧实现由 renderer
     * 传一个全局 activeModel，导致改一个会话所有会话跟着变、重启又回落硬编码默认值。
     *
     * 解析时机 = 每轮开始时。改人物因此天然是"下一轮生效"：在跑的轮次不受影响（不打断），
     * 也不必给用户一堆"立即/下步/下轮"的时机选项（step 中途换模型在语义上就不成立）。
     */
    async *chat(taskUri: string, message: string, modelOverride?: string, reasoningEffortOverride?: ReasoningEffort): AsyncGenerator<Op> {
        const key = process.env.OPENCODE_ZEN_API_KEY;
        if (!key) throw new Error("缺少 OPENCODE_ZEN_API_KEY（main 进程环境变量）");
        const persona = personaForTask(diyHome(), taskUri);
        const model = modelOverride ?? persona.model;
        // 手写 personas.yaml 可能把档位留空：兜底到该模型自己的默认档，不把空档发给上游
        const reasoningEffort = reasoningEffortOverride ?? (persona.reasoningEffort || reasoningOf(model).default);
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
            // 轮末队列非空则自动开下一轮（用户不必再敲回车），且**一次把队列发完**：
            // 排队多条的心愿是"一起告诉它"，拆成多轮只会多几次请求、多个轮次边界。
            let pending: TurnInput[] = [{ text: message, kind: "user" }];
            for (let round = 0; pending.length > 0 && !ctrl.signal.aborted; round++) {
                // 手动驱动内层生成器（而不是 `yield*` 委托）：委托会把 op 直接交给消费端，
                // 跳过这里的 `sess.store.apply` —— 而 store 是本模块的**单一权威**
                // （wire = store = UI = LLM），漏一次 apply 会让下一轮重建 messages 时看不到
                // 上一轮的产出（实测症状：`InvalidPromptError: messages must not be empty`）。
                // 手动驱动同时还能拿到内层的返回值（failed），for-await 会把它丢掉。
                // 逐步用量记录的身份字段：这几项 chat() 时已知，但不进任何日志就答不出
                // 「哪种配置更省」（##211 §六.2）—— 尤其同一会话换模型/换面时。
                const inner = this.runTurn(taskUri, sess, pending, model, reasoningEffort, ctrl.signal, key, sink, {
                    persona: persona.id,
                    apiFace: apiOf(model),
                    contextLimit: contextLimitOf(model),
                });
                let failed = false;
                // 本轮 turn 块 id：上限提示要挂进**这一轮**（见下方上限分支），故从内层带回
                let turnId = "";
                try {
                    for (;;) {
                        const r = await inner.next();
                        if (r.done) {
                            failed = r.value.failed;
                            turnId = r.value.turnId;
                            break;
                        }
                        sess.store.apply(r.value);
                        yield r.value;
                    }
                } finally {
                    // 消费端提前断开（切页/停止）：把内层也关掉，别让它的收尾悬在半路
                    await inner.return({ failed: false, turnId: "" });
                }
                if (failed || ctrl.signal.aborted) break;
                // 上限保护：插话会不断延长对话（本轮里用户又可能继续插话），没有上限时
                // "用户不停插嘴 → 无限自我续命"（CLI 一条命令永不返回）。
                // 上限分支只读队列、**什么都不取** —— 剩余插话留在盘上（UI 横条照旧显示待发送、
                // 可取消），并写显式 error 块，不静默吞。
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
                    // ⚠️ 提示块必须挂进**本轮 turn**（parent = turnId），不能做根块：
                    //   · turn 块此刻已 stop、openStack 已空 → 无 parent 时它 fold 成**根块**，
                    //     而 UI 的根渲染分支只认 turn（LocalChatPage 的 trees 循环），
                    //     显示成「[未知根 error]」—— 设计承诺的"显式提示、不静默吞"当场落空。
                    //   · id 必须**每次都不同**：turnId 天然唯一（`t` + 时间戳）。若沿用
                    //     `queued[0].id + "-limit"`，同任务二次撞上限且队列首条未变时 id 撞车 →
                    //     BlockStore 报「重复 start」丢弃 start，随后的 delta 却累加到**旧块**，
                    //     文案变成两条拼接（见 local-blocks 的 Text 累加）。
                    const id = `${turnId || "steer"}-limit`;
                    const msg = `连续插话已达 ${MAX_STEER_ROUNDS} 轮上限，剩余 ${queued.length} 条插话未投递（仍在队列里，可取消或再发一条消息触发）`;
                    const ops: Op[] = [
                        { op: "start", id, kind: "error", parent: turnId || undefined, meta: { source: "steer" } },
                        { op: "delta", id, fields: { message: msg } },
                        { op: "stop", id },
                    ];
                    // 与 chat() 其余两处 yield 点同一节奏：sink（落盘）→ store.apply（内存权威）→
                    // yield。少了 apply 会让内存 store 与 wire/盘上分叉 —— store 是本模块的单一权威
                    // （见上方"手动驱动内层生成器"的注释）。
                    for (const op of ops) {
                        sink(op);
                        sess.store.apply(op);
                        yield op;
                    }
                    break;
                }
                // 轮末**整批取走**：队列里剩下的全部（两种模式都算）作为下一轮的开场一次性发出。
                // 为什么不再"每轮一条"：用户排队 3 条的心愿是"这三句一起告诉它"，
                // 拆成 3 轮等于让模型对同一件事回 3 次，还平白多 2 次请求 + 2 个轮次边界；
                // 顺序仍取队列序（FIFO = 投递顺序，用户拖过序就按拖过的来）。
                // ⚠️ 这里**只读不取**：真正的出队发生在 runTurn 开场块 sink 之后（先记账再出队）——
                // 在这中间崩掉，最坏是下次重复投一遍，不会丢；反过来就是用户的话凭空消失。
                try {
                    pending = this.queue.list(taskUri).map((it) => ({ text: it.text, kind: it.mode, steerId: it.id }));
                } catch (e) {
                    console.error(`[local-agent] 插话队列读取失败，停止自动续轮 ${taskUri}:`, e);
                    break;
                }
                if (pending.length === 0) break;
            }
            done = true;
            // llm dump 移到 finally（见那里：链式 return 会截断 try 尾，finally 才是每条退出路径的保证）
        } finally {
            // 消费端提前断开（切 tab/刷新/杀 CLI）：停掉上游，不让 LLM/工具在无人处继续烧 token
            // （AbortController.abort() 按规范不抛错，此处无需 try/catch）
            if (!done) ctrl.abort();
            sess.running = null;
            // 轮末 dump：从块树重建 LLM 历史（含本轮 user/tool 链路），整体覆盖 llm 日志。
            // ⚠️ 必须在 finally、不能只放在 try 尾 —— 消费端取消（renderer 点停止 → end 帧 →
            // channel-server-binding 的 if(cancelled) return → 链式 gen.return()）会把 try 的
            // 后半段**整段截断**（任务 201 R1-S1：旧实现因此在主动停止后既缺 turn 的 stop、
            // 也缺这份 dump）。finally 无 yield，不会被吞没，每条退出路径都能留下最后一轮。
            // 空树跳过：装配期就抛错时块树未动，别拿空内容覆盖上一轮的可用 dump。
            if (sess.store.roots().length > 0) {
                try {
                    sess.messages = blocksToMessages(sess.store) as unknown as ModelMessage[];
                    // dump 整文件覆盖 → tmp+rename 原子化：读取方永不见半文件（权威仍是 ops append-only）
                    const dump = llmFile(taskUri);
                    writeFileSync(`${dump}.tmp`, sess.messages.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");
                    renameSync(`${dump}.tmp`, dump);
                } catch (e) {
                    console.error(`[local-agent] llm dump 失败 ${llmFile(taskUri)}:`, e);
                }
            }
            // ⚠️ 兜底注销活跃轮次 —— **不能只依赖 runTurn 的 closeTurn**：
            //   runTurn 里 try{streamText} 之前的那些步骤（装配系统上下文、读模版、算 cwd）
            //   都不在 try 覆盖内，任何一步抛错就等于跳过 closeTurn → activeTurns 留下僵尸条目。
            //   以前这只影响"崩溃现场"的可读性（UI 看的是本地 running，异常时它会被复位）；
            //   但现在 UI 把 agent.local.running 当**运行态真值**（session 194），僵尸会表现为
            //   「永远显示生成中 + 停止按钮点了没反应」，用户只能重启。
            //   noteTurnEnd 是 Map.delete，幂等：closeTurn 已注销过时，这里再删一次无害。
            noteTurnEnd(taskUri);
        }
    }

    /**
     * 生成器本体：ai-sdk fullStream → Op。唯一认识 ai-sdk 事件名的地方。
     *
     * 一次 streamText 调用（内含若干模型步）：step 插话唯一的投递点是 prepareStep（下一步之前）。
     * 模型不再请求工具 = 本轮结束：此时队列里剩下的插话由 chat() 作为**下一轮的开场白**投递，
     * 不往本轮尾巴上续（理由见 prepareStep 处的注释）。
     */
    private async *runTurn(
        taskUri: string,
        sess: LocalSession,
        input: TurnInput[],
        model: string,
        reasoningEffort: ReasoningEffort,
        signal: AbortSignal,
        key: string,
        sink: (op: Op) => void,
        /** 落盘身份（人物/面/窗口）：同一会话可换模型，故它是**行**的属性（##211 §六b.6） */
        identity: { persona: string; apiFace: LocalModelApi; contextLimit?: number },
    ): AsyncGenerator<Op, { failed: boolean; turnId: string }, void> {
        const turnId = `t${Date.now()}`;
        const cwd0 = resolveCwdWithNote(diyHome(), taskUri).cwd;
        noteTurnStart({ taskUri, model: model, cwd: cwd0 });
        appendAudit(diyHome(), {
            phase: "turn-start",
            taskUri,
            model: model,
            cwd: cwd0,
            command: input.map((i) => i.text).join("\n").slice(0, 300),
        });
        // ── 定义顺序：先声明「收尾/报错/投递」这几件**可能被早退路径调用**的东西，再做事 ──
        // runTurn 有两条提前 return 的路径（超预算不发、后续可能新增的其它前置拒绝），
        // 它们同样要写 error 块、走 closeTurn 闭合轮次。若把这些定义留在开场块之后，
        // 早退点就落在 const 的 TDZ 里 —— 直接 ReferenceError，且是在"拒绝发送"这条
        // 本该最安全的路径上崩。故：定义一律前置，动作（emit/投递）排在后面。
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
        // turn 级 usage 账本（口径与来源全在 services/turn-usage.ts，那里也解释了
        // 为什么 cached 必须单独记：它是"缓存有没有真的生效"的唯一硬指标，##140 的验收标准）
        const acc = newUsageAcc();
        // 本轮四桶累计（页脚「总输入(非缓存+读+写) / 总输出(文本+思考)」）+ 最后一步快照
        // （窗口占用 = **最后一步** 的总输入+总输出，不是累加 —— 口径三分见 ##211 §三）
        // 与累计金额（每步按各自生效单价算好再加，tier 每一步都可能不同）。
        let turnBuckets: UsageBuckets = { noCache: 0, cacheRead: 0, cacheWrite: null, text: 0, reasoning: 0, outputTotal: 0, inputTotal: 0, total: 0 };
        let lastStepBuckets: UsageBuckets | null = null;
        let turnCost: CostBreakdown = { noCache: 0, cacheRead: 0, cacheWrite: null, text: 0, reasoning: 0, total: 0 };
        // 收尾原因追踪：步数耗尽检测（最后动作是 tool 且 step 用满 = 模型还想干活被掐）
        let lastAct: "none" | "text" | "tool" = "none";

        // ── 插话投递 ─────────────────────────────────────────────
        // prepareStep 是同步回调（不是生成器），只能先把 op 排队、由流循环 flush 出去
        let pendingSteerOps: Op[] = [];
        /** 已被 prepareStep 认领、但还没在流里落位的 next-step 插话（认领≠投递，见 claimStepSteers 头注） */
        let claimed: SteerItem[] = [];
        /** 插话的 user 块（三个 op）；parent 一律 = turn —— 该块在文档序上就是"某步之后、下一步之前" */
        const steerBlockOps = (item: SteerItem): Op[] => {
            // 块 id 沿用 turn 内局部序号风格（`<turnId>_suN`），另在 meta 里记 steerId 指回
            // 队列项（`steer/N`）：排障时能对上"日志里这条块是哪次插话投的"
            const id = `${turnId}_su${++uN}`;
            return [
                {
                    op: "start",
                    id,
                    kind: "text",
                    parent: turnId,
                    meta: { role: "user", steer: item.mode, steerId: item.id },
                },
                { op: "delta", id, fields: { content: item.text } },
                { op: "stop", id },
            ];
        };
        /**
         * 「认领」**全部** next-step 插话：只读队列，**不出队、不落盘**，供注入 messages。
         * 一次全取（对齐 dsh 的 claim()：next-step 多条合并成同一批），不是一次一条。
         *
         * 为什么认领与落位要分两步 —— 两条流不在同一个时间轴上：
         *   · 认领发生在 SDK 内部的 `prepareStep`（同步回调），此刻消费端**可能还压着上一步的 part**
         *     （producer 已跑到第 N+1 步，consumer 还在处理第 N 步的尾部）；
         *   · 若在这里就 sink + 出队，插话块的**落盘顺序与 yield 顺序都会插到上一步未完的内容之前**
         *     —— 实测真实日志里出现过：`su1`(插话块) 排在 `stop s1`（上一步的 finish-step）之前。
         * 所以这里只认领；真正落位在流里出现 `start-step` 时（见 landClaimedSteers），
         * 那才是"上一步全部 part 都已处理完、下一步尚未开始"的唯一无歧义位置。
         *
         * 已认领则**复用同一批**：prepareStep 因重试被再次调用时，注入的应是同一批话。
         */
        const claimStepSteers = (): SteerItem[] => {
            if (claimed.length > 0) return claimed;
            try {
                claimed = this.queue.peekMode(taskUri, "next-step");
            } catch (e) {
                console.error(`[local-agent] 插话队列读取失败 ${taskUri}：`, e);
                return [];
            }
            return claimed;
        };

        /**
         * 「落位」已认领的整批插话：逐条同步落盘（写进 ops）+ 出队，并把 op 排进待 yield 队列。
         *
         * 顺序不可换：**先 sink 再出队**。sink 是"这条插话进对话流"的权威，出队是"它不再是待办"。
         * 反过来（先出队）一旦在两者之间崩溃，队列里没有、ops 里也没有 → 用户的话真丢。
         * 现在这个顺序最坏是"重复投一遍"（可恢复）。两步都是同步文件操作、中间无 await，等价原子。
         */
        const landClaimedSteers = (): void => {
            if (claimed.length === 0) return;
            const items = claimed;
            claimed = [];
            for (const item of items) {
                for (const op of steerBlockOps(item)) {
                    sink(op);
                    pendingSteerOps.push(op);
                }
                try {
                    this.queue.remove(taskUri, item.id);
                } catch (e) {
                    // 出队失败：ops 已有这条块（不会丢），但队列里还留着（可能被再投一遍）。
                    // 不能静默 —— 重复投递是用户可见的行为差异。
                    console.error(`[local-agent] 插话出队失败（已落盘，可能重复投递）${taskUri}#${item.id}:`, e);
                }
            }
        };
        /** 把排队中的插话 op 交给消费端（必须在下一步开始前调用：块的落点决定消息顺序） */
        const flushSteer = function* (): Generator<Op, void, void> {
            if (pendingSteerOps.length === 0) return;
            const ops = pendingSteerOps;
            pendingSteerOps = [];
            for (const op of ops) yield op;
        };

        /**
         * 收尾必闭合（幂等）：step 先于 turn，摘掉活跃轮次并落 turn-end 审计。
         * 抽成生成器是为了让「超预算早退」也走同一套收尾 —— 历史 bug：早退的 return 在 try 之前，
         * 绕过 finally → activeTurns 留僵尸轮次、落盘 ops 缺 turn 的 stop、审计缺 turn-end。
         *
         * ⚠️ 副作用必须**同步做完，且在任何 yield 之前**。原因：消费端断开（切页/刷新/关窗/
         * CLI 被杀）时生成器以 return 展开，finally 里只执行到**第一个 yield** 就把控制权交回调用方
         * —— 若把「落盘 stop / noteTurnEnd / 审计」写在 `yield* emit(...)` 之后，它们全都不会执行
         * （实测：`{stop 落盘后 yield}` 的写法在 return 展开下只会执行到 yield，审计一行不跑）。
         * 所以顺序固定为：① sink（同步落盘）② noteTurnEnd / 审计（同步）③ 尽力 yield 给还活着的消费端。
         */
        const closeTurn = function* (currentStepId: string, steps: number): Generator<Op, void, void> {
            const ops: Op[] = [];
            if (currentStepId !== turnId) ops.push({ op: "stop", id: currentStepId });
            ops.push({ op: "stop", id: turnId });
            // ① 同步副作用（无 await、无 yield）：无论走正常收尾还是 return 展开，这一段必定执行完
            for (const op of ops) {
                sink(op);
                // 块树同步收敛（stop 幂等）：消费端断开时 chat() 的转发循环不会再 apply，
                // 盘与内存权威（store）必须一致 —— 下一轮 blocksToMessages / 下降沿 reload 都读它
                sess.store.apply(op);
            }
            noteTurnEnd(taskUri);
            appendAudit(diyHome(), {
                phase: "turn-end",
                taskUri,
                model: model,
                result: `steps=${steps} usage=${acc.in}/${acc.out} cached=${acc.cached}`,
            });
            // ② 尽力投递：消费端还在就让它看到 stop；已断开则在此停住 —— 状态早已一致（①已完成）
            for (const op of ops) yield op;
        };

        yield* emit({ op: "start", id: turnId, kind: "turn", meta: { model: model } });

        // ── 系统上下文：**先算预算再记账** ──
        // 超预算时这一轮根本不发请求，所以此刻**还不能**写开场 user 块、也不能投递插话：
        //   · 写了开场块 → ops 里留下模型从没见过的 user 消息，而 blocksToMessages 会把它
        //     当成真实历史发给后续每一轮（模型看见一句它从未回应的话，"幽灵消息"）；
        //   · 投递了插话（出队）→ 那句话既没进对话流（下一轮 issue 未修正前）也没留在队列，
        //     用户白打（review P1 实测）。
        // 顺序固定为：装配 → 判预算 → 记账（开场块 + 出队）→ 请求。
        // 系统上下文：Context Tree 投递（稳定项 → system 参数；易变项 → 尾部 user 消息）。
        // **与上下文树页的预览同一条链**（shared/context/delivery）：同一份 globals、同一份
        // system 名单、同一套渲染 —— 于是"预览看到的字节"就是这里发出去的字节。
        const globals = assembleGlobals(diyHome(), projectFromUri(taskUri), { taskUri }) as unknown as Record<
            string,
            unknown
        >;
        // 划分规则读**真源**（$DIY_HOME/context.yaml；缺失/损坏则推荐名单 + 出声）——
        // 与上下文树页读的是同一份，所以页面上看到的 system/runtime 划分就是这里会用的划分。
        const delivery = buildDelivery(globals, loadSystemPlaces(diyHome()));
        // 预算判据与模版线**共用同一个函数**（services/prompt-registry 的 systemOverBudget）：
        // 曾经这里是内联的 `bytes > budget`，逻辑等价但两处各写一遍 —— 日后任何一侧改口径
        // （比如"等于预算算不算超"）都会悄悄分叉，而单测只覆盖得到被调用的那一侧（209 第 3 轮 R-1）。
        const over = systemOverBudget(delivery.system.bytes, contextLimitOf(model));
        if (over) {
            const kb = (n: number) => (n / 1024).toFixed(1);
            yield* errorBlock(
                "budget",
                `系统上下文超出预算（${kb(over.used)} KB > ${kb(over.budget)} KB），本轮未发送。` +
                    `请精简项目 AGENTS.md，或在上下文树页把易变变量划到 runtime。`,
            );
            // 拒绝发送也是一轮完整生命周期：必须闭合，否则 UI/崩溃报告/审计三处都会认为它还在跑。
            // 这条 return 在 try 之前，不经过下面的 finally —— 收尾在这里显式做，且**只做一次**
            // （closeTurn 的 sink 不幂等：重复调用会往 ops 里多写一条 stop，虽然无害但脏）。
            yield* closeTurn(stepId, stepN);
            return { failed: false, turnId };
        }

        // 开场 user 块：轮首批量可能多条（轮末队列里的全部，见 chat() 轮末）。
        // 插话带 steer 标记 —— UI 据此把这条标成"插嘴进来的"，
        // 也是重放/续聊时唯一能区分"用户主动说"与"插嘴补一句"的线索。
        for (const [i, item] of input.entries()) {
            const uid = i === 0 ? `${turnId}_u` : `${turnId}_u${i + 1}`;
            yield* emit({
                op: "start",
                id: uid,
                kind: "text",
                parent: turnId,
                meta: {
                    role: "user",
                    ...(item.kind === "user" ? {} : { steer: item.kind, ...(item.steerId ? { steerId: item.steerId } : {}) }),
                },
            });
            yield* emit({ op: "delta", id: uid, fields: { content: item.text } });
            yield* emit({ op: "stop", id: uid });
            // 落位即出队（**先 sink 再出队**，与 next-step 的 landClaimedSteers 同一条铁律）：
            // sink 是"这句话进对话流"的权威，出队是"它不再是待办"。反过来一旦崩在中间，
            // 队列里没有、ops 里也没有 —— 用户白打。现在最坏是重复投一遍（可恢复）。
            if (item.steerId) {
                try {
                    this.queue.remove(taskUri, item.steerId);
                } catch (e) {
                    console.error(`[local-agent] 插话出队失败（已落盘，可能重复投递）${taskUri}#${item.steerId}:`, e);
                }
            }
        }

        const cwd = cwd0;
        const L = this.getLimits();
        const modelMax = modelOutputTokens(model);
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
        try {
            // 从块树重建 messages：本轮的 user 块 + 中途落下的插话块都在里面，
            // 「wire = store = UI = LLM」这条链对每一步都成立（prepareStep 注入的就是它）。
            // runtime 容器作为**尾部 user 消息**插在本轮输入之前：它不进块树（llm.jsonl 是块树的转储），
            // 所以下一轮重建历史时不会带上它 —— 每轮只发当前这一份，不会累积。
            // 真发 tools 只构建一次（raw dump / 构成字节 / streamText 共用）；
            // 构成字节 = 环形构成卡与构成报表的数据源（system 容器精确字节 + tools JSON 字节，
            // 消息段由账本每步 prompt 减法导出 —— 见 shared/usage StepUsageRecord.contextParts）。
            const tools = buildTools(cwd, L, taskUri);
            const ctxParts = {
                systemBytes: delivery.system.bytes,
                toolsBytes: JSON.stringify(tools).length,
            };
            const sent: ModelMessage[] = withRuntime(blocksToMessages(sess.store) as unknown as ModelMessage[], delivery.runtime.text);
            rawSink({
                kind: "request",
                ts: new Date().toISOString(),
                model: model,
                system: delivery.system.text,
                tools: Object.keys(tools),
                settings: { maxSteps: L.maxSteps, maxOutputTokens: modelMax, maxRetries: 2, reasoningEffort: reasoningEffort ?? "none" },
                messages: sent,
            });
            // 投递快照（每轮真发一条）：投递事实，供 UI 的 step/diff 用（与 raw 那种旁路观测不同）。
            // 落盘失败不阻断发送（它只是观测），但必须出声。
            const prevStep = readDeliverySteps(taskUri).at(-1) ?? null; // 本任务的上一轮（用于算变化）
            const step: DeliveryStepRecord = {
                ts: new Date().toISOString(),
                turnId,
                model,
                wireVersion: delivery.wireVersion,
                systemPlaces: delivery.system.places,
                runtimePlaces: delivery.runtime.places,
                valueHashes: delivery.valueHashes,
                systemText: delivery.system.text,
                runtimeText: delivery.runtime.text,
            };
            appendStep(stepsFile(taskUri), step);
            // 变更统计（**按项目**累计；只存变化路径 → 体积小、可长期留）。
            // 用途：跑几天后回答"这个节点到底变了几次" —— 划分位置的判据（见 task 178）。
            appendContextStat(projectDir(projectFromUri(taskUri)), statFromStep(step, prevStep?.valueHashes ?? null, taskUri));
            const result = streamText({
                model: this.modelFor(model, key),
                system: delivery.system.text,
                messages: sent,
                tools,
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
                // 每个模型步开始前的唯一钩子：把队列里的 next-step 插话插进这一步的 messages
                // （**整批**：dsh 的 claim() 就是一次全投，不是一次一条）。
                // 返回的 messages 会 carry forward 到后续步（SDK 语义），所以模型一开口就能看到。
                //
                // 只在第二步及之后注入（stepNumber > 0）：本轮的第一个请求不是"下一步"，它是这一轮
                // 本身（轮首批量已由 chat() 放进开场消息，见 runTurn 的开场块）。
                //
                // ⚠️ 不在这里、也不在任何地方"替模型续一步"（曾经有过段末续段 = dsh 的
                // turn-stopping 语义）：模型给出最终答复就说明它认为做完了，此时再往同一轮里
                // 塞一段，用户看到的是「总结 → 插话 → 又总结」的夹层；收益只是早一个**恰好会
                // 立刻发生**的轮次边界生效。让这一轮干净地结束、由 chat() 开下一轮（插话就是
                // 下一轮的开场白）语义更准，轮次结构/usage/停止边界也不用为夹层做特例。
                prepareStep: ({ messages, stepNumber }) => {
                    if (signal.aborted || stepNumber === 0) return {};
                    const items = claimStepSteers();
                    return items.length === 0
                        ? {}
                        : { messages: [...messages, ...items.map((it) => ({ role: "user" as const, content: it.text }))] };
                },
            });

            try {
                for await (const part of result.fullStream) {
                    rawSink({ kind: "part", seq: ++rawSeq, ts: new Date().toISOString(), part });
                    switch (part.type) {
                        case "start-step":
                            // 插话落位点：**唯一无歧义的位置** —— start-step 在流里保证排在上一步的
                            // 所有 part 之后，而"下一步"还没产出任何内容。认领发生在 prepareStep（可能
                            // 早于消费端处理完上一步的 part），落位必须等到这里，否则插话块会插到
                            // 上一步未完的内容前面（落盘顺序与 UI 顺序都会错）。
                            landClaimedSteers();
                            yield* flushSteer();
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
                            // 每步 usage：① 落一条独立账（usage.jsonl，逐步明细/金额的唯一来源）
                            // ② 累加进本轮桶（对话流页脚）
                            // zen 流尾 totalUsage 偶发缺失，逐步累加同时是双保险（见 finish 分支）。
                            const fsPart = part as unknown as {
                                usage?: UsageLike;
                                performance?: StepUsageRecord["performance"];
                                response?: { id?: string; modelId?: string };
                                finishReason?: string;
                            };
                            const su = fsPart.usage;
                            if (su) {
                                addStepUsage(acc, su as TurnUsage);
                                const b = bucketsOf(su);
                                turnBuckets = sumBuckets([turnBuckets, b]);
                                lastStepBuckets = b;
                                // **按 response.modelId 查价**：上游可能路由改写模型（##211 §四.4.4）
                                const priceModel = fsPart.response?.modelId ?? model;
                                const rates = costOf(priceModel, b.inputTotal);
                                const cost = rates ? costBreakdown(rates, b) : null;
                                turnCost = sumCosts([turnCost, cost ?? { noCache: 0, cacheRead: 0, cacheWrite: b.cacheWrite == null ? null : 0, text: 0, reasoning: 0, total: 0 }]);
                                appendUsage(taskUri, {
                                    ts: new Date().toISOString(),
                                    turnId,
                                    step: stepN,
                                    persona: identity.persona,
                                    model,
                                    apiFace: identity.apiFace,
                                    reasoningEffort,
                                    ...(identity.contextLimit ? { contextLimit: identity.contextLimit } : {}),
                                    ...(fsPart.response?.id ? { responseId: fsPart.response.id } : {}),
                                    ...(fsPart.response?.modelId ? { responseModel: fsPart.response.modelId } : {}),
                                    ...(fsPart.finishReason ? { finishReason: fsPart.finishReason } : {}),
                                    usage: snapshotUsage(su)!,
                                    ...(fsPart.performance ? { performance: fsPart.performance } : {}),
                                    rates: rates ? { ...rates, asOf: MODEL_COST_AS_OF } : null,
                                    cost,
                                    contextParts: ctxParts,
                                });
                                yield* emit({
                                    op: "patch",
                                    id: turnId,
                                    fields: { usage: turnUsagePatch(turnBuckets, lastStepBuckets, turnCost, identity.contextLimit, stepN, ctxParts) },
                                });
                            }
                            if (stepId !== turnId) yield* emit({ op: "stop", id: stepId });
                            break;
                        }
                        case "finish": {
                            const usage = (part as unknown as { totalUsage?: TurnUsage }).totalUsage;
                            // 截断/耗尽显式化：写进 turn.notice，UI 页脚展示（限制值来自动态配置）
                            const fr = (part as { finishReason?: string }).finishReason;
                            let notice: string | undefined;
                            if (fr === "length") {
                                notice = `输出达到 maxOutputTokens=${modelMax} 被截断（${model} 硬上限），可再发一条消息接上`;
                            } else if (stepN >= L.maxSteps && lastAct === "tool") {
                                notice = `达到 maxSteps=${L.maxSteps} 步上限，本轮强制收尾（模型仍在请求工具）；继续发消息可接力`;
                            }
                            if (notice) yield* emit({ op: "patch", id: turnId, fields: { notice } });
                            if (usage) {
                                // totalUsage 是整轮的权威值（一次 chat 只有一次 streamText）：
                                // finish-step 的逐轮累加只是"流尾总量偶发缺失"的双保险
                                setTurnUsage(acc, usage as TurnUsage);
                                // 页脚仍用四桶视图：窗口占用取**最后一步**（累加值只解释"这一轮为什么贵"）
                                yield* emit({
                                    op: "patch",
                                    id: turnId,
                                    fields: { usage: turnUsagePatch(turnBuckets, lastStepBuckets, turnCost, identity.contextLimit, stepN, ctxParts) },
                                });
                            }
                            // turn 的 stop 由 closeTurn 发（finally 里那一处）：收尾必须闭合
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
            // 兜底 flush（安全网）：正常路径下 landClaimedSteers 之后紧接着就 flush 了，
            // 走到这里通常为空；留着是为了"将来新增别的投递点"也不会漏给消费端。
            yield* flushSteer();
        } finally {
            // ⚠️ 收尾**必须在 finally 里**（历史 bug 的复现版）：消费端断开时生成器以 return 展开，
            // try/catch 之后的顺序语句一律不执行 —— 那会留下未 stop 的 turn（UI 显示"本轮未完成"
            // + 重放时被 interruptedToolPatches 当成中断轮）、僵尸 activeTurns、缺 turn-end 审计。
            // closeTurn 内部先把副作用同步做完（见其头注），再尽力 yield，故 return 展开下也安全。
            yield* closeTurn(stepId, stepN);
        }
        return { failed, turnId };
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
    /** 模型 id；缺省 = 任务当前人物的模型（与真发同源），显式传则覆盖（试模型用） */
    model?: string;
    /** 历史消息；缺省 = 读任务 LLM 日志（无日志则仅占位，即首轮形态） */
    messages?: ModelMessage[];
    /** 末条 user 消息的正文（缺省是占位文案） */
    lastUser?: string;
    /**
     * runtime 容器全文：作为**独立 user 消息**插在末条之前 —— 与真发同形
     * （真发 = [...历史, {user: runtime}, {user: 本轮输入}]，见 runTurn 的 withRuntime）。
     */
    runtime?: string;
}): Promise<SimulatedRequest> {
    if (!opts.taskUri) {
        return { body: null, note: "无任务场景：仅渲染 system 文本" };
    }
    const taskUri = opts.taskUri;
    // 不传模型 = 按任务当前人物预览：这才是"下一轮真发会用的模型与上下文预算"
    const model = opts.model ?? personaForTask(diyHome(), taskUri).model;
    const cwd = resolveCwdWithNote(diyHome(), taskUri).cwd;
    const L = getLocalAgent().getLimits();
    const modelMax = modelOutputTokens(model);
    // 历史：优先用调用方传的，否则读上次真发落盘的 llm 日志（上限见 PREVIEW_HISTORY_MAX）
    const hist = opts.messages?.length
        ? { messages: opts.messages, total: opts.messages.length }
        : historyFromLog(taskUri, PREVIEW_HISTORY_MAX);
    const messages: ModelMessage[] = [
        ...hist.messages,
        ...(opts.runtime ? [{ role: "user" as const, content: opts.runtime }] : []),
        { role: "user", content: opts.lastUser ?? "[仿真占位]真实下一轮此处为用户输入" },
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
