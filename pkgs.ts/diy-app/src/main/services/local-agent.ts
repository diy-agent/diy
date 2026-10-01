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
import {
    apiOf,
    contextLimitOf,
    DEFAULT_MODEL,
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
    /** chat 面 provider（/chat/completions）；与 responses 面各自单例，key 同生命周期 */
    private provider: ReturnType<typeof createOpenAICompatible> | null = null;
    /** responses 面 provider（/responses）—— responses-only 模型打 chat 面必 503，见 apiOf 注释 */
    private respProvider: ReturnType<typeof createOpenAI> | null = null;
    private _limits: LocalAgentLimits | null = null;

    /** 按 API 面取语言模型：同一 baseURL，路径由 provider 决定（/chat/completions vs /responses） */
    private modelFor(id: string, key: string): LanguageModel {
        if (apiOf(id) === "responses") {
            this.respProvider ??= createOpenAI({ name: "zen-go", baseURL: ZEN_BASE_URL, apiKey: key });
            return this.respProvider.responses(id);
        }
        this.provider ??= createOpenAICompatible({ name: "zen-go", baseURL: ZEN_BASE_URL, apiKey: key });
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

    /**
     * 一轮对话：实时产出块协议 Op；op 即传即落盘（存储=传输）。同 task 并发拒绝。
     *
     * 模型与参数来自**任务绑定的人物**（personas.yaml），入参 model/reasoningEffort 只是
     * 本次临时覆盖（CLI 调试用，UI 不传）——这是「配置真源唯一」的落点：旧实现由 renderer
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
            for await (const op of this.runTurn(taskUri, sess, message, model, reasoningEffort, ctrl.signal, key, sink)) {
                sess.store.apply(op);
                yield op;
            }
            done = true;
            // llm dump 移到 finally（见那里）
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

    /** 生成器本体：ai-sdk fullStream → Op。唯一认识 ai-sdk 事件名的地方。 */
    private async *runTurn(
        taskUri: string,
        sess: LocalSession,
        message: string,
        model: string,
        reasoningEffort: ReasoningEffort,
        signal: AbortSignal,
        key: string,
        sink: (op: Op) => void,
    ): AsyncGenerator<Op> {
        const turnId = `t${Date.now()}`;
        const uid = `${turnId}_u`;
        const cwd0 = resolveCwdWithNote(diyHome(), taskUri).cwd;
        noteTurnStart({ taskUri, model: model, cwd: cwd0 });
        appendAudit(diyHome(), {
            phase: "turn-start",
            taskUri,
            model: model,
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
        yield* emit({ op: "start", id: turnId, kind: "turn", meta: { model: model } });
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

        /**
         * 收尾必闭合（幂等）：step 先于 turn，摘掉活跃轮次并落 turn-end 审计。
         * 超预算早退与正常收尾走同一套（历史 bug：早退的 return 在 try 之前绕过 finally，
         * activeTurns 留僵尸轮次、落盘 ops 缺 turn 的 stop、审计缺 turn-end）。
         *
         * ⚠️ 终态三件事必须**先同步做完、再**把 op 尽力 yield 给消费端（任务 201 R1-S1）：
         *   消费端取消（renderer 点停止 → end 帧 → channel-server-binding 的
         *   `if (cancelled) return` → 链式 gen.return()）会从当前 yield 处截断生成器 ——
         *   JS 语义：finally 里第一个 yield 吐出后，后续代码再也不会执行
         *   （probes/session-running/gen-return-swallows-finally.mjs 可复现）。
         *   旧结构「先 yield 再 noteTurnEnd/审计」在主动停止路径下把这三件事全部吞掉：
         *   turn 的 stop 永远不落 ops → toTree 重放 interrupted=true → UI 永久显示
         *   「⚠ 本轮未完成（流中断/崩溃恢复）」，且 turn-end 审计丢失、崩溃现场误判。
         *   yield 此时只负责「尽力转发给还活着的消费端」—— 被截断也无所谓，事实已在盘上。
         *
         * 返回 op 列表（不再自产自销）：sink/apply 由本函数做一次，yield 交给调用方；
         * chat() 的转发层只会 apply（不重复 sink），块树侧 stop 幂等（重复 apply 无害）。
         */
        const closeTurn = (currentStepId: string, stopped: boolean, steps: number): Op[] => {
            const ops: Op[] = [];
            if (currentStepId !== turnId) ops.push({ op: "stop", id: currentStepId });
            if (!stopped) ops.push({ op: "stop", id: turnId });
            // ① 终态先落：盘（sink）+ 块树（内存，stop 幂等）
            for (const op of ops) {
                sink(op);
                sess.store.apply(op);
            }
            // ② 注销活跃轮次 + 审计（都在 ① 之后：active 归零 ⇒ 盘上必已终态，
            //    renderer 的下降沿 reload 永远不会读到「半截 turn」）
            noteTurnEnd(taskUri);
            appendAudit(diyHome(), {
                phase: "turn-end",
                taskUri,
                model: model,
                result: `steps=${steps} usage=${acc.in}/${acc.out}`,
            });
            // ③ 尽力转发（可被链式 return 截断，不影响 ①②）
            return ops;
        };

        // 系统上下文：分节装配（身份/自述/项目规范/任务/规则/护栏）——与试验场预览同一入口
        const asm = assembleSystem(diyHome(), projectFromUri(taskUri), {
            taskUri,
            // 预算与当前模型的上下文窗口挂钩（小窗口模型拿更小预算，大窗口封顶 64KB）
            contextLimitTokens: contextLimitOf(model),
        });
        if (asm.overBudget) {
            const kb = (n: number) => (n / 1024).toFixed(1);
            yield* errorBlock(
                "budget",
                `系统上下文超出预算（${kb(asm.overBudget.used)} KB > ${kb(asm.overBudget.budget)} KB），本轮未发送。` +
                    `请精简提示词模版或项目 AGENTS.md。`,
            );
            // 拒绝发送也是一轮完整生命周期：必须闭合，否则 UI/崩溃报告/审计三处都会认为它还在跑
            for (const op of closeTurn(stepId, false, stepN)) yield op;
            return;
        }

        const cwd = cwd0;
        const L = this.getLimits();
        const modelMax = modelOutputTokens(model);
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
            model: model,
            system: asm.system,
            tools: Object.keys(buildTools(cwd, L, taskUri)),
            settings: { maxSteps: L.maxSteps, maxOutputTokens: modelMax, maxRetries: 2, reasoningEffort: reasoningEffort ?? "none" },
            messages: sent,
        });
        const result = streamText({
            model: this.modelFor(model, key),
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
                            notice = `输出达到 maxOutputTokens=${modelMax} 被截断（${model} 硬上限），可再发一条消息接上`;
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
            // 轮次审计收尾：崩溃后能区分"死在生成中"还是"生成已结束"。
            // 注意：closeTurn 内部先同步落盘/注销/审计，这里的 yield 只是尽力转发 ——
            // 消费端取消触发的链式 return 会截断后续 yield，但不再伤到终态（见 closeTurn 注释）
            for (const op of closeTurn(stepId, turnStopped, stepN)) yield op;
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
