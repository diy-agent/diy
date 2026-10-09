// src/main/services/local-agent.ts
// 🎯 本地自定义 agent 服务 — ai-sdk streamText 直连 zen/go，实时输出块协议 Op 流
//
// 与 ACP 通道（acp-sessions-v2）完全独立：独立会话、独立存储、独立取消。
// 双日志（$DIY_HOME/local/）：
//   <key>.ops.jsonl — Op 流（UI 重放的权威）
//   <key>.llm.jsonl — **append-only 全量消息日志**（每行 1 条 ModelMessage，行号即消息序号；
//                    续聊/索引的权威。压缩只做投递期投影，绝不写它 —— 见 appendLlm）
//                    行内含 tool-result 的 origin 自证位（tool/interrupted/empty；真发前剥掉）
// 密钥/上游收敛在 main：renderer 不接触 key；zen/go 无 CORS，代理是硬约束。

import { streamText, generateText, tool, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { execFile } from "node:child_process";
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
import { keyOf, llmFile, llmLogRelPath, localDir, opsFile } from "../core/local-paths";

// 再导出：测试与产品共用同一路径实现（不把 key 算法复制到测试里）
export { opsFile };
import { resolveCwd as resolveCwdWithNote } from "../core/cwd";
import {
    BlockStore,
    blocksToMessages,
    danglingStopPatches,
    interruptedToolPatches,
    projectAll,
    selectHistoryByBudget,
    selectForDelivery,
    type DeliveryOpts,
    type Op,
    type JSONVal,
} from "./local-blocks";
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
import { renderBudgetNote } from "../../shared/context/budget-note";
import { describeAnomalies, readLlmLog } from "../../shared/context/log-schema";
import {
    autoCompactPolicyInput,
    BYTES_PER_TOKEN,
    detectAutoCompactTriggers,
    TRIGGER_TEXT,
    type AutoCompactConfig,
    type AutoCompactFacts,
} from "../../shared/context/auto-compact";
import { autoCompactFile, loadAutoCompact, readAutoCompactText } from "../core/auto-compact-config";
import { cacheTtlMsOf } from "../../shared/models";
import {
    effectiveTtl,
    ttlBoundsFrom,
    type CacheObservation,
    type EffectiveTtl,
} from "../../shared/context/cache-ttl";
import { loadSystemPlaces } from "../core/context-config";
import { appendContextStat } from "../core/context-stats";
import { statFromStep } from "../../shared/context/stats";
import type { DeliveryStepRecord } from "../../shared/context/steps";
import {
    estimateTokens,
    makeDeliveryTransform,
    listTurnIds,
    type CompactTrigger,
    normalizePolicy,
    parseCompactLog,
    resolveBoundary,
    utf8Bytes,
    type ClippedToolDetail,
    type CompactEventRecord,
    type CompactLogEvent,
    type CompactPolicy,
    type DroppedTurnDetail,
    type RateSnapshot,
    type SizeSnapshot,
} from "../../shared/context/compaction";
import { layerFacts, type LayerRow, type RequestView } from "../../shared/context/request-view";
import {
    emptySummary,
    parseSummary,
    summaryExtractionPrompt,
    summaryPlaceholder,
    type SummaryData,
} from "../../shared/context/summary";
import { renderSummarySection } from "./prompt-registry";
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
    UPSTREAM_PROVIDER,
    round3,
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
    maxSteps: 200,
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
    /** llm 全量日志（append-only）已写出的消息条数 = 下次 append 的起点（真值在盘上，加载时对账得出） */
    logged: number;
    loaded: boolean;
    running: AbortController | null;
}

// 会话路径（keyOf / opsFile / llmFile）已抽到 ../core/local-paths —— 见那里的头注：
// prompt-registry 也要用它（把回取命令写进 system 的索引说明节点），反向 import 会成环。

/**
 * 全量消息日志的序列化行：**不传投递选项**（= 不受压缩边界影响，原文永不动），
 * 但带两类自证位（落盘用，真发不产生）：
 *   · 消息级 `turn` / `step` —— 索引位（行号 ↔ 轮/步 互查；开场 user 无 step，见 local-blocks）
 *   · part 级 `origin` —— 输出槽三义（tool / interrupted / empty）的自证
 */
function llmLogLines(store: BlockStore): string[] {
    return blocksToMessages(store, { withOrigin: true, withIndex: true }).map((m) => JSON.stringify(m));
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
    // 压缩效果的唯一真值：压缩后首次真发的实测（见 maybeRecordMeasure 头注）
    maybeRecordMeasure(taskUri, rec);
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
/**
 * 摘要作为**首条上下文消息**插在历史之前（承接语义）：[摘要, ...历史, runtime, 新输入]。
 * 为什么是 user 而非 system：system 是稳定前缀（缓存友好），摘要是动态内容；放 user 段
 * 既不砸缓存，也符合"把上一段会话的结论交给你"的对话语义。
 */
function withSummary(hist: ModelMessage[], summaryText: string): ModelMessage[] {
    if (!summaryText.trim()) return hist;
    return [{ role: "user" as const, content: summaryText }, ...hist];
}

/**
 * 合并**相邻的 user 消息**为一条。
 *
 * 为什么必须做：多家 OpenAI-compatible provider（含 zen/go 的部分路由）要求角色交替、
 * 或对连续同角色消息行为不一致（有的报错、有的静默丢弃）。而我们的投递**天然会造出连续 user**：
 *   · runtime 作为尾部 user 插在本轮输入之前 → [..., {user: runtime}, {user: 本轮输入}]
 *   · 摘要作为首条 user 插在历史之前 → [{user: 摘要}, ...{user: 历史首条}]
 * 合并只动相邻 user、位置与总文本不变（前缀缓存不受影响：摘要/runtime 本就在变化段），
 * tool-call/tool-result 配对铁律也不涉及（只合并 user）。
 */
/** user 消息的 content 形态：既可为纯字符串，也可为 part 数组（text/image/file） */
type UserContent = Extract<ModelMessage, { role: "user" }>["content"];
function mergeUserContent(a: UserContent, b: UserContent): UserContent {
    if (typeof a === "string" && typeof b === "string") return `${a}\n${b}`;
    const toParts = (c: UserContent) =>
        typeof c === "string" ? [{ type: "text" as const, text: c }] : (c as unknown[]);
    return [...toParts(a), ...toParts(b)] as UserContent;
}
export function normalizeUserRuns(msgs: ModelMessage[]): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (const m of msgs) {
        const last = out[out.length - 1];
        if (m.role === "user" && last?.role === "user") {
            out[out.length - 1] = {
                role: "user",
                content: mergeUserContent(last.content as UserContent, m.content as UserContent),
            };
        } else {
            out.push(m);
        }
    }
    return out;
}

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
    return readJsonl<DeliveryStepRecord>(stepsFile(taskUri));
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

// ─── 压缩（compact）：账本 / 边界 / 原文寻回 ──────────────
//
// 存储取舍（三句话）：
//   · **不搬文件、不 rm** —— 旧 ops 原地不动，压缩只往 `<key>.compact.jsonl` 写一条账（边界）；
//     于是旧内容天然可查（UI 历史列表）、可撤销（undo）、不需要维护归档目录与索引。
//   · 「彻底删除」仍归现有 `clear()`（物理删所有日志）—— 两个语义分开，文案必须写清。
//   · `sessionIdOf` **不换**（##230 实测：缓存按键于内容前缀、64 token 块、跨 session 共享；
//     换它无收益、反有路由亲和风险）。清零 = 不发送旧内容，纯请求层的事。

