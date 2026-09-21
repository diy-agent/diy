// src/main/services/local-agent.ts
// 🎯 本地自定义 agent 服务 — ai-sdk streamText 直连 zen/go，实时输出块协议 Op 流
//
// 与 ACP 通道（acp-sessions-v2）完全独立：独立会话、独立存储、独立取消。
// 双日志（$DIY_HOME/local/）：
//   <key>.ops.jsonl — Op 流（UI 重放的权威）
//   <key>.llm.jsonl — ModelMessage[] 完整对话（续聊的权威，含工具链路 id）
// 密钥/上游收敛在 main：renderer 不接触 key；zen/go 无 CORS，代理是硬约束。

import { streamText, tool, stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
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
import { join } from "node:path";
import { diyHome, projectFromUri } from "../core/state";
import { resolveCwd as resolveCwdWithNote } from "../core/cwd";
import { BlockStore, blocksToMessages, interruptedToolPatches, type Op, type JSONVal } from "./local-blocks";
import { collectSelfInfo, judgeSelfKill, selfKillNotice } from "./agent-guard";
import { appendAudit } from "./agent-audit";
import { noteTurnEnd, noteTurnStart } from "./runtime-context";
import { assembleSystem } from "./prompt-registry";

export const DEFAULT_MODEL = "mimo-v2.5";

/**
 * 可选模型：zen/go 的 OpenAI-completions 子集（2026-09-12 实查 /models + models.dev 价格）
 * 价格单位为 $/1M tokens：input / output（cacheRead）
 */
export const LOCAL_MODELS = [
    // maxOutputTokens / contextLimit 来源：models.dev/api.json 的 limit.output / limit.context（2026-09 实查，
    // 取 opencode-go 或同名模型主 provider 的值）。contextLimit 用于推导系统上下文预算（见 prompt-registry）。
    { id: "mimo-v2.5", name: "MiMo V2.5", contextLimit: 1048576, maxOutputTokens: 128000 }, // 0.14 / 0.28 (0.0028)
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextLimit: 1000000, maxOutputTokens: 384000 }, // 0.15 / 0.60 (0.003)
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLimit: 1000000, maxOutputTokens: 384000 }, // 0.15 / 0.60 (0.003)
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash", contextLimit: 1000000, maxOutputTokens: 131072 }, // 0.15 / 0.50 (0.03)
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash", contextLimit: 1000000, maxOutputTokens: 131072 }, // 0.15 / 0.47 (0.016)
    { id: "hy3", name: "Hy3", contextLimit: 256000, maxOutputTokens: 128000 }, // 0.14 / 0.58 (0.035)
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", contextLimit: 1050000, maxOutputTokens: 128000 }, // 0.20 / 1.20 (0.02)
    { id: "minimax-m3", name: "MiniMax M3", contextLimit: 512000, maxOutputTokens: 131072 }, // 0.30 / 1.20 (0.06)
    { id: "minimax-m2.7", name: "MiniMax M2.7", contextLimit: 204800, maxOutputTokens: 131072 }, // 0.30 / 1.20 (0.06)
    { id: "longcat-2.0", name: "LongCat-2.0", contextLimit: 1048756, maxOutputTokens: 131072 }, // 0.30 / 1.20 (0.006)
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", contextLimit: 1048576, maxOutputTokens: 128000 }, // 0.435 / 0.87 (0.003625)
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus", contextLimit: 1000000, maxOutputTokens: 65536 }, // 0.40 / 1.60 (0.04)
    { id: "glm-5.3", name: "GLM-5.3", contextLimit: 1000000, maxOutputTokens: 131072 }, // 1.40 / 4.40 (0.26)
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextLimit: 262144, maxOutputTokens: 262144 }, // 0.95 / 4.00 (0.19)
    { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor (opencode-go)", contextLimit: 1048576, maxOutputTokens: 131072 }, // 0.10 / 0.20
    { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor (opencode-go)", contextLimit: 1048576, maxOutputTokens: 131072 }, // 0.10 / 0.20
];

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
    /** 工具输出回喂模型/展示的截断长度（字符） */
    outputClipChars: number;
}

export const DEFAULT_LIMITS: LocalAgentLimits = {
    maxSteps: 60,
    maxOutputTokens: 4000,
    bashTimeoutMs: 30_000,
    outputClipChars: 6000,
};

function limitsFile(): string {
    return join(localDir(), "limits.json");
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
    const d = join(diyHome(), "local");
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
    return join(localDir(), `${keyOf(taskUri)}.ops.jsonl`);
}
function llmFile(taskUri: string): string {
    return join(localDir(), `${keyOf(taskUri)}.llm.jsonl`);
}

/** 原始流 dump（仅 DIY_RAW_STREAM_DUMP=1 时写）：ai-sdk 的 part 原样落盘，用于研究“Op 是否漏信息” */
function rawFile(taskUri: string): string {
    return join(localDir(), `${keyOf(taskUri)}.raw.jsonl`);
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

function buildTools(cwd: string, limits: LocalAgentLimits, taskUri: string) {
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
            description: "读取文件的文本内容（相对路径按项目目录解析）。",
            inputSchema: z.object({ path: z.string().describe("文件路径") }),
            execute: async ({ path }) => {
                try {
                    return clip(readFileSync(join(cwd, path), "utf-8"), limits.outputClipChars);
                } catch (e) {
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
    private provider: ReturnType<typeof createOpenAICompatible> | null = null;
    private _limits: LocalAgentLimits | null = null;

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

    listModels(): Array<{ id: string; name: string }> {
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

    clear(taskUri: string): boolean {
        this.cancel(taskUri);
        this.sessions.delete(taskUri);
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

    /** 一轮对话：实时产出块协议 Op；op 即传即落盘（存储=传输）。同 task 并发拒绝。 */
    async *chat(taskUri: string, message: string, model?: string): AsyncGenerator<Op> {
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
            for await (const op of this.runTurn(taskUri, sess, message, model, ctrl.signal, key, sink)) {
                sess.store.apply(op);
                yield op;
            }
            done = true;
            // 轮末：从块树重建 LLM 历史（含本轮 user/tool 链路），整体覆盖 llm 日志
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

    /** 生成器本体：ai-sdk fullStream → Op。唯一认识 ai-sdk 事件名的地方。 */
    private async *runTurn(
        taskUri: string,
        sess: LocalSession,
        message: string,
        model: string | undefined,
        signal: AbortSignal,
        key: string,
        sink: (op: Op) => void,
    ): AsyncGenerator<Op> {
        if (!this.provider) {
            this.provider = createOpenAICompatible({
                name: "zen-go",
                baseURL: "https://opencode.ai/zen/go/v1",
                apiKey: key,
            });
        }
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
        yield* emit({ op: "start", id: uid, kind: "text", parent: turnId, meta: { role: "user" } });
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
        // turn 级 usage 累加器（finish-step 逐轮累加；finish 到达时覆盖为权威值）
        const acc = { in: 0, out: 0, total: 0 };
        let turnStopped = false;
        // 收尾原因追踪：步数耗尽检测（最后动作是 tool 且 step 用满 = 模型还想干活被掐）
        let lastAct: "none" | "text" | "tool" = "none";

        /** 收尾必闭合（幂等）：step 先于 turn，摘掉活跃轮次并落 turn-end 审计。
         *  抽成生成器是为了让「超预算早退」也走同一套收尾 —— 历史 bug：早退的 return 在 try 之前，
         *  绕过 finally → activeTurns 留僵尸轮次、落盘 ops 缺 turn 的 stop、审计缺 turn-end。 */
        const closeTurn = function* (currentStepId: string, stopped: boolean, steps: number): Generator<Op, void, void> {
            if (currentStepId !== turnId) yield* emit({ op: "stop", id: currentStepId });
            if (!stopped) yield* emit({ op: "stop", id: turnId });
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
            yield* closeTurn(stepId, false, stepN);
            return;
        }

        const cwd = cwd0;
        const L = this.getLimits();
        const modelMax = modelOutputTokens(model || DEFAULT_MODEL);
        // store 此刻已含本轮 user 块（emit 即 apply）；重建历史自带 user，不再手工拼
        const sent: ModelMessage[] = blocksToMessages(sess.store) as unknown as ModelMessage[];
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
        rawSink({
            kind: "request",
            ts: new Date().toISOString(),
            model: model || DEFAULT_MODEL,
            system: asm.system,
            tools: Object.keys(buildTools(cwd, L, taskUri)),
            settings: { maxSteps: L.maxSteps, maxOutputTokens: modelMax, maxRetries: 2 },
            messages: sent,
        });
        const result = streamText({
            model: this.provider(model || DEFAULT_MODEL),
            system: asm.system,
            messages: sent,
            tools: buildTools(cwd, L, taskUri),
            stopWhen: stepCountIs(L.maxSteps),
            abortSignal: signal,
            headers: { "x-opencode-session": sessionIdOf(taskUri) },
            maxOutputTokens: modelMax, // 按模型硬上限（models.dev），reasoning 模型会先吃一部分
            maxRetries: 2,
        });

        try {
            for await (const part of result.fullStream) {
                rawSink({ kind: "part", seq: ++rawSeq, ts: new Date().toISOString(), part });
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
                            yield* emit({ op: "patch",
                                id: turnId,
                                fields: {
                                    usage: {
                                        in: usage.inputTokens ?? 0,
                                        out: usage.outputTokens ?? 0,
                                        total: usage.totalTokens ?? 0,
                                    },
                                },
                            });
                        }
                        yield* emit({ op: "stop", id: turnId });
                        turnStopped = true;
                        break;
                    }
                }
            }

            // LLM 历史由外层 chat() 从块树统一重建（见 chat 末尾），此处不操作
        } catch (e) {
            // 取消（消费端断开 / 停止按钮）与真实错误分流：前者是预期收尾，后者记 error 块
            if (signal.aborted) yield* errorBlock("abort", "生成已取消");
            else yield* errorBlock("stream", errText(e));
        } finally {
            // 收尾必闭合：step 先于 turn（stop 幂等，重复无害）；
            // 轮次审计收尾：崩溃后能区分"死在生成中"还是"生成已结束"
            yield* closeTurn(stepId, turnStopped, stepN);
        }
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
    const simProvider = getSimProvider(model);
    // 桩响应合法时不会走 catch；以下 catch 只为兼容 SDK 行为变化（body 已到手就算成功）
    try {
        const result = streamText({
            model: simProvider.chatModel(model),
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
    return { body, note: `dry-run：与真发同一条组装链，${histNote}；fetch 桩拦截未发送` };
}