/** 压缩账本（append-only：每行一条 compact/measure/undo 事件）。
 *  导出供测试构造「已压缩」的落盘状态（key 算法不复制到测试里）。 */
export function compactFile(taskUri: string): string {
    return path.join(localDir(), `${keyOf(taskUri)}.compact.jsonl`);
}

/** 工具 id 里的非法文件名字符归一（块 id 形如 `t1759_s1_r1`，一般无需动） */
function safeId(id: string): string {
    return id.replace(/[^\w.-]+/g, "_");
}

/** 被裁剪工具输出的原文落盘目录（模型可回取；##127 的「原文可寻回」） */
function toolOutDir(): string {
    const d = path.join(localDir(), "toolout");
    mkdirSync(d, { recursive: true });
    return d;
}

/** marker 里写的相对路径：相对 $DIY_HOME，人/模型都能照此找到原文 */
function toolOutRelPath(id: string): string {
    return `local/toolout/${safeId(id)}.txt`;
}

/** 读取压缩账本（文件不存在 = 从未压缩过；坏行由 parseCompactLog 跳过） */
function readCompactLog(taskUri: string): CompactLogEvent[] {
    const fp = compactFile(taskUri);
    if (!existsSync(fp)) return [];
    try {
        return parseCompactLog(readFileSync(fp, "utf-8"));
    } catch (e) {
        console.error(`[local-agent] 压缩账本读取失败 ${fp}:`, e);
        return [];
    }
}

/** 追加一条压缩账（写失败只出声 —— 记账不能阻断会话） */
function appendCompactEvent(taskUri: string, ev: CompactLogEvent): void {
    const fp = compactFile(taskUri);
    try {
        appendFileSync(fp, `${JSON.stringify(ev)}\n`, "utf-8");
    } catch (e) {
        console.error(`[local-agent] 压缩账写入失败 ${fp}:`, e);
    }
}

/**
 * 压缩后首次真发的实测补写（**零额外请求**：借本轮第一步的 usage 记账）。
 *
 * 用户明确放弃了「压缩效果评估」（##230#25），但请求发出去就没了 —— 现在不存，
 * 将来想算账也无从回补。所以只在有「未实测的压缩」时写一条 measure，不做任何判断与提示。
 */
function maybeRecordMeasure(taskUri: string, rec: StepUsageRecord): void {
    const events = readCompactLog(taskUri);
    let pending: CompactEventRecord | null = null;
    for (const e of events) if (e.kind === "compact") pending = e;
    if (!pending) return;
    if (events.some((e) => e.kind === "measure" && e.ref === pending!.id)) return;
    const b = bucketsOf(rec.usage as UsageLike);
    appendCompactEvent(taskUri, {
        kind: "measure",
        v: 1,
        ref: pending.id,
        ts: new Date().toISOString(),
        firstTurnId: rec.turnId,
        // predicted 只在**真有预测值**时才写：空对象 `{}` 落到盘上毫无信息量，
        // 只会让读账的人以为"预测过但没算出来"（实测账本里就有这种空壳）。
        actual: {
            windowTotal: b.total,
            inputTotal: b.inputTotal,
            cacheRead: b.cacheRead,
            noCache: b.noCache,
            cost: rec.cost?.total ?? null,
            cacheHitRate: b.inputTotal > 0 ? b.cacheRead / b.inputTotal : null,
        },
    });
}

/** ops.jsonl 扫描结果：解析后的 op + 每轮 start 的字节位置（回查/DroppedTurnDetail 的指针） */
interface OpsScan {
    ops: Op[];
    /** turnId → 该轮 start 行的字节偏移 */
    turnOffsets: Map<string, number>;
    /** turnId → 该轮 start 在 ops 数组里的**下标**（机械锚点 keepFromOpIndex 的来源） */
    turnOpIndex: Map<string, number>;
    /** 每轮覆盖的字节数（到下一轮 start 或文件尾） */
    turnBytes: Map<string, number>;
    totalBytes: number;
}

/** 扫一遍 ops 文件：既要 op 对象，也要每轮的字节位置（分两次算等于读两遍大文件） */
function scanOpsFile(taskUri: string): OpsScan {
    const fp = opsFile(taskUri);
    const ops: Op[] = [];
    const turnOffsets = new Map<string, number>();
    const turnOpIndex = new Map<string, number>();
    const turnBytes = new Map<string, number>();
    if (!existsSync(fp)) return { ops, turnOffsets, turnOpIndex, turnBytes, totalBytes: 0 };
    const buf = readFileSync(fp);
    let start = 0;
    let offset = 0;
    const ids: string[] = [];
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0x0a) continue;
        const line = buf.subarray(start, i).toString("utf-8").trim();
        if (line) {
            try {
                const op = JSON.parse(line) as Op;
                ops.push(op);
                if (op.op === "start" && op.kind === "turn") {
                    turnOffsets.set(op.id, start);
                    turnOpIndex.set(op.id, ops.length - 1); // 该 op 刚 push 进 ops
                    ids.push(op.id);
                }
            } catch {
                // 半行跳过（与 readJsonl 同策略）
            }
        }
        offset = i + 1;
        start = i + 1;
    }
    for (let k = 0; k < ids.length; k++) {
        const from = turnOffsets.get(ids[k])!;
        const to = k + 1 < ids.length ? turnOffsets.get(ids[k + 1])! : offset;
        turnBytes.set(ids[k], Math.max(0, to - from));
    }
    return { ops, turnOffsets, turnOpIndex, turnBytes, totalBytes: offset };
}

/** 一组 op → 规模快照（messages 用真实投影，bytes 用 JSON 字节 —— 与真发口径一致） */
function sizeOfOps(ops: readonly Op[], opts?: Parameters<typeof blocksToMessages>[1]): SizeSnapshot {
    const store = new BlockStore();
    for (const op of ops) store.apply(op);
    const msgs = blocksToMessages(store, opts);
    const bytes = utf8Bytes(msgs.map((m) => JSON.stringify(m)).join("\n"));
    // ⚠️ `turns` 必须按**投递口径**数，不能拿 `listTurnIds(ops)`（那是全部轮的个数）。
    //    旧实现就是这么写的，于是「全部清零」后 after.turns 仍显示 3 —— 一个自相矛盾的账目
    //    （消息 0 条、却写着 3 轮）。账本要能自证，数字之间不许打架。
    //    用与投递同一次选择（projectAll + selectHistory），不另算一份判据。
    const all = projectAll(store);
    const sel = selectForDelivery(all, opts ?? {});
    const turns = new Set(sel.kept.map((i) => all[i]!.turn).filter((x): x is string => !!x)).size;
    return {
        turns,
        messages: msgs.length,
        bytes,
        estTokens: estimateTokens(bytes),
    };
}

/**
 * 由「策略 + 边界」构造投递选项（纯函数，不读盘）。
 * 抽出来的理由：真发（deliveryOptsOf）与**预览/记账**（compact）必须用同一份构造逻辑，
 * 否则「预览说省 97%、真发却照旧」这种分叉根本测不出来。
 */
function optsFor(policy: CompactPolicy, collect?: ClippedToolDetail[]): DeliveryOpts {
    return makeDeliveryTransform(policy, toolOutRelPath, collect);
}

/** 压缩预案的中间态（planCompact 输出；compact 与 compactPreview 共用） */
interface CompactPlan {
    policy: CompactPolicy;
    keptTurns: number;
    keptFromTurnId: string | null;
    keepFromOpIndex: number;
    droppedIds: string[];
    /** 预算算法的**过滤器表达**：保留的行号区间（1-based）；非预算支为 null */
    keptRuns: [number, number][] | null;
    scan: OpsScan;
    store: BlockStore;
    before: SizeSnapshot;
    after: SizeSnapshot;
    droppedDetail: DroppedTurnDetail[];
    clipped: ClippedToolDetail[];
    rateSnap?: RateSnapshot;
    /** 账目（可缺；形状与账本的 `cost` 分组一致） */
    stats: NonNullable<CompactEventRecord["cost"]>;
}

/** 压缩预览（只算不写）：panel「事实」行 + 预览页共用 */
export interface CompactPreview {
    policy: CompactPolicy;
    keptTurns: number;
    droppedTurns: number;
    keptFromTurnId: string | null;
    before: SizeSnapshot;
    after: SizeSnapshot;
    droppedDetail: DroppedTurnDetail[];
    clipped: ClippedToolDetail[];
    /** 改参数后这一次请求的实际投递内容（与真发同一组装链） */
    modRequest: RequestView;
    /** 基准请求 = **未压缩**（全量历史、无注记）—— 右栏 diff 的左侧 */
    baseRequest: RequestView;
    /** 事实表：base（当前生效请求）vs mod 的分层 token 与金额差 */
    facts: LayerRow[];
}

/** 一轮的摘要（被丢弃轮次的索引项；全文仍留在 ops 原地） */
function describeTurn(store: BlockStore, turnId: string, offset: number, bytes: number): DroppedTurnDetail {
    const detail: DroppedTurnDetail = {
        turnId,
        opsOffset: offset,
        opsBytes: bytes,
        steps: 0,
        textBytes: 0,
        thinkBytes: 0,
        tools: [],
    };
    const walk = (bid: string): void => {
        const b = store.blocks.get(bid);
        if (!b) return;
        if (b.kind === "step") detail.steps++;
        else if (b.kind === "text" && b.role !== "user") detail.textBytes += utf8Bytes(String(b.content ?? ""));
        else if (b.kind === "think") detail.thinkBytes += utf8Bytes(String(b.content ?? ""));
        else if (b.kind === "tool") {
            const out = typeof b.output === "string" ? b.output : "";
            detail.tools.push({
                id: b.id,
                tool: String(b.tool ?? "tool"),
                argsBrief: JSON.stringify(b.args ?? b.input ?? "").slice(0, 200),
                outLines: out === "" ? 0 : out.split("\n").length,
                outBytes: utf8Bytes(out),
                status: String(b.status ?? ""),
            });
        }
        for (const c of b.children) walk(c);
    };
    walk(turnId);
    return detail;
}

/**
 * 用量经验（全部来自 usage 账本，**纯账、无需语义**；##230 作废「重复率」后留下的三个硬指标）。
 * 缺数据时字段缺省（不编 0）：'不可测 ≠ 0' 是 ##211 定下的口径。
 */
function usageStats(
    usages: StepUsageRecord[],
    afterTokens: number,
    rate: RateSnapshot | undefined,
): NonNullable<CompactEventRecord["cost"]> {
    if (usages.length === 0) return {};
    const buckets = usages.map((r) => bucketsOf(r.usage as UsageLike));
    const zeroOutputSteps = buckets.filter((b) => b.noCache === 0).length;
    let taxShare: number | undefined;
    const priced = usages.filter((r) => r.cost && r.rates);
    if (priced.length === usages.length) {
        const totalCost = priced.reduce((a, r) => a + (r.cost?.total ?? 0), 0);
        const readCost = priced.reduce((a, r, i) => {
            const b = buckets[i]!;
            return a + ((r.rates!.cacheRead ?? r.rates!.input) * b.cacheRead) / 1_000_000;
        }, 0);
        if (totalCost > 0) taxShare = readCost / totalCost;
    }
    const rebuildCost = rate ? (afterTokens * Math.max(0, rate.input - rate.cacheRead)) / 1_000_000 : undefined;
    const avgNew = buckets.reduce((a, b) => a + b.noCache, 0) / buckets.length;
    const windowNow = buckets[buckets.length - 1]!.total;
    const backfillSteps =
        avgNew > 0 && windowNow > afterTokens ? Math.round((windowNow - afterTokens) / avgNew) : undefined;
    return {
        ...(taxShare !== undefined ? { taxShare } : {}),
        zeroOutputSteps,
        ...(rebuildCost !== undefined ? { rebuildCost } : {}),
        ...(backfillSteps !== undefined ? { backfillSteps } : {}),
    };
}

/** 把「被丢弃的轮」的文本抽出来（喂给摘要抽取模型）；截断防爆 token */
function droppedTextOf(store: BlockStore, droppedIds: readonly string[], maxChars = 120_000): string {
    const parts: string[] = [];
    const walk = (id: string) => {
        const b = store.blocks.get(id);
        if (!b) return;
        if (b.kind === "text") {
            const role = String(b.role ?? "user");
            const c = String(b.content ?? "").trim();
            if (c) parts.push(`[${role}] ${c}`);
        } else if (b.kind === "tool") {
            const args = b.args != null ? JSON.stringify(b.args).slice(0, 200) : "";
            const out = String(b.output ?? "").slice(0, 4000);
            parts.push(`[tool ${String(b.tool ?? "")}] ${args}\n→ ${out}`);
        }
        for (const c of b.children) walk(c);
    };
    for (const id of droppedIds) walk(id);
    const text = parts.join("\n\n");
    return text.length > maxChars ? text.slice(0, maxChars) + "\n…（已截断）" : text;
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

    // 【已移除】sinceTurnIdOf / deliveryOptsOf —— 旧"读压缩账边界"的投递口径。
    // 配置 / 历史分离后，投递口径一律取**当前配置**（见 deliveryHistory / requestView），
    // 压缩账只作历史快照。（保留此说明，免得后来者又去找它们。）

    private getSession(taskUri: string): LocalSession {
        let s = this.sessions.get(taskUri);
        if (!s) {
            s = { store: new BlockStore(), logged: 0, loaded: false, running: null };
            this.sessions.set(taskUri, s);
        }
        if (!s.loaded) {
            // ops 日志 → 块树 → LLM 历史（wire = store = UI = LLM 单一权威路径）
            for (const op of readJsonl<Op>(opsFile(taskUri))) s.store.apply(op);
            // 崩溃残留自愈：半截块补终态 + 未闭合块补 stop（写回 ops，幂等）。
            // 必须在「接受新输入之前」做完 —— getSession 先于 runTurn，故补写的轮不会插到新轮后面。
            this.convergeOnLoad(taskUri, s);
            s.logged = this.reconcileLlmLog(taskUri, s);
            s.loaded = true;
        }
        return s;
    }

    /**
     * 加载时自愈（幂等）：把崩溃/被杀留下的**半截块与未闭合轮**收敛成显式终态，写回 ops。
     *
     * 为什么必须在加载时做（而不是等下一条用户消息）：
     *   旧实现靠「下一轮开场收敛 + 每轮整份重写 llm 日志」自愈；改 append-only 后不会自愈 ——
     *   未 stop 的轮无法定稿（定稿判据 = turn 已 stop），于是它永远缺在日志里，UI 也一直显示
     *   「本轮未完成」。用户 2026-10-06 的判据：「ops 也好、llm 消息也好都应该处理好，
     *   不然 ops 补了、llm 没补，也是问题」。
     */
    private convergeOnLoad(taskUri: string, s: LocalSession): void {
        const fp = opsFile(taskUri);
        const sink = (op: Op) => {
            try {
                appendFileSync(fp, `${JSON.stringify(op)}\n`, "utf-8");
            } catch (e) {
                console.error(`[local-agent] 加载自愈落盘失败 ${fp}:`, e);
            }
        };
        // 先补 tool 的业务终态（patch + stop），再补剩余结构开口（stop）—— 前者已 stop 的块
        // 不会被后者重复处理（danglingStopPatches 只挑未 stop 的）。
        for (const op of [...interruptedToolPatches(s.store), ...danglingStopPatches(s.store)]) {
            sink(op);
            s.store.apply(op);
        }
    }

    /**
     * llm 全量日志（append-only）对账 —— 加载时跑一次，返回「已写条数」作 append 游标。
     *
     * 三种结果：
     *   · 一致             → 游标 = 全量条数（绝大多数情况）
     *   · 文件是投影的前缀 → **追加**补齐（崩溃时最后一轮没来得及写）
     *   · 中部就不一致     → **整份重建**（原子 tmp+rename）并出声（旧版本脏行 / 被手工改过）
     * 为什么不在运行期做：「只增」的价值是行号稳定（D2 的索引锚点），运行期永不回改已写内容。
     */
    private reconcileLlmLog(taskUri: string, s: LocalSession): number {
        const fp = llmFile(taskUri);
        const expect = llmLogLines(s.store);
        let actual: string[] = [];
        if (existsSync(fp)) {
            try {
                actual = readFileSync(fp, "utf-8").split("\n").filter((l) => l.trim() !== "");
            } catch (e) {
                console.error(`[local-agent] llm 日志读取失败 ${fp}:`, e);
                return 0;
            }
        }
        let k = 0;
        while (k < actual.length && k < expect.length && actual[k] === expect[k]) k++;
        if (k === actual.length && k === expect.length) return k; // 一致
        if (k === actual.length) {
            // 文件是投影的前缀 → 只追加缺的尾部（崩溃残留轮），不动已写行
            try {
                appendFileSync(fp, expect.slice(k).map((l) => `${l}\n`).join(""), "utf-8");
                return expect.length;
            } catch (e) {
                console.error(`[local-agent] llm 日志补齐失败 ${fp}:`, e);
                return k;
            }
        }
        // 不一致才做一次读侧校验：把"为什么坏"写进日志（异常数据必须可见，不许静默重建）。
        // 只在罕见路径上跑，热路径零成本。
        let why = "";
        try {
            const an = readLlmLog(actual.join("\n")).anomalies;
            if (an.length > 0) why = `；异常行：${describeAnomalies(an)}`;
        } catch {
            /* 诊断失败不影响重建 */
        }
        console.warn(`[local-agent] llm 全量日志与 ops 投影不一致（第 ${k + 1} 条起），整份重建 ${fp}${why}`);
        try {
            writeFileSync(`${fp}.tmp`, expect.map((l) => `${l}\n`).join(""), "utf-8");
            renameSync(`${fp}.tmp`, fp);
            return expect.length;
        } catch (e) {
            console.error(`[local-agent] llm 日志重建失败 ${fp}:`, e);
            return k;
        }
    }

    /**
     * 一轮定稿后追加写全量日志（**只增**）。
     * 起点 = 内存游标（加载时对账得出）；投影收缩（ops 被截/换机器）时回退到整份对账。
     */
    private appendLlm(taskUri: string, s: LocalSession): void {
        const fp = llmFile(taskUri);
        let expect: string[];
        try {
            expect = llmLogLines(s.store);
        } catch (e) {
            console.error(`[local-agent] llm 日志投影失败 ${taskUri}:`, e);
            return;
        }
        if (expect.length < s.logged) {
            // 投影比已写还短 → 交给整份对账，别盲目 append 出重复/错位行
            s.logged = this.reconcileLlmLog(taskUri, s);
            return;
        }
        if (expect.length === s.logged) return;
        try {
            appendFileSync(fp, expect.slice(s.logged).map((l) => `${l}\n`).join(""), "utf-8");
            s.logged = expect.length;
        } catch (e) {
            console.error(`[local-agent] llm 日志追加失败 ${fp}:`, e);
        }
    }

    /**
     * **投递口径的历史**（真发 / 预览 / panel 三处唯一入口）。
     *
     * 未压缩 → 与历史行为逐字一致（全量投影）。
     * 已压缩 → 被省区间渲染成一条 **user 索引注记**，拼在保留部分之前（形式 B）：
     *   messages 保持原样（provider 最友好、前缀缓存不砸），结构化索引只出现在"被省的位置"。
     *   注记与紧邻的保留首条 user 会被 normalizeUserRuns 合并成一条（provider 拒连续同角色）。
     *
     * 行号口径：llm.jsonl 只增且**第 i 行 = 全量投影第 i 条**（加载时已对账/补齐），
     * 故此处用全量投影的序号当行号 —— 它是模型回取时的真实落点。
     */
    private deliveryHistory(
        taskUri: string,
        store: BlockStore,
        collect?: ClippedToolDetail[],
    ): ModelMessage[] {
        // 【配置 / 历史分离，用户 2026-10-07】投递口径 = **当前配置**（期望值），每次请求实时算 ——
        // 改预算**本轮即生效**。压缩账（compact.jsonl）只是**历史快照**（不可变，供回溯/对比），
        // 不再决定投递（旧实现读 `resolveBoundary` → 没压过就不生效，违反直觉）。
        const policy = loadAutoCompact(diyHome()).policy;
        return this.buildHistory(store, policy, collect, taskUri);
    }

    /** 面板参数预览用（给定 policy + 边界现算，不读生效账本）—— 与真发同一条构造链 */
    private deliveryHistoryForView(store: BlockStore, policy: CompactPolicy | null, taskUri: string): ModelMessage[] {
        return this.buildHistory(store, policy, undefined, taskUri);
    }

/**
     * 投递历史的**唯一构造**：原生投影 + 预算注记。
     * policy=null ⇒ 全量（未压缩，无注记）。
     */
    private buildHistory(
        store: BlockStore,
        policy: CompactPolicy | null,
        collect?: ClippedToolDetail[],
        /** 原文路径用（注记里的 file 字段）；view 路径与真发同一个 taskUri */
        taskUriOf = "",
    ): ModelMessage[] {
        const opts: DeliveryOpts = policy ? optsFor(policy, collect) : {};
        const kept = blocksToMessages(store, opts) as unknown as ModelMessage[];
        if (!policy || !this.noteEnabled()) return kept;
        // 预算注记：只列**保留区间**（gap 自明，不逐 gap 标注）
        const all = projectAll(store);
        const sel = selectHistoryByBudget(all, policy.modeData.budgetBytes, opts);
        const note = renderBudgetNote(
            {
                about: "会话历史已按字节预算压缩：以下是**保留位置索引**，区间之间的行号即被省略的部分",
                budgetBytes: policy.modeData.budgetBytes,
                keptBytes: sel.keptBytes,
                kept: sel.keptRuns,
            },
            { file: llmLogRelPath(taskUriOf), absPath: llmFile(taskUriOf), legendInSystem: true },
        );
        return normalizeUserRuns([{ role: "user", content: note }, ...kept]);
    }

    /** 索引注记开关（默认开；`DIY_CTX_HISTORY_NOTE=0` 关 —— 对照实验用，将来收编进 policy） */
    private noteEnabled(): boolean {
        return process.env["DIY_CTX_HISTORY_NOTE"] !== "0";
    }

    /**
     * 缓存观测序列（供 TTL 夹逼）——从 usage 账本 + steps 快照**离线**推（无额外请求）。
     *
     * 判据（见 cache-ttl.ts 头注）：
     *   · gap = 本步 ts − 上一步 ts；hit = 本步缓存读 > 0
     *   · `samePrefix`：同一轮内的步**必同前缀**（system/runtime 都不变）；跨轮比对两轮的
     *     `systemText`（steps.jsonl 每条都记了全文）—— 变了就是"作废"不是"过期"，不进夹逼。
     * 缺上游数据（老会话没 steps）时保守取 false（宁可少算，不可把作废当过期）。
     */
    private cacheObservations(taskUri: string): CacheObservation[] {
        const usages = readStepUsages(taskUri);
        if (usages.length < 2) return [];
        const steps = readDeliverySteps(taskUri);
        const sysOfTurn = new Map<string, string>();
        for (const st of steps) sysOfTurn.set(st.turnId, st.systemText);
        const out: CacheObservation[] = [];
        for (let i = 1; i < usages.length; i++) {
            const prev = usages[i - 1]!;
            const cur = usages[i]!;
            const gapMs = Date.parse(cur.ts) - Date.parse(prev.ts);
            const b = bucketsOf(cur.usage as UsageLike);
            const sameTurn = cur.turnId === prev.turnId;
            const sPrev = sysOfTurn.get(prev.turnId);
            const sCur = sysOfTurn.get(cur.turnId);
            const samePrefix = sameTurn || (sPrev !== undefined && sCur !== undefined && sPrev === sCur);
            out.push({ gapMs, hit: b.cacheRead > 0, samePrefix });
        }
        return out;
    }

    /** 该任务当前生效的 TTL（实测夹逼 + 先验；模型先验见 models.ts 的 cacheTtlMs） */
    effectiveTtlOf(taskUri: string): EffectiveTtl {
        const model = personaForTask(diyHome(), taskUri).model;
        return effectiveTtl(ttlBoundsFrom(this.cacheObservations(taskUri)), cacheTtlMsOf(model));
    }

    /**
     * **自动压缩检测**（只读，不写任何东西）——UI 提示与 CLI 都用它。
     *
     * 三个事实都从现成数据取（零额外请求、零额外模型调用）：
     *   · systemContextChanged —— 当前 system 全文 vs 上一条 steps 快照的 systemText
     *   · sinceLastRequestMs   —— now − 最后一条 usage 的 ts
     *   · windowBytes          —— 最后一步用量（最后一步 = 窗口占用，见 ##211 §三）token 数 ×4 折字节
     */
    autoCompactStatus(taskUri: string): {
        config: AutoCompactConfig;
        facts: AutoCompactFacts;
        triggers: CompactTrigger[];
        reasons: string[];
        /** 配置真源 `auto-compact.yaml` 的**原始全文**（含注释）—— 供 UI「原始配置」只读视图 */
        raw: { path: string; text: string };
    } {
        const config = loadAutoCompact(diyHome());
        // 系统上下文：与上次真发那份比（口径与 steps.jsonl 的 systemText 完全一致）
        const home = diyHome();
        const globals = assembleGlobals(home, projectFromUri(taskUri), { taskUri }) as unknown as Record<string, unknown>;
        const delivery = buildDelivery(globals, loadSystemPlaces(home));
        const lastStep = readDeliverySteps(taskUri).at(-1) ?? null;
        const systemContextChanged = lastStep !== null && lastStep.systemText !== delivery.system.text;

        const usages = readStepUsages(taskUri);
        const last = usages.at(-1) ?? null;
        const sinceLastRequestMs = last ? Date.now() - Date.parse(last.ts) : null;
        // 窗口占用（**字节**）：优先用**实测**（最后一步用量 = 窗口占用的权威口径，见 ##211 §三），
        // 按全仓同一套 ÷4 粗估折字节；没有用量账（老会话 / 手工造的会话）时退回**估算**
        // （当前投递的字节）—— 估不准总比"未知"强：未知会让"窗口超限"这个硬件约束形同虚设。
        const windowBytes = last
            ? bucketsOf(last.usage as UsageLike).total * BYTES_PER_TOKEN
            : delivery.system.bytes +
              delivery.runtime.bytes +
              this.deliveryHistory(taskUri, this.sessions.get(taskUri)?.store ?? new BlockStore()).reduce(
                  (a, m) => a + JSON.stringify(m).length,
                  0,
              );

        const facts: AutoCompactFacts = {
            systemContextChanged,
            sinceLastRequestMs,
            ttl: this.effectiveTtlOf(taskUri),
            windowBytes,
        };
        const triggers = detectAutoCompactTriggers(facts, config);
        const raw = { path: autoCompactFile(home), text: readAutoCompactText(home) };
        return { config, facts, triggers, reasons: triggers.map((t) => TRIGGER_TEXT[t]), raw };
    }

    /**
     * 投递口径的历史消息（与真发同源：压缩边界 + 索引注记 + 工具输出裁剪）。
     * **只读**：自己 replay ops，不加载会话、不落盘 —— 预览用，不应有副作用。
     * （不能用 llm.jsonl：那是 append-only 的**全量**日志，含已被压掉的轮。）
     */
    deliveryMessages(taskUri: string): ModelMessage[] {
        const store = new BlockStore();
        for (const op of readJsonl<Op>(opsFile(taskUri))) store.apply(op);
        return this.deliveryHistory(taskUri, store);
    }

    listModels(): LocalModel[] {
        return LOCAL_MODELS;
    }

    /** 会话的 ops 视图（UI 重放）：**固定消息集合**，始终全量（压缩不隐藏历史，只过滤投递） */
    history(taskUri: string): Op[] {
        // 【配置 / 历史分离】历史 = **固定的消息集合**：聊天页始终全显，压缩只体现在"发给模型的"
        // 与压缩面板里（压缩是投递侧的**过滤**，不销毁、不隐藏）。旧实现按边界切片 → 预算的
        // 分散保留与之不吻合，已废。
        return readJsonl<Op>(opsFile(taskUri));
    }

    /**
     * 压缩事件账（历史页数据源）：**不可变快照列表**（时间 / 算法 / 过滤器 / 前后规模 / 方式·理由）。
     * 每条的 `policy` 自带算法（`mode`）与该算法的过滤器表达 —— 换算法 = 新分支，不混淆。
     * 【用户 2026-10-07】取代旧的 generations（连续分代不适合预算的分散保留）。
     */
    compactEvents(taskUri: string): CompactLogEvent[] {
        return readCompactLog(taskUri);
    }

    /**
     * 压缩执行：写一条账（append-only）+ 落盘被裁原文 + 重置内存态。
     *
     * 失败/边界原则（照 clear 的教训）：**先把可失败的事做完，最后才改内存态**。
     * 中途失败时盘上账本可能已写一半 —— 所以账本只 append 一条 JSON 行（要么整行在、要么不在）。
     */
    /**
     * 压缩预案（**只算不写**）：预览、panel「事实」行、真发前的记账共用同一份计算。
     * 抽出来是为了「预览看到的 = 真压出来的」——两条路径各算各的必然分叉。
     */
    private planCompact(taskUri: string, policyInput: unknown): CompactPlan {
        const policy = normalizePolicy(policyInput);
        const scan = scanOpsFile(taskUri);
        const turnIds = listTurnIds(scan.ops);
        const store = new BlockStore();
        for (const op of scan.ops) store.apply(op);
        // 保留 = 预算选择（实时算）。keptRuns = 预算的**过滤器表达**（存进事件，供历史回溯还原 diff）
        const all = projectAll(store);
        const sel = selectHistoryByBudget(all, policy.modeData.budgetBytes, optsFor(policy));
        const keptRuns = sel.keptRuns;
        const keptSet = new Set(sel.kept.map((i) => all[i]!.turn).filter((t): t is string => !!t));
        const keptTurns = keptSet.size;
        const keptFromTurnId: string | null = sel.kept.length > 0 ? (all[sel.kept[0]!]!.turn ?? null) : null;
        const droppedIds = turnIds.filter((id) => !keptSet.has(id));

        // 机械锚点：保留起点轮的 op 下标；全清（keptTurns=0）→ 压缩时刻的 op 总数
        const keepFromOpIndex =
            keptFromTurnId !== null ? (scan.turnOpIndex.get(keptFromTurnId) ?? -1) : scan.ops.length;

        const clipped: ClippedToolDetail[] = [];
        const before = sizeOfOps(scan.ops);
        const after = sizeOfOps(scan.ops, optsFor(policy, clipped));

        const droppedDetail = droppedIds.map((id) =>
            describeTurn(store, id, scan.turnOffsets.get(id) ?? 0, scan.turnBytes.get(id) ?? 0),
        );

        const model = personaForTask(diyHome(), taskUri).model;
        const rates = costOf(model, after.estTokens);
        const rateSnap: RateSnapshot | undefined = rates
            ? {
                  // provider = **谁服务的**（我们实际调的上游），不是价目真源名。
                  // 旧实现把 `rates.source`（"models.dev@…"）填进 provider —— 那是一个自相矛盾的
                  // 字段（"provider: models.dev" 会让人以为请求走了 models.dev，它只是个价目网站）。
                  provider: UPSTREAM_PROVIDER,
                  source: rates.source,
                  model,
                  input: rates.input,
                  cacheRead: rates.cacheRead ?? rates.input,
                  // 圆整：这是给人看的账目数字，`50.00000000000001` 这种毛刺只是浮点残渣（实测）
                  k: round3((rates.cacheRead ?? rates.input) > 0 ? rates.input / (rates.cacheRead ?? rates.input) : 0),
                  asOf: MODEL_COST_AS_OF,
              }
            : undefined;
        const stats = usageStats(readStepUsages(taskUri), after.estTokens, rateSnap);
        return { policy, keptTurns, keptFromTurnId, keepFromOpIndex, droppedIds, keptRuns, scan, store, before, after, droppedDetail, clipped, rateSnap, stats };
    }

    /**
     * 构造「一次请求的实际投递内容」（展示用）。
     * **与真发同一条链**：assembleGlobals → buildDelivery → blocksToMessages（+ 工具输出裁剪）。
     * 预览的全部价值就是"看到的就是会发出去的"，所以这里不许另算一份。
     */
    private buildRequestView(
        taskUri: string,
        policy: CompactPolicy | null,
        keptFromTurnId: string | null | undefined,
        summaryOverride?: string,
    ): RequestView {
        const home = diyHome();
        const globals = assembleGlobals(home, projectFromUri(taskUri), { taskUri }) as unknown as Record<string, unknown>;
        const delivery = buildDelivery(globals, loadSystemPlaces(home));
        const { cwd } = resolveCwdWithNote(home, taskUri);
        const L = this.getLimits();
        const tools = buildTools(cwd, L, taskUri);
        const store = new BlockStore();
        for (const op of readJsonl<Op>(opsFile(taskUri))) store.apply(op);
        // 与真发**同一条链**（含压缩注记）：面板里的"压缩后预览"就是这一份
        const history = withRuntime(
            this.deliveryHistoryForView(store, policy, taskUri),
            delivery.runtime.text,
        );
        const summaryText = summaryOverride !== undefined ? summaryOverride : this.effectiveSummary(taskUri);
        const messages = normalizeUserRuns(withSummary(history, summaryText));
        return {
            model: personaForTask(home, taskUri).model,
            system: delivery.system.text,
            tools: Object.entries(tools).map(([name, t]) => ({
                name,
                description: String((t as { description?: unknown }).description ?? ""),
            })),
            messages: messages as unknown[],
            toolsBytes: JSON.stringify(tools).length,
        };
    }

    /**
     * 当前生效压缩的摘要文本（未压缩/未生成摘要 → 空串 = 不投递）。
     * ⚠️ 读的是**历史 compact 快照**里的 summary，而非「当前配置」——与 `pit.config-vs-history` 相悖。
     * 因 UI 摘要入口已删、`summary` 标「暂未启用」，此链**休眠**，不阻塞。激活摘要时须改为读当前配置
     * （见 ##273，review 2026-10-08 备注）。
     */
    effectiveSummary(taskUri: string): string {
        const events = readCompactLog(taskUri);
        const b = resolveBoundary(events);
        if (!b) return "";
        const c = events.find((e) => e.kind === "compact" && e.id === b.compactId) as CompactEventRecord | undefined;
        return c?.details?.summary?.text ?? "";
    }

    /** 当前生效摘要的结构化数据（预览占位与再生成用） */
    currentSummaryData(taskUri: string): SummaryData {
        const events = readCompactLog(taskUri);
        const b = resolveBoundary(events);
        const c = b ? (events.find((e) => e.kind === "compact" && e.id === b.compactId) as CompactEventRecord | undefined) : undefined;
        return c?.details?.summary?.data ?? emptySummary();
    }

    /**
     * 对**将被丢弃的轮**生成结构化摘要（一次模型调用；花钱，故由 UI 显式触发）。
     * 返回渲染好的文本（走 summary.md 模版）+ 结构化数据 + 金额。
     */
    async summarize(
        taskUri: string,
    ): Promise<{ text: string; data: SummaryData; cost: number | null }> {
        const key = process.env.OPENCODE_ZEN_API_KEY;
        if (!key) throw new Error("缺少 OPENCODE_ZEN_API_KEY（main 进程环境变量）");
        // 摘要针对**当前配置下会被丢弃的轮**（与 compact 同一份预算），不再用旧的 keepTurns 旋钮。
        const p = this.planCompact(taskUri, loadAutoCompact(diyHome()).policy);
        if (p.droppedIds.length === 0) return { text: "", data: emptySummary(), cost: null };
        const model = personaForTask(diyHome(), taskUri).model;
        const dropped = droppedTextOf(p.store, p.droppedIds);
        const res = await generateText({
            model: this.modelFor(model, key),
            prompt: summaryExtractionPrompt(dropped, p.droppedIds.length),
            headers: { "x-opencode-session": sessionIdOf(taskUri) },
            maxOutputTokens: 2000,
            maxRetries: 2,
        });
        const data = parseSummary(res.text);
        if (!data) throw new Error("摘要模型未返回可解析的 JSON（已放弃本次摘要，不写空摘要冒充成功）");
        data.turns = p.droppedIds.length;
        const b = bucketsOf(res.usage as UsageLike);
        const rates = costOf(model, b.inputTotal);
        const cost = rates ? costBreakdown(rates, b).total : null;
        const text = renderSummarySection(diyHome(), projectFromUri(taskUri), data);
        return { text, data, cost };
    }

    /** 当前生效请求（base）：不传策略 = 用盘上生效的边界与裁剪 */
    requestView(taskUri: string): RequestView {
        // 与真发同源：读**当前配置**（不是压缩账里的旧 policy；配置 / 历史分离）
        return this.buildRequestView(taskUri, loadAutoCompact(diyHome()).policy, undefined);
    }

    /** 压缩预览（只算不写）：面板左侧参数 + 右侧请求 YAML diff + 事实表的数据源 */
    compactPreview(taskUri: string, policyInput: unknown, summaryText?: string): CompactPreview {
        const p = this.planCompact(taskUri, policyInput);
        // base = **未压缩**的投递（全量历史、无注记）—— 配置 / 历史分离后，"当前配置"就是 mod，
        // 拿它当 base 会得出"无差异"。预览的价值是看"这次压缩**去掉/改了什么**"，故 base 取全量。
        const base = this.buildRequestView(taskUri, null, undefined);
        // 勾选摘要但尚未生成 → 用占位骨架（让用户先看见"会得到什么"，且不花一分钱）
        const sum = p.policy.summary
            ? summaryText !== undefined
                ? summaryText
                : this.effectiveSummary(taskUri) || summaryPlaceholder(emptySummary(p.droppedIds.length))
            : "";
        const mod = this.buildRequestView(taskUri, p.policy, p.keptFromTurnId, sum);
        const inputRate = costOf(base.model, p.after.estTokens)?.input ?? 0;
        return {
            policy: p.policy,
            keptTurns: p.keptTurns,
            droppedTurns: p.droppedIds.length,
            keptFromTurnId: p.keptFromTurnId,
            before: p.before,
            after: p.after,
            droppedDetail: p.droppedDetail,
            clipped: p.clipped.map((c) => ({ ...c, tool: p.store.blocks.get(c.id)?.tool ? String(p.store.blocks.get(c.id)!.tool) : c.tool })),
            modRequest: mod,
            baseRequest: base,
            facts: layerFacts(base, mod, inputRate),
        };
    }

    /**
     * 执行压缩：写一条账（append-only）+ 落盘被裁原文 + 重置内存态。
     *
     * 失败/边界原则（照 clear 的教训）：**先把可失败的事做完，最后才改内存态**。
     * 账本是 append-only 的单行 JSON（要么整行在、要么不在），中途失败也不会留半条。
     */
    compact(
        taskUri: string,
        policyInput: unknown,
        by: "ui" | "cli" | "auto",
        summary?: { text: string; data: SummaryData; cost: number | null },
        /** 为什么压（手动 / 系统上下文变 / 缓存过期 / 窗口超限；缺省 manual）。
         *  放在 summary 之后：既有调用点全是位置参数，追加在尾部才不会把 summary 挤错位。 */
        trigger: CompactTrigger = "manual",
    ): CompactEventRecord {
        // 【用户 2026-10-07】允许**轮次中**压缩（长任务不能等一轮结束）。压缩只写快照 + 落盘被裁原文，
        // 不改 ops、不重置会话（投递按当前配置实时算），故对正在跑的轮次无副作用。
        const p = this.planCompact(taskUri, policyInput);
        // 空操作：无轮被丢 + 无工具被裁 + 投递字节不缩 ⇒ 什么都没改，**不写账**（写一条"压缩"却
        // 没压任何东西是误导：历史页会把它当一次真压缩）。缓存过期 / 系统上下文变触发时预算本就够用，
        // 这条很常见（实测 auto cacheExpired 空转）。返回带 noop 的记录，调用方可据此提示"无需压缩"。
        const noop = p.droppedIds.length === 0 && p.clipped.length === 0 && p.after.bytes >= p.before.bytes;

        // 原文落盘：marker 指的路径必须真的能打开（否则模型只能重跑命令 —— 那是真金白银）
        for (const c of noop ? [] : p.clipped) {
            const b = p.store.blocks.get(c.id);
            c.tool = b?.tool ? String(b.tool) : c.tool;
            try {
                writeFileSync(path.join(toolOutDir(), `${safeId(c.id)}.txt`), typeof b?.output === "string" ? b.output : "", "utf-8");
            } catch (e) {
                console.error(`[local-agent] 工具原文落盘失败 ${c.id}:`, e);
            }
        }

        const ts = new Date().toISOString();
        const rec: CompactEventRecord = {
            kind: "compact",
            v: 2,
            id: ts,
            ts,
            by,
            trigger,
            policy: p.policy,
            // 锚点：只记**物理位置**（逻辑 id 只是 label）
            boundary: {
                keptFromTurnId: p.keptFromTurnId,
                keepFromOpIndex: p.keepFromOpIndex,
                ...(p.keptFromTurnId !== null && p.scan.turnOffsets.has(p.keptFromTurnId)
                    ? { keptFromOpsOffset: p.scan.turnOffsets.get(p.keptFromTurnId)! }
                    : {}),
            },
            // 结果数字（keptTurns/droppedTurns 归这里 —— 它们是结果，不是锚点）
            size: {
                before: p.before,
                after: p.after,
                keptTurns: p.keptTurns,
                droppedTurns: p.droppedIds.length,
            },
            cost: { ...(p.rateSnap ? { rates: p.rateSnap } : {}), ...p.stats },
            details: {
                dropped: p.droppedDetail,
                clipped: p.clipped,
                ...(p.keptRuns ? { kept: p.keptRuns } : {}),
                summary: { text: summary?.text ?? null, data: summary?.data ?? null, cost: summary?.cost ?? null },
            },
            ...(noop ? { noop: true } : {}),
        };
        // 空操作不写账（见上）；非空操作才 append。
        if (!noop) appendCompactEvent(taskUri, rec);
        return rec;
    }

    /** 撤销某次压缩（append-only 的 undo：不删账，只标） */
    undoCompact(taskUri: string, ref: string): boolean {
        const events = readCompactLog(taskUri);
        if (!events.some((e) => e.kind === "compact" && e.id === ref)) return false;
        if (events.some((e) => e.kind === "undo" && e.ref === ref)) return false;
        appendCompactEvent(taskUri, { kind: "undo", v: 1, ref, ts: new Date().toISOString() });
        this.sessions.delete(taskUri);
        return true;
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
        // 文件清单必须**穷举**：加新日志（如 usage / compact）时漏一处，就是「彻底删除」删不干净
        // （旧实现就漏了 usage.jsonl —— 用量账本按会话存，留着它会让删除后仍查到本会话的花费）。
        for (const f of [
            opsFile(taskUri),
            llmFile(taskUri),
            rawFile(taskUri),
            stepsFile(taskUri),
            usageFile(taskUri),
            compactFile(taskUri),
        ]) {
            try {
                rmSync(f, { force: true });
            } catch (e) {
                // force:true 已吸收 ENOENT；能到这里的都是真故障（权限/只读盘），不能冒充成功
                console.error(`[local-agent] 删除日志失败 ${f}:`, e);
                ok = false;
            }
        }
        // 被裁剪工具输出的原文：按本任务账本里引用过的 id 删（toolout/ 是多任务共享目录，
        // 不能整个删 —— 同 id 也可能被别的任务引用）。
        for (const e of readCompactLog(taskUri)) {
            if (e.kind !== "compact") continue;
            for (const c of e.details?.clipped ?? []) {
                try {
                    rmSync(path.join(toolOutDir(), `${safeId(c.id)}.txt`), { force: true });
                } catch (err) {
                    console.error(`[local-agent] 删除工具原文失败 ${c.id}:`, err);
                    ok = false;
                }
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
        let sess = this.getSession(taskUri);
        if (sess.running) throw new Error(`任务 ${taskUri} 的本地会话正在生成中`);

        // ── 自动压缩（新请求之前，是唯一正确的时机）──
        // 为什么在这里：三个触发条件（缓存过期 / 系统上下文变 / 窗口超限）都要求"**发出去之前**"
        // 处理 —— 发完再压，那次已经按全价付过了。而且此处的 `deliveryOptsOf` 读的就是最新边界。
        // 只读检测 → `mode: "auto"` 才动手；`notify` 只提供状态（UI 提示 + 一键），不静默改会话
        // （静默丢用户历史与 `rule.no-silent-catch` 同一条原则）。
        if (loadAutoCompact(diyHome()).mode === "auto") {
            try {
                const st = this.autoCompactStatus(taskUri);
                if (st.triggers.length > 0) {
                    const rec = this.compact(
                        taskUri,
                        autoCompactPolicyInput(st.config),
                        "auto",
                        undefined,
                        st.triggers[0],
                    );
                    console.log(
                        `[local-agent] 自动压缩 ${taskUri}：${st.reasons.join("；")}` +
                            `（before ${rec.size.before.turns} 轮 → after ${rec.size.after.turns} 轮）`,
                    );
                    // 边界变了 → 内存态必须重建（compact 内部已 delete sessions，这里重新加载）
                    sess = this.getSession(taskUri);
                }
            } catch (e) {
                // 自动压缩失败**不阻断本轮**（用户还是要能说话），但必须出声
                console.error(`[local-agent] 自动压缩失败（已跳过，本轮照常发送）${taskUri}:`, e);
            }
        }

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
            // 轮末落盘：**append-only 全量日志**（不再整份覆盖、不再受压缩边界影响）。
            //   时刻合法：本轮的 turn 块已在 runTurn 的 finally 里 stop ⇒ 内容此后不再变
            //   （「turn 已 stop 即定稿」）。中断 tool 块的收敛发生在下一轮开场，但它只改
            //   status/output 字段，而投影按 status 分流（见 local-blocks）⇒ 收敛前后 append
            //   的字节逐字相同，不必等它。
            // ⚠️ 必须在 finally、不能只放在 try 尾 —— 消费端取消（renderer 点停止 → end 帧 →
            // channel-server-binding 的 if(cancelled) return → 链式 gen.return()）会把 try 的
            // 后半段**整段截断**（任务 201 R1-S1：旧实现因此在主动停止后既缺 turn 的 stop、
            // 也缺这份 dump）。finally 无 yield，不会被吞没，每条退出路径都能留下最后一轮。
            // 空树跳过：装配期就抛错时块树未动，什么也不该写。
            if (sess.store.roots().length > 0) this.appendLlm(taskUri, sess);
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
            const sent: ModelMessage[] = normalizeUserRuns(
                withSummary(
                    withRuntime(this.deliveryHistory(taskUri, sess.store), delivery.runtime.text),
                    this.effectiveSummary(taskUri),
                ),
            );
            // 本轮的**投递选择事实**（配置驱动压缩）：分表用它标注「本步（轮首）投递被压过」（##272 B1）。
            // 与 compact 事件解耦 —— 事件只在触发/手动时写；这里每轮首都有（投递本就无条件按当前配置筛选）。
            const selPolicy = loadAutoCompact(diyHome()).policy;
            const allMsgs = projectAll(sess.store);
            const sel = selectHistoryByBudget(allMsgs, selPolicy.modeData.budgetBytes, optsFor(selPolicy));
            const historySelection = {
                budgetBytes: selPolicy.modeData.budgetBytes,
                keptBytes: sel.keptBytes,
                keptRuns: sel.keptRuns.length,
                droppedMessages: sel.dropped.length,
                totalMessages: allMsgs.length,
            };
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
                                    ...(stepN === 1 ? { historySelection } : {}),
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

export interface SimulatedRequest {
    /** 定稿 HTTP body（request.json 同形）；无任务场景时为 null */
    body: Record<string, unknown> | null;
    note: string;
}

/**
 * 仿真预览请求：用与 runTurn 完全相同的参数调 streamText，
 * 经 transformRequestBody 捕获定稿 body 后由 fetch 桩吞掉发送（一字节不出网）。
 * 保真关键：system/tools/limits/headers/messages 都走真实数据，只在最后一毫米掐断。
 * - messages：缺省从**块树现算投递口径**（与真发同一投影：含压缩边界与工具裁剪），末尾补一条占位 user —— 这才是「下一轮会发出的请求」。
 *   **不再读 llm.jsonl**：它现在是 append-only 的**全量**日志，拿它当历史会把该压掉的轮又发出去。
 * - 无副作用：不写审计/日志，工具 execute 永不触发；桩返回**合法 SSE**，连 SDK 的 console.error 都不产生。
 */
export async function previewSimulatedRequest(opts: {
    taskUri: string;
    /** 已渲染的 system 全文（调用方经 prompt-registry 模板链得到） */
    system: string;
    /** 模型 id；缺省 = 任务当前人物的模型（与真发同源），显式传则覆盖（试模型用） */
    model?: string;
    /** 历史消息；缺省 = 从块树现算投递口径（无 ops 则仅占位，即首轮形态） */
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
    // 历史：优先用调用方传的；否则从块树现算（与真发同一条投影 —— 含压缩边界与工具裁剪）。
    // 全量下发（不再有截尾上限）：历史已被压缩边界裁过，再截尾会破坏「预览=真发」。
    const hist = opts.messages?.length
        ? { messages: opts.messages }
        : { messages: getLocalAgent().deliveryMessages(taskUri) };
    // 与真发同样合并相邻 user（真发 = normalizeUserRuns(...本轮的 runtime + 输入)）——
    // 否则预览会显示两条连续 user，而真发只有一条，破坏「预览看到的 = 发出去的」
    const messages: ModelMessage[] = normalizeUserRuns([
        ...hist.messages,
        ...(opts.runtime ? [{ role: "user" as const, content: opts.runtime }] : []),
        { role: "user", content: opts.lastUser ?? "[仿真占位]真实下一轮此处为用户输入" },
    ]);
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
        hist.messages.length === 0 ? "无历史：首轮形态" : `含历史 ${hist.messages.length} 条（与真发同源）`;
    return {
        body,
        note: `dry-run：与真发同一条组装链（${apiOf(model)} 面），${histNote}；fetch 桩拦截未发送`,
    };
}
