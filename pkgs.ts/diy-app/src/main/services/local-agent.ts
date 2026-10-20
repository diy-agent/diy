// src/main/services/local-agent.ts
// 🎯 本地自定义 agent 服务 — ai-sdk streamText 直连 zen/go，实时输出块协议 Op 流
//
// 与 ACP 通道（acp-sessions-v2）完全独立：独立会话、独立存储、独立取消。
// 双日志（##379 起每个会话一个目录：`$DIY_HOME/local/<uri 路径>/<key>/`；旧平铺 `local/<key>.*` 读侧兜底）：
//   ops.jsonl — Op 流（UI 重放的权威）
//   llm.jsonl — **append-only 全量消息日志**（每行 1 条 ModelMessage，行号即消息序号；
//                    续聊/索引的权威。压缩只做投递期投影，绝不写它 —— 见 appendLlm）
//                    行内含 tool-result 的 origin 自证位（tool/interrupted/empty；真发前剥掉）
// 密钥/上游收敛在 main：renderer 不接触 key；zen/go 无 CORS，代理是硬约束。

import { streamText, generateText, tool, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
    appendFileSync,
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    readSync,
    rmSync,
    statSync,
} from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../core/atomic-write";
import { findInOpsFile, type FindResult, type FindScopes } from "./local-find";
import { diyHome, projectDir, projectFromUri } from "../core/state";
import { keyOf, llmFile, llmLogRelPath, localDir, opsFile, sessionFileForWrite, sessionFilesToClear, sessionIdOf } from "../core/local-paths";

// 再导出：测试与产品共用同一路径实现（不把 key 算法复制到测试里）
export { opsFile };
import { resolveCwd as resolveCwdWithNote } from "../core/cwd";
import {
    BlockStore,
    blocksToMessages,
    compactOps,
    toTree,
    danglingStopPatches,
    interruptedToolPatches,
    interruptedToolPatchesOfTurn,
    projectAll,
    replay,
    costOfWith,
    selectHistoryByBudget,
    selectForDelivery,
    type BlockKind,
    type BlockNode,
    type DeliveryOpts,
    type Op,
    type JSONVal,
    type TurnEndReason,
} from "./local-blocks";
import { DEFAULT_KEEP, DEFAULT_MUST_HARD_CAP_BYTES, DEFAULT_REASONING_CLIP, type KeepStage } from "../../shared/context/compact-keep";
import { keepStagesToPlan, runPlan } from "./compaction-plan";
import {
    decodeCursor,
    encodeCursor,
    isTurnStartAt,
    seekTurnStartAtOrBefore,
    seekWindowStart,
} from "./local-ops-seek";
import { appendAudit } from "./agent-audit";
import {
    PLAN_SCOPE_NOTE,
    planCheck,
    planGet,
    planReset,
    planRestore,
    planVersions,
    planVersionView,
    planSet,
    renderCheckView,
    renderPlanVersionsView,
    renderPlanVersionView,
    renderPlanView,
} from "./compact-plan-io";
import { appendPlanVersion, currentPlanVersion, planVersionDoc, planVersionId, writePlanVersion } from "./plan-store";
import { capToolOutput, toolOutFile, toolOutFileCandidates, toolOutRelPath } from "./tool-output";
import { abortText } from "../../shared/turn-end";
import { triageOf, triageOfTurnEnd } from "../../shared/error-triage";
import { opsFeed } from "./ops-feed";
import type { DeliveryOrigin, TurnOrigin } from "../../shared/room";
// 「模型不可用」通知（##369 ①）：判据在 shared/model-unavailable，通知中心在 model-notice
import { modelNoticeHub, noticeFromError, unavailableNoticeFromLocal } from "./model-notice";
import { networkStreak } from "./env-watch";
import { AsyncQueue, withCleanup } from "./async-queue";
import { sessionRegistry } from "./session-registry";
// 轮首房间上下文（##377 第 25 刀）：**只读盘 + 水位**，不 import room-service（那条是反方向，
// 会造成循环 —— room-service 静态 import 本模块的 getLocalAgent）。
import { commitSelfStartContext, roomRuntimeFact, type RoomRuntimeValue } from "./room-context";
import { addStepUsage, newUsageAcc, setTurnUsage, type TurnUsage } from "./turn-usage";
import {
    bucketsOf,
    costBreakdown,
    rateFromTotals,
    snapshotUsage,
    stepRate,
    sumBuckets,
    sumCosts,
    turnUsagePatch,
    type CostBreakdown,
    type StepStreamShape,
    type StepUsageRecord,
    type UsageBuckets,
    type UsageLike,
} from "../../shared/usage";
import { buildDelivery, isRuntimePlace, runtimeDiffDelivery, type Delivery } from "../../shared/context/delivery";
import { renderBudgetNote } from "../../shared/context/budget-note";
import { renderSummaryPart, tailEnvelope } from "../../shared/context/envelope";
import { describeAnomalies, readLlmLog } from "../../shared/context/log-schema";
import {
    autoCompactPolicyInput,
    detectAutoCompactTriggers,
    TRIGGER_TEXT,
    type AutoCompactConfig,
    type AutoCompactFacts,
    type AutoCompactIssue,
} from "../../shared/context/auto-compact";
import { autoCompactFile, loadAutoCompact, loadAutoCompactDetailed, readAutoCompactText } from "../core/auto-compact-config";
import { cacheTtlMsOf } from "../../shared/models";
import {
    effectiveTtl,
    ttlBoundsFrom,
    type CacheObservation,
    type EffectiveTtl,
} from "../../shared/context/cache-ttl";
import { loadSystemPlaces } from "../core/context-config";
import { appendContextStat } from "../core/context-stats";
import { traffic } from "../core/traffic";
import { appendCtxLog, hasV2CtxLog, lastCtxLogSeq, readCtxLogEntries } from "../core/context-changelog";
import { statFromStep } from "../../shared/context/stats";
import { atomicUnitPaths, changesOf, foldCtxTree, type CtxSnapshot } from "../../shared/context/changelog";
import type { DeliveryStepRecord } from "../../shared/context/steps";
import {
    budgetBytesOf,
    clipSpecOf,
    estimateTokens,
    fmtBytes,
    makeDeliveryTransform,
    listTurnIds,
    toolResultOf,
    type CompactTrigger,
    normalizePolicy,
    parseCompactLog,
    resolveBoundary,
    utf8Bytes,
    type ClippedToolDetail,
    type CompactEventRecord,
    type CompactPlanSnapshot,
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
import { readFileWindow, formatReadOutput, READ_MAX_BYTES, READ_MAX_LINES } from "../core/file-read";
import { SteerQueue, fileSteerPort } from "../core/steer-queue";
import { DEFAULT_STEER_MODE, steerModeLabel } from "../../shared/steer-mode";
import type { SteerItem, SteerMode } from "../core/drafts";

import {
    apiOf,
    contextLimitOf,
    costOf,
    effectiveMaxOutputTokens,
    findModel,
    findPricedModel,
    getModelCatalog,
    MODEL_COST_AS_OF,
    ratesOfModel,
    round3,
    isKnownModel,
    maxOutputTokensOf,
    reasoningOf,
    type LocalModel,
    type LocalModelApi,
    type LocalModelReasoning,
    type ResolvedModel,
    type ReasoningEffort,
} from "../../shared/models";
import { personaByIdOrName, personaForTask } from "../core/persona";
import { resolveModelKey } from "../core/model-runtime";

// 模型查询函数抽到 shared/models.ts（core 不能被 services 反向依赖，否则循环 import）。
// 这里**原样 re-export**：历史引用路径（tests/…/local-models-*.test.ts 等）保持不变。
export { apiOf, contextLimitOf, isKnownModel, maxOutputTokensOf, reasoningOf };
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
 * 生效 baseUrl：一律走 spec 配的 baseUrl。`DIY_ZEN_BASE_URL` 是**测试/自建代理**接缝
 * （把任意 provider 的请求指到桩上游，详见 tests/cli.intent.steer-ui.test.ts）。多账号不在此
 * 区分（baseUrl 是 provider 级的）。
 */
export function resolveBaseUrl(m: ResolvedModel): string {
    return process.env["DIY_ZEN_BASE_URL"] || m.baseUrl;
}

// 解析「人物/覆盖里写的模型引用」→ 运行时模型 + 密钥：见 LocalAgentManager.resolveModel。

/**
 * 按 model id 查 maxOutputTokens，回退全局 limits。
 *
 * ⚠️ 必须保证返回 **>= 1**：`streamText({ maxOutputTokens })` 传 0/负数会被 SDK 直接拒
 * （"maxOutputTokens must be >= 1"，##184 实测）。spec 未给 limit.output 的模型（如
 * commandcode 的 /models 只给 context_length、不给输出上限）走这里回退，绝不把 0 下发。
 */
function modelOutputTokens(modelId: string): number {
    return effectiveMaxOutputTokens(modelId, DEFAULT_LIMITS.maxOutputTokens);
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
    /**
     * 插话/排队队列的条数上限（##306）。
     *
     * 防的不是"条数多"，而是**无界**：会话在跑时新消息改为排队后，灌风暴的那一端
     * 不再是报错的调用方，而是这个队列（落盘文件 + 内存 + 提示词）。合并投递消化的是
     * 请求次数，条数上限守的是队列本身的体量。
     */
    maxSteerQueue: number;
}

export const DEFAULT_LIMITS: LocalAgentLimits = {
    maxSteps: 200,
    maxOutputTokens: 4000,
    bashTimeoutMs: 30_000,
    outputClipChars: 6000,
    readMaxBytes: READ_MAX_BYTES,
    maxSteerQueue: 1000,
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
        maxSteerQueue: envPosInt(env, "DIY_LOCAL_MAX_STEER_QUEUE") ?? num(base.maxSteerQueue, DEFAULT_LIMITS.maxSteerQueue),
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
    /**
     * 发言者署名（##166 §40 A）：**谁说的这句话** —— `agent:main` / `human:ccc` 这类成员 id，
     * 不是自由字符串（可追溯、可点开）。省略 = 本任务本人（任务对话页的正常情形）。
     *
     * 落点 = 该条 user 块的 `meta.author`（写进去之前先确认块 schema 白名单里有它 —— 没有会被洗，
     * 见 local-blocks 的 SCHEMA.text）。**在 TurnInput 上而不是整轮一个**：轮首批量可能多条，
     * 每条来自不同的队列项（各自署名不同）。
     */
    author?: string;
    /**
     * 这条消息的**房间来源**（##377 第 23 刀）：从哪个房间、哪一条 `say` 投过来的。
     *
     * 落点 = 该条 user 块的 `meta.room`（`{ roomId, sayId }`，见 `shared/room.DeliveryOrigin`）。
     * 与 `author` 分工：`author` = 谁说的，`room` = 从哪来的。省略 = 不是投递来的
     * （任务页本人发言 / 老数据）⇒ 气泡逐字不变。
     */
    room?: DeliveryOrigin;
}

interface LocalSession {
    /** 块树（Op 重放）：UI 与 fold 的唯一权威；llm.jsonl 只是观察 dump */
    store: BlockStore;
    /** llm 全量日志（append-only）已写出的消息条数 = 下次 append 的起点（真值在盘上，加载时对账得出） */
    logged: number;
    loaded: boolean;
    running: AbortController | null;
}

/**
 * 一次**轮次运行**（##305）：生命周期独立于任何消费端连接。
 *
 * 改造前 `chat()` 生成器**就是**轮次的驱动者 —— RPC 流一断（刷新/切页/关窗/杀 CLI），
 * 链式 `gen.return()` 展开生成器，`finally` 里 `ctrl.abort()` 把正在跑的轮次掐掉（无人消费即停）。
 * 现在驱动（`driveTurn`）归本管理器持有，`agent.local.chat` 的流只是**订阅者**：
 * 断开只退订，重连靠 ops 水位（##307 读侧）追平 —— 刷新只是"重新接上视图"。
 *
 * 无人消费**继续烧 token**（用户定案：agent 对话是后台进程的维护，窗口只是它的使用窗口之一）：
 * 单轮开销由 **`maxSteps`（缺省 200）步数上限**天然收口 —— 打满即强制收尾并落
 * `endReason:{type:"max-steps"}`（机制已存在）。**不设时间维度的超时回收**（用户拍板：
 * 离开两小时不该误杀正常长任务）；main 卡死（卡在工具里不产步）由人在全局会话视图上
 * 手动强制中断（[5] ##308）。
 */
interface TurnRun {
    taskUri: string;
    /** 本轮的中止源。**唯一来源 = 用户主动停止**（`cancel()`）—— 不再由消费端断开触发 */
    ctrl: AbortController;
    /**
     * 订阅本轮的 `agent.local.chat` 流。断开只从集合摘掉，不影响驱动。
     *
     * 边界（review2 R6）：**只承载驱动产出的 op**（`publish`）。`enqueueWhileRunning` 的排队回执走
     * 它自己的 `yield`（那条路径压根没有 TurnRun），不进这里 —— UI 靠 ops 流（##307）全可见，故当下无感。
     * 若将来把 chat 流当「全会话镜像」，须先统一 emit 出口，否则会漏掉排队回执。
     */
    subs: Set<AsyncQueue<Op>>;
    /** 驱动异常：按原语义经流上抛（RPC 层转 error 帧），由订阅端在流尾 rethrow */
    error?: unknown;
}

/** 从 abort reason 取「结束原因来源」：对象 `{source}` 用它的，否则退回 fallback（如用户停止 = abort） */
function abortSource(signal: AbortSignal, fallback: string): string {
    const r: unknown = signal.reason;
    if (r && typeof r === "object" && "source" in (r as Record<string, unknown>)) {
        return String((r as { source: unknown }).source);
    }
    return fallback;
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

/**
 * 投递快照（每轮真发一条）：投递**事实**，与 raw 那种旁路观测不同 —— UI 的 step/diff 靠它。
 * 导出供测试构造落盘状态（review RV-17：别让用例靠后缀反推路径 —— 改后缀会静默变成假绿）。
 */
export function stepsFile(taskUri: string): string {
    return sessionFileForWrite(taskUri, "steps");
}

/**
 * 逐步用量账本（每步一行；见 ##211 §六）。
 * **独立文件**：不塞进 steps.jsonl —— 那份是「投递事实」（UI 的 step/diff 靠它），
 * 掺进观测数据会让「投递了什么」与「花了多少」两件事互相污染（一个写失败拖累另一个）。
 */
function usageFile(taskUri: string): string {
    return sessionFileForWrite(taskUri, "usage");
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
    return sessionFileForWrite(taskUri, "raw");
}

/** 原始流开关（默认关；读取时快照一次，避免一处开一处关） */
function rawDumpEnabled(): boolean {
    return process.env["DIY_RAW_STREAM_DUMP"] === "1";
}

/**
 * 一步流形状的累加器（##288 观察位）。**只记事实，不做判定** ——
 * 「有没有正文」「工具调用是不是最后发生的」这类问题必须由数据回答，不能靠猜。
 */
function newShape(): StepStreamShape {
    return { order: "", textChunks: 0, reasoningChunks: 0, toolCalls: 0 };
}

/** 记一个 part 段首（r=思考 t=文本 x=工具调用） */
function markShape(s: StepStreamShape, ch: "r" | "t" | "x"): void {
    s.order += ch;
    if (ch === "r") s.reasoningChunks++;
    else if (ch === "t") s.textChunks++;
    else s.toolCalls++;
}


/**
 * runtime 容器作为**尾部 user 消息**插在本轮输入之前（144 的投递设计）。
 * 易变项（任务正文、技能清单等）放这里，稳定项在 system 参数里；两者合起来才是完整上下文。
 * runtime 为空 → 原样返回（不硬塞空消息：白耗 token 且让模型困惑）。
 */
/**
 * 合并**相邻的 user 消息**为一条。
 *
 * ⚠️ 依据已实测订正（2026-10-16，##310）：**本仓在用的两家 provider 都不拒连续同角色**
 * —— `goat`（`api.commandcode.ai`）与 `opencode-go`（`opencode.ai/inference/go`）对
 * `[{user: A},{user: B}]` 以及 content 数组形式的连续 user 均返回 200。所以这条合并
 * **不是**"provider 要求"，而是**收敛语义**：投递**天然会造出连续 user**
 * （runtime / summary 作为尾部 user 插在本轮输入之前），合并成一条能让"给模型的这份信封"
 * 只有一处 user，减少歧义、少一条消息。**若将来遇到真拒连续同角色的 provider，这里就是唯一改动点。**
 *
 * 合并只动相邻 user、位置与总文本不变（前缀缓存不受影响：摘要/runtime 本就在变化段），
 * tool-call/tool-result 配对铁律也不涉及（只合并 user）。
 *
 * 依据实测记录：`bash /tmp/t310-role3.sh`（两家 × 纯文本/parts 各一条，全 200）。
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

/**
 * 把**尾部信封**拼进 messages：`summary:`（历史摘要素，可选）+ `history:`（压缩索引注记，可选）
 * + `runtime:`（或 `runtimeDiff:`）+ `user:`（本轮输入），合成**一份**合法 YAML（`tailEnvelope`）。
 *
 * 为什么合成一份（##310 六轮拍板）：这些段与本轮输入是**相邻 user**，而
 * `normalizeUserRuns` 必然把它们合并成一条（收敛成"一份信封一条 user"）。与其让合并
 * 产出一段"YAML 后面跟着裸文本"的怪东西，不如**我们自己合成一份合法 YAML**：
 *
 *     summary:      ← 仅当有历史摘要（自动生成的元数据，自己的顶层键）
 *       |-
 *       …
 *     history:      ← 仅当历史被压缩（自动生成的元数据，自己的顶层键）
 *       kept: [[5, 8]]
 *     runtime:      ← 或 runtimeDiff:
 *       task: {…}
 *     user:
 *       message: '用户真正说的话'
 *
 * ⚠️ 自动生成的段**一律要有自己的顶层键**（##310 八/九轮）：注记曾与保留首条 user 被合并，
 * 于是 `user.message` = 「history 索引 + 用户原话」拼在一起 —— 模型把它当成任务内容去查
 * （tasks/5 实测：多烧 3 次 bash、5.6 万 prompt token 就为一个字）。摘要（`withSummary`）同坑，
 * 九轮一并改成顶层键 `summary:`。
 *
 * 尾部不是 user（如自动续跑、纯工具轮）→ 不编 `user:` 段；三段全空 → 原样返回。
 */
function withRuntime(hist: ModelMessage[], runtime: string, historyNote = "", summaryPart = ""): ModelMessage[] {
    const parts = [summaryPart, historyNote, runtime].filter((t) => t.trim());
    if (parts.length === 0) return hist;
    const last = hist[hist.length - 1];
    if (last && last.role === "user" && typeof last.content === "string" && last.content.trim()) {
        return [...hist.slice(0, -1), { role: "user", content: tailEnvelope(parts, last.content) }];
    }
    // 没有可并的输入：只有 runtime 一段时保持旧形（逐字一致）；否则各段各有顶层键
    if (parts.length === 1 && runtime.trim() && !historyNote.trim() && !summaryPart.trim()) {
        return [...hist, { role: "user", content: runtime }];
    }
    return [...hist, { role: "user", content: tailEnvelope(parts) }];
}

/**
 * 投递口径的历史 = **消息** + **压缩索引注记片段**（`history:` 一段，纯数据）。
 *
 * 为什么把注记拿出来（##310 八轮）：它进 messages 就必然被 `normalizeUserRuns` 合并进
 * 相邻那条 user 的正文 —— 于是自动生成的元数据伪装成用户原话。改成"注记 = 独立顶层键片段"，
 * 由调用方与 runtime 一起塞进**尾部信封**（`withRuntime`），`user.message` 只剩用户真说的那句。
 */
export interface HistoryDelivery {
    messages: ModelMessage[];
    /** 压缩索引注记片段（`history:` 一段；空串 = 本次没压缩，不投递） */
    note: string;
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

/** 文件字节数（不存在 = 0）。会话历史缓存的失效判据之一。 */
function fileSize(fp: string): number {
    try {
        return statSync(fp).size;
    } catch {
        return 0;
    }
}

/**
 * 分页窗口的一段（任务 293）：**已折叠**的 op 流 + 段起点游标 + 「更早还有轮吗」。
 * `cursor` 是 main 签发的不透明 token（渲染端只回传），见 local-ops-seek。
 *
 * `stale` = 「请求带的游标失效，本次给的是**全量**而非按游标切的段」。渲染端必须据此重置
 * 现有段（否则它会拿全量当"更早一段"前插，把历史拼重复）。窗口与游标的连续性只有 main
 * 校验得了（渲染端看不懂字节），所以**由 main 出声**，而不是让渲染端猜（任务 ##293 的坑：
 * 曾试图用"两段轮次互为前缀"判连续性 —— 两段在字节上是切分的、轮次不重叠，判据恒假）。
 */
export interface HistoryWindow {
    ops: Op[];
    cursor: string;
    hasMore: boolean;
    /** 游标失效（清空 / 覆盖写 / 起点不再是轮首）⇒ 本次是退化全量，渲染端要重置 */
    stale: boolean;
}

/** 折叠缓存的上限（LRU）：块树常驻内存，多开几个大会话也不至于无界堆积。 */
const HISTORY_CACHE_MAX = 8;

/** 前 4KB 指纹：整文件覆盖写的哨兵（同尺寸覆盖时的唯一线索，见 history 的缓存判定）。 */
const HISTORY_PREFIX_BYTES = 4096;
function readPrefix(fp: string): string {
    try {
        const fd = openSync(fp, "r");
        try {
            const buf = Buffer.allocUnsafe(HISTORY_PREFIX_BYTES);
            const got = readSync(fd, buf, 0, HISTORY_PREFIX_BYTES, 0);
            return buf.subarray(0, Math.max(0, got)).toString("utf-8");
        } finally {
            closeSync(fd);
        }
    } catch {
        return "";
    }
}

/**
 * 读 `[from, to)` 的 op 行，返回实际消费到的字节偏移（只到**最后一个完整行**为止，
 * 尾部半行留给下一次 —— 崩溃/写入中途读到的半行不能被当成一条 op）。
 *
 * 为什么不是「读满一次就完事」（任务 290 review B1）：`Buffer.allocUnsafe` 的未初始化区
 * 在短读（信号打断、offset 越界）时会被当作日志解析 —— 未初始化堆内存里恰好有个 '
'，
 * 消费位置就会被推过真实数据，**永久跳掉一段对话**。故：循环读满 + 一切以 got 为界。
 */
function readOpsRange(fp: string, from: number, to: number): { ops: Op[]; consumed: number } {
    const len = to - from;
    if (len <= 0) return { ops: [], consumed: from };
    const fd = openSync(fp, "r");
    try {
        const buf = Buffer.allocUnsafe(len);
        let got = 0;
        while (got < len) {
            const n = readSync(fd, buf, got, len - got, from + got);
            if (n <= 0) break;
            got += n;
        }
        const lastNl = got > 0 ? buf.lastIndexOf(0x0a, got - 1) : -1;
        if (lastNl < 0) return { ops: [], consumed: from }; // 连一行都还完整不了
        const text = buf.subarray(0, lastNl + 1).toString("utf-8");
        const ops: Op[] = [];
        for (const line of text.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
                ops.push(JSON.parse(t) as Op);
            } catch (e) {
                console.warn(`[local-agent] 跳过无法解析的 jsonl 行 ${fp}:`, String(e).slice(0, 120));
            }
        }
        return { ops, consumed: from + lastNl + 1 };
    } finally {
        closeSync(fd);
    }
}

/** 读 `[from, to)` → fold → compact（**定长区间**：上滚取的那一段，不走增量缓存）。 */
function foldRange(fp: string, from: number, to: number): Op[] {
    const ops = from < to ? readOpsRange(fp, from, to).ops : [];
    const store = new BlockStore();
    for (const op of ops) store.apply(op);
    return compactOps(store);
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
    return sessionFileForWrite(taskUri, "compact");
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

/**
 * 块树 → 规模快照（messages 用真实投影，bytes 用 JSON 字节 —— 与真发口径一致）。
 * ⚠️ 收 **store** 而不是 op 数组（##321）：调用方（`planCompact`）手里已经有折好的块树，
 *    再让它按 op 重建一遍 = 对同一份会话白折一次（78MB 会话实测每次 ~1.3s，两处叠加）。
 *    `blocksToMessages` 只读块树（不回写），故复用安全。
 */
function sizeOfStore(store: BlockStore, opts?: Parameters<typeof blocksToMessages>[1]): SizeSnapshot {
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
function optsFor(policy: CompactPolicy, taskUri: string, collect?: ClippedToolDetail[], keep?: readonly KeepStage[] | null): DeliveryOpts {
    // 管道来自**当前配置**（config / history 分离：投递只读当前配置）—— 每个调用点都现读一次，
    // 于是「改配置本轮即生效」对 `history.keep[]` 与预算**同一条**（无需压缩事件、无需重启）。
    // `keep` 显式传入 = 调用方手里已有那一刻的配置（记账要快照，见 planCompact）。
    const specs = keep !== undefined ? keep : loadAutoCompact(diyHome()).history?.keep;
    return {
        ...makeDeliveryTransform(policy, (id) => toolOutRelPath(taskUri, id), collect),
        // 推理的全局回落（##374 T2）：与工具侧的 `defaultClip` 对称 —— 级没声明 `reasoningClip`
        // 就回落它（不然「不声明 ⇒ 不裁」，与工具轴反着来且静默多花字节）
        defaultReasoningClip: DEFAULT_REASONING_CLIP,
        plan: keepStagesToPlan(specs, budgetBytesOf(policy), clipSpecOf(toolResultOf(policy))),
    };
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
    /** 这次用的 plan 快照（##344 M2；##378 起只含**版本指针** + 标量，不含 keep 全文） */
    planSnapshot: CompactPlanSnapshot;
    /** 这次实际生效的级列表（**只在本进程内用**：入链 / 补录要写全文，不进事件账） */
    planKeep: readonly KeepStage[];
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

/**
 * bash 输出缓冲上限（**内存护栏，不是截断策略**）。
 *
 * 旧值是 1MB 且触顶＝**静默**截断（`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，模型与用户都拿不到信号）。
 * 现在两件事分开：① 上限提到 32MB —— 够装下正常的大输出，好让**投递层**落盘的是**完整**原文
 * （否则「原文可回取」取回的是个半截）；② 触顶**显式**识别（见下面 err.code 分支），
 * 与成功/报错**走同一条**投递截断路径（`capToolOutput`）。
 */
const BASH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * bash 执行结果的**语义档**（##353：工具行 ✓/✗ 的口径真源）。
 *
 * `failed` = 这一行该画 ✗（execute 据此抛错 → SDK 发 tool-error → ops `status:"error"`）。
 * 判据只看「命令跑起来了没有」这一条主线（##332）＋「有没有错误输出」（##353 复议 ##332 ①）。
 */
interface BashRun {
    /** 回喂模型 / 落 ops 的**完整**文本（不在这里裁：投递层 `capToolOutput` 现算，##127） */
    text: string;
    /** 是否应标失败（✗）。判据见 runBash。 */
    failed: boolean;
}

/**
 * 子进程的错误形状（##332 ③ 的判据落点）。
 *
 * 只用一个类型服务两条到达路径（callback / 同步抛），判据也只有一处读它：
 * **`code` 是数字** ⇒ 命令跑起来了（退出码）· **字符串** ⇒ spawn 层失败（ENOENT/EACCES/ENOTDIR…）。
 */
type BashExecError = { name?: string; code?: string | number | null; killed?: boolean; message?: string } | null;

/**
 * 杀**整个进程组**，不只是直接子进程（##375）。
 *
 * 前提是子进程以 `detached: true` 起（= `setsid`）：组 id 就等于它的 pid，于是 `-pid` 一发
 * 带走命令树上的所有活口 —— `bash -c "sleep 1"` 里真正在跑的 `sleep`、后台子壳、管道各段。
 * 不加 detached 就杀不了组（`-pid` 不是组 id ⇒ ESRCH），所以两者是一对，改一个必须改另一个。
 *
 * SIGKILL 而非 SIGTERM：取消是"立刻停"，不给忽略/捕获 TERM 的脚本留活口（Node 在 abort 时
 * 已先给直接子进程发过 SIGTERM；我们补的是"连子孙一起、且不给商量"）。
 * ESRCH（组已空）/ EPERM 都无害 —— 想杀的都已经不在了。
 */
function killProcessGroup(child: ChildProcess): void {
    if (child.pid == null) return;
    // ⚠️ 已收尸就不再动它：pid 是**可复用**的，此时 `-pid` 可能指向一个毫不相干的进程组
    //    （取消信号比命令活得久是常态 —— 用户可能在这条命令早就跑完之后才点停止）。
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        // 组已空（子进程全收）或 pid 已回收：无可杀
    }
}

/**
 * bash：30s 超时；**命令跑起来了**的失败以文本回喂模型（错误是一等信息，不抛），
 * **命令没跑起来**的（spawn / IO 失败）则抛。
 *
 * ── ##353 复议（##332 ① 档）：「非零退出」不再一律当数据 ──
 *   ① **命令级非零退出**（`err.code` 是数字 ⇒ 命令确实跑起来了）：
 *        · **有错误输出**（stderr 非空）⇒ **失败**（`failed: true`：命令报了错，✗ 且恒展开）；
 *        · **无错误输出** ⇒ **数据**（`grep`/`fd`/`rg`/`test` 未命中 = 退出 1 且静默 —— 这不是
 *          "失败"，是"没查到"；模型仍靠 `[退出码 N]` 改命令 ⇒ 保持 ✓）。
 *        · 正文一律 `[退出码 N]` + 输出，**不再兜底塞 `err.message`**：`Command failed: /bin/bash -c …`
 *          正是「✓ + Command failed」自相矛盾的来源（无输出时把 Node 的报错文案当成了命令输出）。
 *   ② **超时 / 取消**（`err.killed` / AbortError）⇒ 当数据（**保持现状**，见 ##332 ②）——
 *      **取消另有"真杀"这一半（##375）**：AbortError 只保证**直接子进程**（`/bin/bash`）被 kill，
 *      命令真正干活的那一层（`bash -c "sleep 1"` 的 sleep、后台子壳、管道各段）是它的子孙，
 *      Node（含 execFile 的 `timeout`）不会碰 ⇒ 取消后"命令照跑满"。故本函数把 bash 放到
 *      **自己的进程组**（`detached`），取消 / 超时 / 输出溢出三种"我们主动杀"的时刻都按组补
 *      一刀 SIGKILL（见 killProcessGroup）—— 三处原本是同一个孤儿缺口；
 *   ③ **spawn / IO 失败**（`err.code` ∈ ENOENT / EACCES / ENOTDIR…，**数字之外**）⇒ **失败**（##332）：
 *      这不是"命令报了错"，是**命令根本没跑起来**（cwd 不存在 / 不可进入、`/bin/bash` 缺失）——
 *      它没有退出码可言，也不该当结果。正文 `[命令未能启动 <code>] <Node 原文>（工作目录：…）`；
 *      带 cwd 是因为 Node 的 message（`spawn /bin/bash ENOENT`）会把"目录进不去"掩盖成"bash 不在"。
 *      ⚠️ 判据分界只有一条：**`err.code` 是数字 = 命令跑起来了（① 档）；否则 = 没跑起来（③ 档）**。
 *      ⚠️ 两条到达路径都要接住：`err.code` 非数字的 **'error' 事件**，和 spawn 的**同步抛**
 *      （cwd 是普通文件 ⇒ ENOTDIR，Node 在 spawn 内直接 throw、**不走 callback**；实测 node 24）。
 *    对照：`read` 的 execute 特意**相反**（读不到就抛），见 buildTools 里 read 的注释。
 */
function runBash(command: string, cwd: string, limits: LocalAgentLimits, signal?: AbortSignal): Promise<BashRun> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve({ text: "[已取消]", failed: false });
            return;
        }
        /** abort 补刀的注销器（settle 时解绑，避免监听器随轮次泄漏） */
        let offAbort: (() => void) | undefined;
        /** 超时定时器（settle 时清掉） */
        let timeoutId: NodeJS.Timeout | undefined;
        /** 全部结局只在这里落一次（成功 / 各失败档）；'close'/'error'/取消/同步 catch 共用同一判定 */
        const settle = (err: BashExecError, stdout: string, stderr: string): void => {
            offAbort?.();
            offAbort = undefined;
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = undefined;
            }
            const out = [stdout, stderr].filter(Boolean).join("\n");
            // ⚠️ 这里一律返回**完整**文本（不 clip）：发给模型的那一份由 `capToolOutput` 在
            //    投递层现算（##127）—— 在 execute 里裁 = 落进 ops 的原文当场丢。
            if (err?.name === "AbortError") resolve({ text: "[已取消]", failed: false });
            else if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || err?.code === "ENOBUFS")
                resolve({
                    text: `[输出超过 ${fmtBytes(BASH_MAX_BUFFER_BYTES)} 上限，命令已终止；以下是已收到的部分]\n${out}`,
                    failed: false,
                });
            else if (err?.killed) resolve({ text: `[命令超时被杀]\n${out}`, failed: false });
            else if (typeof err?.code === "number")
                // 命令级非零退出（##353）：有 stderr = 失败，无 stderr = 查询未命中（数据）
                resolve({ text: `[退出码 ${err.code}]\n${out || "(无输出)"}`, failed: stderr.trim().length > 0 });
            else if (err)
                // spawn / IO 失败（##332 ③）：命令**根本没跑起来** —— 失败档（execute 据此抛错）
                resolve({
                    text: `[命令未能启动 ${typeof err.code === "string" ? err.code : "?"}] ${err.message ?? ""}（工作目录：${cwd}）${out ? `\n${out}` : ""}`,
                    failed: true,
                });
            else resolve({ text: out || "(无输出)", failed: false });
        };
        try {
            // ⚠️ 为什么不用 execFile（##375 实测，别改回去）：`execFile` 把选项**白名单**转发给
            //    spawn（node 24 `lib/child_process.js`：只传 cwd/env/gid/shell/signal/uid/
            //    windowsHide/windowsVerbatimArguments）—— **`detached` 被静默丢掉**，于是
            //    "detached + 杀进程组"这条修法在 execFile 下失效（实测：pgid 仍是父进程那个组，
            //    `kill(-pid)` 当场 ESRCH，子孙照样跑满）。要进程组就只能自己 spawn，并顺手接住
            //    execFile 原本代劳的那几件事（攒输出 / maxBuffer / 超时 / 错误形状）——
            //    形状与 execFile **逐字段同构**，判据仍只有 settle 那一处。
            const child = spawn("/bin/bash", ["-c", command], { cwd, detached: true });
            // 输出按**块**攒（不逐块拼字符串）：上限判据只要长度计数，逐块 `byteLength` 是 O(n²)
            const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
            const len = { out: 0, err: 0 };
            const dump = (side: "out" | "err"): string => Buffer.concat(chunks[side], len[side]).toString("utf8");
            /** 结局是否已落（Promise 本身只认第一次，这里只是别再做无用功 / 别多杀） */
            let done = false;
            /** 我们主动杀的（超时 / 输出溢出）—— 对应 execFile 的 `killed` */
            let killed = false;
            const finish = (err: BashExecError, o: string, e: string): void => {
                if (done) return; // settle 内部（唯一落点）负责解绑 abort 监听与超时定时器
                done = true;
                settle(err, o, e);
            };
            /** 攒输出 + 上限（与 execFile 同口径：stdout / stderr **各算各的**，超了即杀、留已收到的部分） */
            const onData = (chunk: Buffer, side: "out" | "err"): void => {
                if (done) return;
                const keep = BASH_MAX_BUFFER_BYTES - len[side];
                chunks[side].push(keep >= chunk.length ? chunk : chunk.subarray(0, keep));
                len[side] += Math.min(chunk.length, keep);
                if (len[side] < BASH_MAX_BUFFER_BYTES) return;
                killed = true;
                killProcessGroup(child); // 溢出也杀整组（原先 execFile 只杀直接子进程）
                finish({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, dump("out"), dump("err"));
            };
            child.stdout?.on("data", (c: Buffer) => onData(c, "out"));
            child.stderr?.on("data", (c: Buffer) => onData(c, "err"));
            // spawn 层失败（ENOENT / EACCES…）：execFile 把它转成 callback 的 err，这里接 'error' 事件。
            // 同步抛（cwd 是普通文件 ⇒ ENOTDIR）两条路都到不了这里，由外层 catch 接（见下）。
            child.on("error", (e: NodeJS.ErrnoException) => finish({ code: e.code, message: e.message }, dump("out"), dump("err")));
            // 收尾唯一入口：'close'（stdio 全关之后）——与 execFile 同一事件，输出不会截尾。
            child.on("close", (code) => {
                if (code === 0) finish(null, dump("out"), dump("err"));
                else
                    finish({ code, killed, message: `Command failed: /bin/bash -c ${command}` }, dump("out"), dump("err"));
            });
            // 超时：自己计时（不用 execFile 的 timeout —— 它只杀直接子进程，同一类孤儿缺口）
            timeoutId = setTimeout(() => {
                killed = true;
                killProcessGroup(child);
            }, limits.bashTimeoutMs);
            if (signal) {
                // 取消（用户停止 → ctrl.abort）：**先**钉 AbortError 结局、**再**杀整组。
                // 顺序有意：这是一条"肯定结束了"的路径，不必等 close 事件（组杀完 close 才到，
                // 中间那段 UI 会显示"还在跑"）；而杀组要在 bash 还活着时发，组 id 才有效。
                const onAbort = (): void => {
                    finish({ name: "AbortError", code: "ABORT_ERR", message: "The operation was aborted" }, dump("out"), dump("err"));
                    killProcessGroup(child);
                };
                signal.addEventListener("abort", onAbort, { once: true });
                offAbort = () => signal.removeEventListener("abort", onAbort);
            }
        } catch (e) {
            // ⚠️ **同步抛是真实路径**，不是防御性代码：cwd 是普通文件时 Node 在 spawn 内直接
            //    `throw new ErrnoException(err, "spawn")`（code=ENOTDIR），**不走 callback**（实测 node 24）。
            //    漏接这条 catch 的后果不是"错误被吞"（executor 抛 = Promise reject，结果同向也是 ✗），
            //    而是文案只剩裸 `spawn ENOTDIR`、落不进本函数的统一口径（带 cwd 的失败文案）。
            settle(e as BashExecError, "", "");
        }
    });
}

export function buildTools(cwd: string, limits: LocalAgentLimits, taskUri: string) {
    return {
        bash: tool({
            description: "在项目目录执行 bash 命令并返回输出（查文件、跑命令、看系统信息）。",
            inputSchema: z.object({ command: z.string().describe("要执行的 bash 命令") }),
            // ##127：单条工具输出的截断**只落投递层** —— `toModelOutput` 改写「发给模型的那一份」
            // （超 2000 行 / 50KB 时头尾 + marker + 原文落盘可 read 回取），`execute` 的返回值
            // 仍是全文（落进 ops 的原文永不动）。见 services/tool-output.ts。
            toModelOutput: ({ toolCallId, output }) => ({
                type: "text" as const,
                value: capToolOutput(String(output), toolCallId, taskUri).text,
            }),
            execute: async ({ command }, opts) => {
                const home = diyHome();
                // 自杀护栏（agent-guard.ts）已停用（2026-10-02）：
                // 判据是命令文本，无法区分「宿主进程」与「agent 自己起的实例」——
                // 实测两类误拦（同 pgid、命令行含 main/index.mjs）把本仓库任意
                // worktree/测试实例都算宿主家人，连 agent 收自己起的实例都被拒。
                // 恢复方式：还原本处调用 + import（模块与单测均保留，见 agent-guard.ts）。
                // 现仅保留 write-ahead 审计：先落盘再执行，保证最后一幕不丢
                appendAudit(home, { phase: "bash-start", taskUri, cwd, command });
                const t0 = Date.now();
                const run = await runBash(
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
                    result: clip(run.text, 500),
                });
                // **抛，不 return**（##353，与 read 的 ##329 同口径）：catch-and-return 的字符串是
                // **正常工具结果** → SDK 走 tool-result 分支 → patch status:"done" → UI 画 ✓（就是
                // 「✓ + Command failed」那种自相矛盾）；抛出 → SDK 发 tool-error → status:"error"
                // → ✗ 且恒展开。失败文案随 error.message 落进 ops —— 模型侧照旧看得到（它要靠
                // 退出码/诊断改命令）。判据（① 非零退出 + 有错误输出 · ③ spawn/IO 失败）全在 runBash 头注。
                if (run.failed) throw new Error(run.text);
                return run.text;
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
                    // **抛，不返回字符串**（##329）：catch-and-return 的返回值是**正常工具结果**，
                    // SDK 走 tool-result 分支 → patch status:"done" → UI 画 ✓、且失败块不自动展开
                    // —— 失败只躺在折叠正文里（模型看得见，用户看不见）。
                    // 抛出 → SDK 发 tool-error → status:"error"（UI 画 ✗ 并自动展开）。
                    // ⚠️ 别改回 return：read **读不到就是失败**（catch 里返字符串 = 把失败包成
                    //   "正常结果" → status:"done" → ✓ 且不展开，就是 ##329 的形态）。
                    //   与 bash 的判据**不同向**，别互相抄（bash 侧 ##353 复议过）：bash 只在
                    //   **非零退出且有错误输出**时才抛（无输出的非零退出 = 查询未命中，是数据；
                    //   超时/取消仍当数据，模型靠退出码改命令；**spawn/IO 失败也抛**（##332 ③ 已落地，
                    //   判据：`err.code` 非数字 = 命令没跑起来）。
                    //   read 则「读不到就是失败」：目标文件不存在没有"信息"可给，只有"这一步没做成"。
                    //   ⚠️「bash.execute 现在会抛」≠「它见错就抛」—— 判据细节全在 runBash 头注。
                    throw new Error(`[读取失败] ${e instanceof Error ? e.message : e}`);
                }
            },
        }),
        /**
         * `compact_plan` —— 装配管道（plan）的**手**（##362 M3a）。
         *
         * 为什么是**单工具带 op** 而不是三个：三者共用同一份「全局配置 + 闸」语义，工具描述只写一遍
         * （每个工具都占 prompt 预算）；调用方看到的是一件事「装配管道」而不是三个散命令。
         * execute 不含任何 plan 逻辑 —— 一律走 `services/compact-plan-io`（与 RPC **同一实现**）：
         * 「CLI 校验通过、工具绕过校验」这类分叉必现，不能两处各写。
         */
        compact_plan: tool({
            description:
                "读/校验/改写「历史装配管道」（plan）—— 它决定哪些历史消息发给模型。" +
                "**这是全局配置：改动影响所有任务、所有 agent 的投递**。" +
                "op=get 读当前生效 plan（含来源与预算）；op=check 校验一份级列表（可传 keep，缺省校验盘上配置）；" +
                "op=set 写 history.keep[]（需用户在配置里开 history.allowAgentWrite=true，否则返回「没权限」而非报错）；" +
                "op=versions 列出 plan 版本链（只读，恒可用）；op=version 看某一版全文（只读）；" +
                "op=restore 回滚到**某一版**（缺省上一版；也兼容旧时间戳快照 id；回滚本身也可回滚）；" +
                "op=reset 一键回**出厂缺省** plan（删 history.keep[]；**不依赖任何版本/快照的逃生窗口** —— 链全坏时用它）。" +
                "级列表形状：`[{ type: ladder|role|recent|steps, must?, limit?, clip?, data }]`，从上往下生效（先声明的先挑）。",
            inputSchema: z.object({
                op: z.enum(["get", "check", "set", "restore", "reset", "versions", "version"]).describe("要做什么"),
                keep: z
                    .string()
                    .optional()
                    .describe('op=check/set：级列表文本（YAML 或 JSON；数组，或 `{ keep: [...] }`）'),
                version: z
                    .string()
                    .optional()
                    .describe("op=version/restore：版本 id（`plan-<sha12>`；restore 也兼容旧快照 id）；缺省 = 上一版"),
                snapshot: z.string().optional().describe("op=restore：旧参数名（= version；仅为兼容保留）"),
            }),
            execute: async ({ op, keep: keepText, version, snapshot }) => {
                const home = diyHome();
                // must 层实占字节要**量**（预算是管不到 must 的）—— 与 RPC 注入的是同一测量
                const measure = (k: KeepStage[]): { mustBytes: number; hardCapBytes: number } =>
                    getLocalAgent().measureMustStages(taskUri, k);
                if (op === "get") return renderPlanView(planGet(home));
                // 只读两条（versions / version）**恒可用** —— 不受 allowAgentWrite 闸约束（同 get / check）
                if (op === "versions") {
                    const v = planVersions(home);
                    return `${renderPlanVersionsView(v)}\n${PLAN_SCOPE_NOTE}。`;
                }
                if (op === "version") {
                    if (!version) throw new Error('op:"version" 需要 `version`（`plan-<sha12>`；见 op:"versions"）');
                    const v = planVersionView(home, version);
                    if (!v) throw new Error(`版本不存在：${version}（见 op:"versions"）`);
                    return `${renderPlanVersionView(v)}\n${PLAN_SCOPE_NOTE}。`;
                }
                if (op === "check") {
                    // 校验**不抛**（ok=false 也是有用信息）—— 与 set 的"写错就抛"不同向，理由见 compact-plan-io 头注
                    return renderCheckView(planCheck({ home, taskUri, ...(keepText !== undefined ? { keepText } : {}), measure }));
                }
                if (op === "set") {
                    if (!keepText || keepText.trim() === "") {
                        throw new Error('op:"set" 需要 `keep`（级列表文本：YAML/JSON 数组，或 `{ keep: [...] }`）');
                    }
                    // 闸关 ⇒ 本调用返回**拒绝文本**（不抛）；非法 plan ⇒ 抛（那是模型写错了，该看到错在哪）
                    return planSet({ home, taskUri, via: "agent", keepText, measure }).text;
                }
                if (op === "reset") return planReset({ home, taskUri, via: "agent" }).text;
                return planRestore({
                    home,
                    taskUri,
                    via: "agent",
                    ...(version ? { version } : {}),
                    ...(snapshot ? { snapshot } : {}),
                    measure,
                }).text;
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

/**
 * 人物显示名（「模型不可用」bar 上要写清"谁在用这个模型"，用户据此知道去改哪个人物）。
 * 查不到就退化回 id —— 文案查询失败不该连带把提示丢掉（宁可显示 id 也别静默）。
 */
function personaDisplayName(id: string): string {
    return personaByIdOrName(diyHome(), id)?.name ?? id;
}

/**
 * 判「这次失败是不是模型不可用」，是就推一条顶栏通知（##369 ①）。
 *
 * 判据是纯函数（shared/model-unavailable，表驱动单测）：命中四类（未上架 / id 不认识 /
 * 认证失败 / 配额）才推；上游 5xx 与网络超时**不推** —— 那两类混进来会让 bar 天天亮
 * （告警疲劳），且用户该做的动作完全不同（该等，不是该配模型）。
 *
 * 认知边界：真发的错误有**两条**产生路径（流内 `error` part 与抛异常），用户看起来
 * 都是"一条错误块"，故两处都要过这个函数 —— 只在 catch 里做会漏掉最常见的那条
 * （实测 `[model_coming_soon]` 走的是流内 error part）。
 */
function reportModelUnavailable(e: unknown, taskUri: string, personaId: string, model: string): void {
    const n = noticeFromError(e, {
        taskUri,
        personaId,
        personaName: personaDisplayName(personaId),
        model,
    });
    if (n) modelNoticeHub.push(n);
}

// ─── 服务 ────────────────────────────────────────────

/** L1 状态扫描的尾部窗口（op 条数）：**当前进度必在尾部**，不必扫全量（见 currentAction） */
const ACTION_SCAN_OPS = 4000;

/**
 * 未闭合块同时存在时，谁的语义更"当前"（index 越小越优先）。
 *
 * 依据：轮在跑时 turn / step / think / tool 会**同时**处于未闭合态（turn 一直开到轮末），
 * 只按插入序取最后一个会得到"轮次收尾中"这种含糊话；按语义取最具体的才像人话。
 * error 最高（出错时它在说最后一件事）。
 */
const ACTION_PRIORITY: BlockKind[] = ["error", "tool", "think", "text", "plan", "step", "turn"];

/**
 * 「此刻在干什么」的一句话（L1 状态的文案）。
 *
 * 为什么文案在**服务端**生成（##166 第三轮口径第 3 条：服务端能给，不靠 UI 猜）：
 * 会话的块语义（tool / think / text / step）只有 main 侧知道，UI 拿到的只是一棵块树；
 * 让每个消费端各自写一套"从块树推文案"的逻辑，就是**第二份真源**。
 * 这里给一句人话，UI 只负责显示。
 */
export function actionLabel(kind: BlockKind, fields: Record<string, unknown>): string {
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const clip = (s: string, n = 48): string => (s.length > n ? `${s.slice(0, n)}…` : s);
    switch (kind) {
        case "tool": {
            const tool = str(fields.tool) || "工具";
            const title = str(fields.title);
            return clip(title ? `${tool} · ${title}` : tool);
        }
        case "think":
            return "正在思考";
        case "text":
            return "正在写回答";
        case "step":
            return "模型步进行中";
        case "turn":
            // 实测（2026-10-18）：第 1 步**等模型响应**期间，op 流里只有 turn 是未闭合的
            // （step 的 start 要等这一步真的开始跑）—— 此刻说"收尾中"是假话，说"进行中"才诚实。
            return "轮次进行中";
        case "plan":
            return "正在列计划";
        case "error":
            return "出错收尾中";
        default:
            return kind;
    }
}

export class LocalAgentManager {
    private sessions = new Map<string, LocalSession>();
    /**
     * 插话队列（「插入到下一步 / 下一次对话后」）。
     *
     * 权威落盘在任务目录 .diy/drafts.yaml（与聊天草稿同文件、同类数据：都是"丢了 = 用户白打"），
     * 因此重启应用、切 Electron/serve 模式后队列仍在；本对象只是无状态门面（每次现读盘）。
     */
    private queue = new SteerQueue(fileSteerPort, () => this.getLimits().maxSteerQueue);
    /**
     * provider 实例缓存，按 `baseUrl|key` 分组（一个 provider 可能配多个账号 → 多实例）。
     * chat 面（/chat/completions）与 responses 面（/responses）各一，key 同生命周期。
     */
    private providers = new Map<string, { chat: ReturnType<typeof createOpenAICompatible> | null; resp: ReturnType<typeof createOpenAI> | null }>();
    /**
     * 会话历史的折叠缓存（per task **+ 窗口起点**）：已消费字节 + 前 4KB 指纹 + 增量 fold 出的块树。
     *
     * 为什么必须有：主进程是单线程，全量重放 74MB 会同步阻塞 ~1s 卡住所有 RPC
     * （含别的任务）。而轮末每次 append 只加一点点 —— 缓存后每轮成本 = **尾部大小 + O(块数)**。
     * 上限 HISTORY_CACHE_MAX（LRU）：块树常驻内存，不能无界堆积。
     */
    private historyCache = new Map<string, { start: number; consumed: number; prefix: string; store: BlockStore }>();
    private _limits: LocalAgentLimits | null = null;
    /**
     * 在跑的轮次（taskUri → TurnRun）：**轮次的唯一真源**（#305 起不再借道生成器寿命）。
     * 它同时是「同 task 已有轮次在跑」的判据（据此改为**排队**，##306；原 `sess.running`）与消费端订阅者的挂载点。
     */
    private turns = new Map<string, TurnRun>();

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
        // 注册表（##240）的活态属性取值器：viewers 只由**内容**订阅者构成（R3 —— 注册表自身的
        // 订阅者不许计入，否则注册表一开全库会话都显示"有人看"）；queue = 待投递留言条数。
        // 这里是注册表缺省取值器的**超集**（多算 chat 流订阅者 `run.subs`）；manager 未构造时
        // 注册表退回缺省（直查 ops-feed）——照样数得出来（review1 P2-1 缺口 C）。
        sessionRegistry.setDeps({
            viewersOf: (uri) => this.watchers(uri),
            queueOf: (uri) => {
                try {
                    return this.queue.list(uri).length;
                } catch {
                    return 0; // 队列读盘失败不能让注册表崩（它只是"此刻的事实"，不是权威落盘）
                }
            },
        });
    }

    /**
     * 按 API 面取语言模型：一个 provider（baseUrl+key）一组实例，面决定路径
     * （/chat/completions vs /responses，见 shared/models.ts 的 api 面注释）。
     * chat 面走 openai-compatible，responses 面走 @ai-sdk/openai 的 responses API。
     */
    private modelFor(m: ResolvedModel, key: string): LanguageModel {
        if (this.modelResolver) return this.modelResolver(m.id, key);
        const baseUrl = resolveBaseUrl(m);
        const ck = `${baseUrl}|${key}`;
        let entry = this.providers.get(ck);
        if (!entry) {
            entry = { chat: null, resp: null };
            this.providers.set(ck, entry);
        }
        if (m.api === "responses") {
            entry.resp ??= createOpenAI({ name: m.provider, baseURL: baseUrl, apiKey: key });
            return entry.resp.responses(m.id);
        }
        entry.chat ??= createOpenAICompatible({ name: m.provider, baseURL: baseUrl, apiKey: key });
        return entry.chat(m.id);
    }

    /**
     * 发请求前登记归属 —— 流量观测（undici diagnostics_channel，见 core/traffic.ts）靠
     * 请求头里的 `x-opencode-session` 反查「这条记录属于谁」，因此每次真发（streamText /
     * generateText）前必须登记一次：同时把 attempt 计数归零（重试即自增）。
     */
    private noteTraffic(taskUri: string, turnId: string, rm: ResolvedModel, maxRetries: number): void {
        traffic.noteRun({
            session: sessionIdOf(taskUri),
            taskUri,
            turnId,
            provider: rm.provider,
            model: rm.id,
            baseUrl: resolveBaseUrl(rm),
            maxRetries,
        });
    }

    /**
     * 解析「人物/覆盖里写的模型引用」→ 运行时模型 + 密钥。
     * 未知名一律 fail-fast；密钥未配置也 fail-fast（不静默换模型、不拿空 key 发请求）。
     * 例外：注入了 `modelResolver`（单测桩模型）时跳过密钥解析 —— 桩模型不出网，无需 key。
     */
    private resolveModel(modelRef: string): { rm: ResolvedModel; key: string } {
        // 人物 model 为空 = 还没配模型（应用首次启动无 provider）：给出可操作的指引。
        if (!modelRef) throw new Error("未配置模型：请先在「模型 provider 配置」添加 provider，并在人物里选择模型");
        const rm = findModel(modelRef);
        if (!rm) throw new Error(`未知模型 ${modelRef}（可选：diy agent local models）`);
        return { rm, key: this.modelResolver ? "" : resolveModelKey(rm) };
    }

    /** 读 $DIY_HOME/local/limits.json（不存在/解析失败 → null，交由 resolveLimits 逐级回退） */
    private readLimitsFile(): Partial<LocalAgentLimits> | null {
        try {
            if (existsSync(limitsFile())) {
                return JSON.parse(readFileSync(limitsFile(), "utf-8")) as Partial<LocalAgentLimits>;
            }
        } catch (e) {
            console.warn(`[local-agent] limits.json 解析失败，用默认值:`, e);
        }
        return null;
    }

    /**
     * 生效限制：首次使用读 limits.json 并缓存（与 zen key 同生命周期语义）。
     * ⚠️ 缓存**必须**由 `setLimits` 显式失效，否则页面改了不生效（反直觉坑，##240）。
     */
    getLimits(): LocalAgentLimits {
        if (!this._limits) {
            this._limits = resolveLimits(this.readLimitsFile());
            console.log(`[local-agent] 生效运行限制: ${JSON.stringify(this._limits)}`);
        }
        return this._limits;
    }

    /**
     * 写运行限制（##240 第 3 项）：patch 合并进 `$DIY_HOME/local/limits.json`，并**立即失效缓存**。
     *
     * 语义：**下一轮生效** —— 在跑的轮次用的是它起跑时读到的值（`runTurn` 开头 `getLimits()` 一次），
     * 本轮不中途换挡（换挡会让同轮前后步数口径不一致）。
     *
     * 优先级提醒：环境变量 `DIY_LOCAL_*` **高于**文件（见 resolveLimits）；若某字段被环境变量
     * 钉死，写文件对它无效 —— 返回值是合并后的**生效值**，调用方以它为准即可发现。
     */
    setLimits(patch: Partial<LocalAgentLimits>): LocalAgentLimits {
        const merged: Partial<LocalAgentLimits> = this.readLimitsFile() ?? {};
        for (const [k, v] of Object.entries(patch) as [keyof LocalAgentLimits, unknown][]) {
            // 非法值忽略（不写坏文件）：与 resolveLimits 同一判据（有限正数）
            if (typeof v === "number" && Number.isFinite(v) && v > 0) merged[k] = v;
        }
        writeFileAtomic(limitsFile(), `${JSON.stringify(merged, null, 2)}\n`);
        this._limits = null; // 失效缓存：下一次 getLimits() 现读（含新值）
        return this.getLimits();
    }

    // 【已移除】sinceTurnIdOf / deliveryOptsOf —— 旧"读压缩账边界"的投递口径。
    // 配置 / 历史分离后，投递口径一律取**当前配置**（见 deliveryHistory / requestView），
    // 压缩账只作历史快照。（保留此说明，免得后来者又去找它们。）

    /**
     * 会话正在生成中：把新消息**入队**并回一条显式回执（##306）。
     *
     * 为什么必须给回执：调用方（CLI / UI / 另一个窗口）拿到的流若不产 op，用户就无从分辨
     * 「已排队」与「被吞了」—— 空流退出就是静默失败。回执走本模块的**单一权威路径**
     * （先整批落盘 + 收敛内存，再逐条投递），与插话上限分支同一纪律：流被 return 展开也不会
     * 留半截块。kind 用 error 只是因为 error 块**不参与 LLM 投影**（projectAll 不把它转成
     * 消息），免得这条机器回执被当成真实发言发给模型。
     *
     * 入队失败（队列满 / 空消息）直接抛出 —— 那是"这条消息没送达"，调用方必须知道。
     */
    private *enqueueWhileRunning(taskUri: string, sess: LocalSession, message: string, author?: string): Generator<Op> {
        // ⚠️ 这里**只接 author**（第 23 刀如实记）：投递走这条路的唯一情形是「会话正忙」的竞态窗口，
        //    而 `room-service` 已在投递前用 `isBusy` 挡掉（标 failed 不投）；真撞进这里时那条插话块
        //    没有 `meta.room`（只有 `meta.author`）—— 已知缺口，见 ##377 body 的边界节。
        // ⚠️ 语义是 **steer 合并**（并入正在跑的轮次序列、整批投），**不是**串行独立
        // 轮次排队 —— 与 review306 发现①对齐：入队后由续轮循环整批取走（见 chat 的轮末逻辑），
        // 多条排队消息 = 一次续轮请求消化，不逐条开轮。
        // 投递时机取 `DEFAULT_STEER_MODE`（现为 `next-step`，##360）：生成中再发消息，多数情形
        // 就是"立刻补一句 / 纠正"，故插进正在跑的轮次、下一个模型步边界前整批投。代价是它排在
        // 当前轮未说完的话前面（不再是"谁先说话谁先投"的严格顺序）—— 想"排在这一轮之后"的用户
        // 可在横条上把该条切回 `next-turn`（切换只改这条队列项的 mode）。
        const items = this.queue.add(taskUri, DEFAULT_STEER_MODE, message, undefined, author);
        sessionRegistry.noteActivity(taskUri); // queue 变化 → 注册表订阅方即时可见
        // items 的末条就是刚入队的那条（`add` 返回整批快照）
        const item = items[items.length - 1]!;
        const turnId = this.receiptTurnId(sess, item.id);
        const noticeId = `${turnId}_queued`;
        const ops: Op[] = [
            // `steerId` = 这条回执对应的队列条目（`steer/N`）：id 里已含，再落一份到 meta
            // 是为了让消费端（CLI / 后续 UI）不必**解析 id 字符串**就能回查该条队列项
            { op: "start", id: turnId, kind: "turn", meta: { source: "queue", steerId: item.id } },
            { op: "start", id: noticeId, kind: "error", parent: turnId, meta: { source: "queue" } },
            {
                op: "delta",
                id: noticeId,
                fields: {
                    message: `会话正在生成中：这条消息已排队（队列第 ${items.length} 条，投递时机：${steerModeLabel(DEFAULT_STEER_MODE)}）`,
                },
            },
            { op: "stop", id: noticeId },
            { op: "stop", id: turnId },
        ];
        const sink = this.opsSink(taskUri);
        for (const op of ops) {
            sink(op);
            sess.store.apply(op);
        }
        for (const op of ops) yield op;
    }

    /**
     * 排队回执轮的 id：`qt-` + 队列条目 id（`qt-steer/3`）—— 与队列条目**一一对应**，
     * 看 id 就知道是哪条排队消息（CLI / 日志 / UI 回查都靠它）。
     *
     * 为什么不只用条目 id：条目序号**在队列清空后从头来**（`newSteerId` 的既定语义：只保证
     * 队列内唯一，见 `steer-queue.ts` 头注），而回执轮一旦落进 ops.jsonl 就**长期留在史书里**。
     * 于是「投递完 → 再排一条」必然重发 `steer/1` → 撞上历史里那条回执轮：重放时 BlockStore
     * 对「重复 start」只记 issue 并**丢弃** start（`local-blocks.ts`），随后 notice 的 delta
     * 会累加到**上一集那条回执块**上（文案拼接），stop 提前闭合 —— 静默且难查（review2 发现 C）。
     * 故撞上已存在的块 id 时加序号后缀；判据是**块树里是否已有**（含重载后重放出来的历史块），
     * 跨重启也成立（不依赖会话内存，也不需要 Date.now 这种毫秒粒度的巧合）。
     */
    private receiptTurnId(sess: LocalSession, itemId: string): string {
        let id = `qt-${itemId}`;
        for (let n = 1; sess.store.blocks.has(id); n++) id = `qt-${itemId}_${n}`;
        return id;
    }

    /**
     * op 即传即落的落盘函数（存储 = 传输）：chat / 排队回执 / 加载自愈**共用的唯一落盘点**。
     *
     * 【为什么收敛成一处】落盘与广播必须成对（##307）：写侧 publish 让订阅方（UI 各窗口、
     * 其他 agent）即时看到增量，而 **publish 只能在 appendFileSync 成功之后** —— 落盘失败
     * 还广播，订阅侧水位就会超前于盘上文件，此后一切按行号的补发/去重全错。
     * 三份各自 append 的实现只要有一处漏 publish，症状就是「该来源的 op UI 永远看不见」，
     * 且只在特定路径（排队回执 / 崩溃自愈）复现 —— 所以只留这一份。
     */
    private opsSink(taskUri: string): (op: Op) => void {
        // ##379：写侧入口**建父目录**（分层落位下 `local/<uri>/<key>/` 可能还不存在）
        const fp = sessionFileForWrite(taskUri, "ops");
        return (op) => {
            try {
                appendFileSync(fp, `${JSON.stringify(op)}\n`, "utf-8");
            } catch (e) {
                // 落盘失败不阻断流，但必须出声（否则丢行不可观测）；**不 publish**（水位不许超前盘）
                console.error(`[local-agent] ops 落盘失败 ${fp}:`, e);
                // ⚠️ 于是这条 op 会**只 yield 不 publish** —— 消费侧（##307 起 UI 走 opsWatch 增量订阅，
                // ##327 起 chat 流不再 apply）因此看不见它。这是**自洽的**，不是缺陷：盘上没有的东西，
                // 重载后本来也会丢，显示它反而是假象（与「wire = 存储 = 渲染输入」同一取向）。
                return;
            }
            opsFeed.publish(taskUri, [op]);
        };
    }

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
    /**
     * 「残留收敛」op 批（幂等）：先补 tool 的业务终态（patch + stop），再补剩余结构开口（stop）
     * —— 前者已 stop 的块不会被后者重复处理（danglingStopPatches 只挑未 stop 的）。
     *
     * 两个时机共用同一批：**加载时**（convergeOnLoad，兜住被杀/崩溃的进程）与**开新一轮时**
     * （chat() 开场，兜住"进程活着但上一轮没闭合"）—— 自愈原先只挂在加载（每进程一次），
     * 于是开口轮能一直挂到主进程重启：生产实测跨 9 轮、挂了 6 天。
     */
    private healResidualOps(s: LocalSession): Op[] {
        return [...interruptedToolPatches(s.store), ...danglingStopPatches(s.store)];
    }

    private convergeOnLoad(taskUri: string, s: LocalSession): void {
        // 自愈补写的 op 也要走同一个 sink：它们同样是「会话内容」，UI 必须即时看见
        const sink = this.opsSink(taskUri);
        // 先补 tool 的业务终态（patch + stop），再补剩余结构开口（stop）—— 前者已 stop 的块
        // 不会被后者重复处理（danglingStopPatches 只挑未 stop 的）。
        for (const op of this.healResidualOps(s)) {
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
        const fp = sessionFileForWrite(taskUri, "llm");
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
            // 原子写（##382 收敛）：整份重建也是「整文件覆盖」，与 core/atomic-write.ts 同语义。
            // 注意**调用方**这里的 catch 仍是「降级返回 k」—— 那是重建路径的既有策略，非写侧行为。
            writeFileAtomic(fp, expect.map((l) => `${l}\n`).join(""));
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
        const fp = sessionFileForWrite(taskUri, "llm");
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
     * 已压缩 → 被省区间渲染成一段 **`history:` 索引注记**（纯数据，解释在 `help.history`），
     * 由调用方放进**尾部信封**（`withRuntime`）—— 见下 `HistoryDelivery.note`。
     * **messages 保持原样**（provider 最友好、前缀缓存不砸）：注记不再拼进历史里，
     * 免得被 `normalizeUserRuns` 并进某条 user 的正文（那是 ##310 八轮修掉的坑）。
     *
     * 行号口径：llm.jsonl 只增且**第 i 行 = 全量投影第 i 条**（加载时已对账/补齐），
     * 故此处用全量投影的序号当行号 —— 它是模型回取时的真实落点。
     */
    private deliveryHistory(
        taskUri: string,
        store: BlockStore,
        collect?: ClippedToolDetail[],
    ): HistoryDelivery {
        // 【配置 / 历史分离，用户 2026-10-07】投递口径 = **当前配置**（期望值），每次请求实时算 ——
        // 改预算**本轮即生效**。压缩账（compact.jsonl）只是**历史快照**（不可变，供回溯/对比），
        // 不再决定投递（旧实现读 `resolveBoundary` → 没压过就不生效，违反直觉）。
        const policy = loadAutoCompact(diyHome()).policy;
        return this.buildHistory(store, policy, collect, taskUri);
    }

    /** 面板参数预览用（给定 policy + 边界现算，不读生效账本）—— 与真发同一条构造链 */
    private deliveryHistoryForView(store: BlockStore, policy: CompactPolicy | null, taskUri: string): HistoryDelivery {
        return this.buildHistory(store, policy, undefined, taskUri);
    }

/**
     * 投递历史的**唯一构造**：原生投影 + 预算注记（注记**另作一段**，不拼进 messages）。
     * policy=null ⇒ 全量（未压缩，无注记）。
     */
    private buildHistory(
        store: BlockStore,
        policy: CompactPolicy | null,
        collect?: ClippedToolDetail[],
        /** 原文路径用（注记里的 file 字段）；view 路径与真发同一个 taskUri */
        taskUriOf = "",
    ): HistoryDelivery {
        const opts: DeliveryOpts = policy ? optsFor(policy, taskUriOf, collect) : {};
        const kept = blocksToMessages(store, opts) as unknown as ModelMessage[];
        if (!policy || !this.noteEnabled()) return { messages: kept, note: "" };
        // 预算注记：只列**保留区间**（gap 自明，不逐 gap 标注）
        const all = projectAll(store);
        const sel = selectHistoryByBudget(all, policy.modeData.budgetBytes, opts);
        const note = renderBudgetNote(
            {
                budgetBytes: policy.modeData.budgetBytes,
                keptBytes: sel.keptBytes,
                kept: sel.keptRuns,
            },
            { file: llmLogRelPath(taskUriOf), absPath: llmFile(taskUriOf) },
        );
        return { messages: kept, note };
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
     *   · windowTokens         —— 最后一步**实测**用量（最后一步 = 窗口占用，见 ##211 §三）的 token 数
     */
    autoCompactStatus(taskUri: string): {
        config: AutoCompactConfig;
        facts: AutoCompactFacts;
        triggers: CompactTrigger[];
        reasons: string[];
        /** 配置真源 `auto-compact.yaml` 的**原始全文**（含注释）—— 供 UI「原始配置」只读视图 */
        raw: { path: string; text: string };
        /** 读配置时的**出声条目**（##370）：非空 = 有键缺失/非法（已逐键回落缺省）。UI 据此说「为什么」 */
        warnings: AutoCompactIssue[];
    } {
        const { config, issues: warnings } = loadAutoCompactDetailed(diyHome());
        // 系统上下文：与上次真发那份比（口径与 steps.jsonl 的 systemText 完全一致）
        const home = diyHome();
        const globals = assembleGlobals(home, projectFromUri(taskUri), {
            taskUri,
            // 与真发同一条链（预览 = 会发出去的）：房间上下文取**本任务自己的房间**
            // （自起轮的形状；投递轮看的是来源房间，这里给不出，边上注明即可）
            room: roomRuntimeFact({ roomId: taskUri, taskUri })?.value ?? null,
        }) as unknown as Record<string, unknown>;
        const delivery = buildDelivery(globals, loadSystemPlaces(home));
        const lastStep = readDeliverySteps(taskUri).at(-1) ?? null;
        const systemContextChanged = lastStep !== null && lastStep.systemText !== delivery.system.text;

        const usages = readStepUsages(taskUri);
        const last = usages.at(-1) ?? null;
        const sinceLastRequestMs = last ? Date.now() - Date.parse(last.ts) : null;
        // 窗口占用（**token 数**）：口径 = 该会话**最后一步实测用量** `usage.total`（真实 token 数，
        // 最后一步 = 窗口占用，见 ##211 §三；用户 2026-10-15 拍板 token 域，见 ##268 §6.9 D7）。
        // 没有用量账（老会话 / 手工造的会话）→ null：**无实测不判**，不退回「投影字节」估算
        // （那是被用户否掉的"文字数"口径；估出来的 token 数只会误导触发时机）。
        const windowTokens = last ? bucketsOf(last.usage as UsageLike).total : null;

        const facts: AutoCompactFacts = {
            systemContextChanged,
            sinceLastRequestMs,
            ttl: this.effectiveTtlOf(taskUri),
            windowTokens,
        };
        const triggers = detectAutoCompactTriggers(facts, config);
        const raw = { path: autoCompactFile(home), text: readAutoCompactText(home) };
        return { config, facts, triggers, reasons: triggers.map((t) => TRIGGER_TEXT[t]), raw, warnings };
    }

    /**
     * 投递口径的历史消息（与真发同源：压缩边界 + 索引注记 + 工具输出裁剪）。
     * **只读**：自己 replay ops，不加载会话、不落盘 —— 预览用，不应有副作用。
     * （不能用 llm.jsonl：那是 append-only 的**全量**日志，含已被压掉的轮。）
     */
    deliveryMessages(taskUri: string): HistoryDelivery {
        const store = new BlockStore();
        for (const op of readJsonl<Op>(opsFile(taskUri))) store.apply(op);
        return this.deliveryHistory(taskUri, store);
    }

    /** 可选模型（去掉密钥等连接隐私字段，只下发元数据 + 限定名供 UI/CLI 展示） */
    listModels(): Array<Omit<ResolvedModel, "key" | "baseUrl" | "npm" | "kind">> {
        return getModelCatalog().map(({ key: _key, baseUrl: _b, npm: _n, kind: _k, ...meta }) => meta);
    }

    /**
     * 会话的 ops 视图（UI 重放）：**固定消息集合**，始终全量（压缩不隐藏历史，只过滤投递）。
     *
     * 返回的是**折叠后的等价 op 流**（见 local-blocks 的 compactOps）—— 对消费端完全透明：
     * 同一棵块树、同样的渲染结果，只是把逐 token 的碎片压成"每块一次 start + 终值 + stop"。
     * 一次 74MB / 877,050 op 的会话因此变成约 15MB / 1.8 万 op（-98%），
     * 读盘、RPC、渲染端 fold 三段的成本一起降下来（任务 290：大会话假死的治本点）。
     *
     * 【配置 / 历史分离】聊天页始终全显，压缩只体现在"发给模型的"与压缩面板里
     * （压缩是投递侧的**过滤**，不销毁、不隐藏）。旧实现按边界切片 → 预算的分散保留与之不吻合，已废。
     *
     * 增量：per task 缓存已 fold 的块树 + 已消费字节，只读新增尾巴（轮末 append 的代价 = 尾巴大小）。
     * 失效判据见下方 invalid —— 宁可把整份日志重放一遍，也绝不把两份文件的历史缝在一起。
     */
    history(taskUri: string): Op[] {
        return this.foldedOps(taskUri, opsFile(taskUri), 0);
    }

    /**
     * **一轮的块树**（##166 §28.7 A：room 要的「进度消息」= 对成员会话的**引用**，不新造数据源）。
     *
     * room 侧只存 `ref = { memberUri, turnId }`（`reply` 事件上）；真进度在这里 ——
     * 与任务对话**同一条 ops 流、同一次 fold**，渲染端拿回去走**同一个块渲染器**
     * （`LocalChatPage` 的 `TurnView`）。于是"room 里的进度"与"任务对话里的进度"字面同源。
     *
     * 成本：走 `history()` 那条折叠缓存 —— 同一会话第二次取只读新增尾巴（不是重读整份日志）。
     * 切片只 apply 本轮的 op（compactOps 的输出每块都显式带 parent，轮内自洽）。
     *
     * 找不到该轮（会话被清空 / compact 掉 / turnId 写错）⇒ `null`，UI 如实说"这一轮已不在会话里"。
     */
    turnNode(taskUri: string, turnId: string): BlockNode | null {
        const ops = this.history(taskUri);
        let from = -1;
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i]!;
            if (op.op === "start" && op.kind === "turn" && op.id === turnId) {
                from = i;
                break;
            }
        }
        if (from < 0) return null;
        const store = new BlockStore();
        for (let i = from; i < ops.length; i++) {
            const op = ops[i]!;
            // 下一轮的 start 即本轮的界（compactOps 按 children 递归输出，轮之间不会交错）
            if (i > from && op.op === "start" && op.kind === "turn") break;
            store.apply(op);
        }
        return toTree(store, turnId);
    }

    /**
     * 此刻在干什么（**L1 状态**：owner ##166 第三轮口径第 3 条 ——「正在跑哪一步 / 在做什么」）。
     *
     * 判据用块树的**官方口径**：同一轮内「当前进度」= **最后一个未 stop 的块**
     * （`Block.touched` 的头注，见 local-blocks）。这里不 replay 整棵树，只扫**尾部 op**
     * 维护一张"开了没关"的表 —— 当前进度必在尾部，扫 ACTION_SCAN_OPS 条足够，
     * 成本是 O(尾) 而不是 O(会话)（roster 会周期性调它，不能每次重放 1.8 万 op）。
     *
     * 返回 `null` = 没有未闭合的块（空闲 / 刚收尾 / 窗口切在块中间）。
     * **纯读**：不落盘、不改状态、不注册观察者（L1 是状态查询，不是内容订阅）。
     */
    currentAction(taskUri: string): { kind: BlockKind; label: string } | null {
        let ops: Op[];
        try {
            ops = this.history(taskUri);
        } catch {
            return null; // 会话不可读（不存在 / 盘上坏了）不是本读口的错 —— 如实说"不知道"，不抛
        }
        const open = new Map<string, { kind: BlockKind; fields: Record<string, unknown> }>();
        for (let i = Math.max(0, ops.length - ACTION_SCAN_OPS); i < ops.length; i++) {
            const op = ops[i]!;
            if (op.op === "start") open.set(op.id, { kind: op.kind, fields: {} });
            else if (op.op === "stop") open.delete(op.id);
            else {
                const e = open.get(op.id);
                if (e) Object.assign(e.fields, op.fields);
            }
        }
        // 未闭合块可能有好几个（turn / step / think …同时开着）—— 取**语义最具体**的那个：
        // 轮在跑但模型还没回话时，turn 与 step 都开着，此时"模型步进行中"比"轮次收尾中"诚实得多；
        // 跑工具时 tool 开着，就该说"正在 bash · …"。
        let best: { kind: BlockKind; fields: Record<string, unknown> } | null = null;
        for (const e of open.values()) {
            if (!best || ACTION_PRIORITY.indexOf(e.kind) < ACTION_PRIORITY.indexOf(best.kind)) best = e;
        }
        if (!best) return null;
        return { kind: best.kind, label: actionLabel(best.kind, best.fields) };
    }

    /**
     * 从 `start` 字节读到文件尾 → fold → compact。**全量与窗口共用这一条**（`start = 0`
     * 就是全量），于是「增量 fold」「缓存失效判据」「issue 出声」只有一份实现。
     *
     * 增量：per (task, start) 缓存已 fold 的块树 + 已消费字节，只读新增尾巴
     * （轮末 append 的代价 = 尾巴大小）。缓存按键含 `start`：**不同窗口起点是不同的树**，
     * 共用一条会被互相冲掉（尾部窗口的起点固定 ⇒ 轮末刷新稳定命中同一条）。
     *
     * 失效判据（任一破了就重放整段）：
     *   ① 已消费长度不超过当前文件（否则 = 被清空 / 截断 / 换了文件）；
     *   ② 前 4KB 指纹一致（否则 = 被整文件覆盖 —— 同尺寸覆盖时大小与偏移都看不出来）。
     * 取向：宁可重放一遍，也绝不把两份日志的历史缝在一起。
     */
    private foldedOps(taskUri: string, fp: string, start: number): Op[] {
        const size = fileSize(fp);
        const prefix = readPrefix(fp);
        const key = `${taskUri}#${start}`;
        const cached = this.historyCache.get(key);
        const c: { start: number; consumed: number; prefix: string; store: BlockStore } =
            cached && cached.start === start && !(cached.consumed > size || (size > 0 && cached.prefix !== prefix))
                ? cached
                : { start, consumed: start, prefix: "", store: new BlockStore() };
        if (size > c.consumed) {
            const { ops, consumed } = readOpsRange(fp, c.consumed, size);
            for (const op of ops) c.store.apply(op);
            c.consumed = consumed;
        }
        c.prefix = prefix;
        // LRU（Map 保插入序）：访问即移到队尾，超限淘汰最久没打开的会话（谁也不希望
        // 「刚看过的那本」被另一个冷会话挤掉）。
        this.historyCache.delete(key);
        this.historyCache.set(key, c);
        if (this.historyCache.size > HISTORY_CACHE_MAX) {
            const oldest = this.historyCache.keys().next().value;
            if (oldest !== undefined) this.historyCache.delete(oldest);
        }
        // fold 期的异常（未知块 / 重复 start / 悬挂 parent）会随折叠一起消失 —— 但那是
        // **诊断信息**，不该在压缩里静默蒸发（任务 290 review B4）。出声，带前几条样例。
        if (c.store.issues.length > 0) {
            const sample = c.store.issues.slice(0, 3).map((i) => i.reason).join(" | ");
            console.warn(`[local-agent] 会话 ${taskUri} 折叠前 fold 出 ${c.store.issues.length} 条 issue：${sample}`);
        }
        return compactOps(c.store);
    }

    /**
     * **尾部窗口**（大会话分页的「最近一段」）—— 只 fold 一段，不再是整份。
     *
     * 为什么要有它（任务 293）：290 折叠后冷加载仍是**整份** —— 读盘 + 全量 fold（74MB 会话
     * ~2.3s，主线程阻塞）+ 整量回包（15.2MB）。分页只 fold「最近一段」，滚动上取再补一段。
     *
     * `cursor` 语义：**回传上一次发的游标** = 「从这段的起点重取」（轮末刷新的路径 —— 起点
     * 固定，文件只变长，于是渲染端的段依然是同一段的延长，增量并入即可）。缺省则是首载：
     * 按 `budgetBytes` 从尾部 seek 一个轮首作为起点。游标失效（清空 / 覆盖写）⇒ 退全量。
     *
     * 不变量：`ops` 里除末轮（可能正在写）外每轮完整，且起点落在轮 `start` 行行首
     * （见 local-ops-seek 的三条保证）—— 窗口边界错位会让块塌成根、patch 丢失。
     */
    historyWindow(taskUri: string, opts: { budgetBytes?: number; cursor?: string } = {}): HistoryWindow {
        const fp = opsFile(taskUri);
        const at = opts.cursor ? decodeCursor(opts.cursor, fp) : null;
        // 带了游标却失效（清空 / 覆盖写 / 换了文件）⇒ 退全量：**绝不把两段历史缝在一起**，
        // 与折叠缓存的判据同一取向（宁可重放整份，也不给出错位的窗口）。
        if (opts.cursor && (at === null || !isTurnStartAt(fp, at))) return this.segmentOf(taskUri, fp, 0, undefined, true);
        return this.segmentOf(taskUri, fp, at ?? seekWindowStart(fp, opts.budgetBytes ?? 0));
    }

    /**
     * **更早的一段**（上滚取）：`cursor` 所在段起点之前的 `budgetBytes` 字节，
     * 同样向上取一个轮首作为新段起点（floor，永不落空）。
     *
     * 已到文件头（`at === 0`）⇒ 空段 + `hasMore: false`（渲染端据此收工，不再请求）。
     */
    historyOlder(taskUri: string, opts: { cursor: string; budgetBytes?: number }): HistoryWindow {
        const fp = opsFile(taskUri);
        const at = decodeCursor(opts.cursor, fp);
        if (at === null || !isTurnStartAt(fp, at)) return this.segmentOf(taskUri, fp, 0, undefined, true); // 游标失效 ⇒ 全量 + stale
        if (at <= 0) return { ops: [], cursor: encodeCursor(fp, 0), hasMore: false, stale: false };
        // 至少往前 1 字节：`budget` 缺失（或 0）时退化成「只取前一轮」，而不是原地打转
        const start = seekTurnStartAtOrBefore(fp, at - Math.max(1, opts.budgetBytes ?? 0));
        // 当前**不可达**（`seekTurnStartAtOrBefore` 的 floor 语义保证 `start ≤ at - 1`），
        // 留着是防未来改动把「至少往前 1 字节」这条丢掉 —— 那时空转 = 渲染端死循环补同一段。
        if (start >= at) return { ops: [], cursor: encodeCursor(fp, at), hasMore: false, stale: false };
        return this.segmentOf(taskUri, fp, start, at);
    }

    /**
     * **含指定位置的定长段**（##389 段跳）：命中落在 `at` 那一轮，就从该轮取一段开始读。
     *
     * 与 `historyWindow` / `historyOlder` 的分工（**别混用**）：
     *   · `historyWindow({cursor})` = `[游标, **文件尾**)` —— 它是"重取尾部窗口"，拿它当中段跳
     *     会把中段到文件尾几十 MB 全折一遍（正是本方法要避免的）；
     *   · `historyOlder({cursor})` = `[cursor - budget, cursor)` —— 只能前进到**已知游标之前**，
     *     要跳到远处得连补十几次；
     *   · 本方法 = `[at, 下一个不早于 at+budget 的轮首)`，一次到位，`hasNewer` 告诉渲染端
     *     "后面还有内容没读"（段跳后它显示的是**历史**，尾部要显式回切）。
     *
     * `at` 不是轮首（日志被改写 / 定位到了一条过时命中）⇒ 退全量 + `stale`（与游标失效同一取向：
     * 宁可重放整份，也不给出错位的窗口）。
     *
     * ⚠️ `budgetBytes` 缺省（0 / 不传）= **取到文件尾**（`budget=1` 时 `floor` 返回 `at` 本身 ⇒ `to=size`）。
     * 不是"只取一轮"—— 渲染端固定传 4MB，故这条缺省只影响 CLI 手敲。
     */
    historyAt(
        taskUri: string,
        opts: { at: number; budgetBytes?: number },
    ): HistoryWindow & { hasNewer: boolean } {
        const fp = opsFile(taskUri);
        const fallback = { ...this.segmentOf(taskUri, fp, 0, undefined, true), hasNewer: false };
        if (!isTurnStartAt(fp, opts.at)) return fallback;
        let size = 0;
        try {
            size = statSync(fp).size;
        } catch {
            return fallback;
        }
        const budget = Math.max(1, opts.budgetBytes ?? 0);
        // 段尾 = 「≤ at+budget 的最近一个轮首」（floor，复用上滚那条 seek）：边界永远是干净的轮首，
        // 而 budget 至少 1 字节 ⇒ 只要中间还有轮首就一定 > at（没有就一路取到文件尾）
        const ceiling = Math.min(size, opts.at + budget);
        const floor = seekTurnStartAtOrBefore(fp, ceiling);
        const to = floor > opts.at ? floor : size;
        const w = this.segmentOf(taskUri, fp, opts.at, to);
        return { ...w, hasNewer: to < size };
    }

    /**
     * **会话数据层检索**（##389）：在 ops.jsonl 原文里找字，与渲染窗口 / DOM 无关。
     *
     * 为什么在 main 做：渲染端只有**一个窗口**的块树（首载 4MB + 上滚补段），窗口外的轮
     * 根本不在内存里；而真相源（append-only 的 ops）在盘上，且压缩**不搬文件、不 rm**
     * ⇒ 扫原文天然覆盖「已压缩掉的历史」（口径见 local-find 头注）。
     *
     * 「已压缩」判定取**最近一条** compact 账的保留边界：`keptFromOpsOffset`（字节偏移，
     * 快路径）优先，旧账没有偏移时退 `keptFromTurnId`（按轮序）。两者都没有 = 从没压缩过。
     */
    async findInSession(
        taskUri: string,
        opts: { query: string; scopes?: Partial<FindScopes>; maxTurns?: number; signal?: AbortSignal },
    ): Promise<FindResult> {
        const fp = opsFile(taskUri);
        let compactedBefore: number | null = null;
        let compactedFromTurnId: string | null = null;
        const events = readCompactLog(taskUri);
        let latest: CompactEventRecord | null = null;
        for (const e of events) if (e.kind === "compact") latest = e;
        if (latest) {
            compactedBefore = latest.boundary?.keptFromOpsOffset ?? null;
            compactedFromTurnId = latest.boundary?.keptFromTurnId ?? null;
        }
        return findInOpsFile(fp, {
            query: opts.query,
            scopes: opts.scopes,
            maxTurns: opts.maxTurns,
            compactedBefore,
            compactedFromTurnId,
            signal: opts.signal,
        });
    }

    /**
     * 窗口的唯一出口：读 `[from, to)` → fold → compact。三种取法共用同一份语义
     * （读满 / 半行留给下次见 readOpsRange；compact 让回包从 15MB 降到段大小）。
     *
     * `hasMore = from > 0`：起点不在文件头 ⇒ 前面可能还有轮。若前面只剩非轮内容，
     * 下一次上滚会得到空段 + `hasMore: false` —— 多一次请求，不会出错。
     */
    private segmentOf(taskUri: string, fp: string, from: number, to?: number, stale = false): HistoryWindow {
        // `to` 缺省 = 到文件尾 ⇒ 走增量缓存（轮末刷新的高频路径）；定长区间（上滚段）直读直 fold。
        const ops = to === undefined ? this.foldedOps(taskUri, fp, from) : foldRange(fp, from, to);
        return { ops, cursor: encodeCursor(fp, from), hasMore: from > 0, stale };
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
        // 装配管道 = **当前配置**的 `history.keep[]`；没配 ⇒ 缺省管道（回落，行为与 ##343 M1 一致）。
        const cfgKeep = loadAutoCompact(diyHome()).history?.keep;
        const keepUsed: readonly KeepStage[] = cfgKeep && cfgKeep.length > 0 ? cfgKeep : DEFAULT_KEEP;
        const planSource: "config" | "default" = cfgKeep && cfgKeep.length > 0 ? "config" : "default";
        // ##378：事件只记**版本指针**（内容寻址）—— 全文在 CAS，压缩账不再内嵌 keep
        const planSnapshot: CompactPlanSnapshot = {
            budgetBytes: policy.modeData.budgetBytes,
            source: planSource,
            planVersion: planVersionId(planVersionDoc({ source: planSource, keep: keepUsed })),
        };
        const scan = scanOpsFile(taskUri);
        const turnIds = listTurnIds(scan.ops);
        const store = new BlockStore();
        for (const op of scan.ops) store.apply(op);
        // 保留 = 预算选择（实时算）。keptRuns = 预算的**过滤器表达**（存进事件，供历史回溯还原 diff）
        const all = projectAll(store);
        const sel = selectHistoryByBudget(all, policy.modeData.budgetBytes, optsFor(policy, taskUri, undefined, keepUsed));
        const keptRuns = sel.keptRuns;
        const keptSet = new Set(sel.kept.map((i) => all[i]!.turn).filter((t): t is string => !!t));
        const keptTurns = keptSet.size;
        const keptFromTurnId: string | null = sel.kept.length > 0 ? (all[sel.kept[0]!]!.turn ?? null) : null;
        const droppedIds = turnIds.filter((id) => !keptSet.has(id));

        // 机械锚点：保留起点轮的 op 下标；全清（keptTurns=0）→ 压缩时刻的 op 总数
        const keepFromOpIndex =
            keptFromTurnId !== null ? (scan.turnOpIndex.get(keptFromTurnId) ?? -1) : scan.ops.length;

        const clipped: ClippedToolDetail[] = [];
        const before = sizeOfStore(store);
        const after = sizeOfStore(store, optsFor(policy, taskUri, clipped));

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
                  provider: findModel(model)?.provider ?? "unknown",
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
        return { policy, keptTurns, keptFromTurnId, keepFromOpIndex, droppedIds, keptRuns, scan, store, before, after, droppedDetail, clipped, rateSnap, stats, planSnapshot, planKeep: keepUsed };
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
        /** 调用方**手里已有同一份会话折好的块树**时传入（`compactPreview` 一次算 base/mod 两份视图）：
         *  省掉两遍「整读 + 解析 + 折叠」—— 这是「一份 78MB 文件被读三遍」的那两遍（##321）。
         *  只读复用：`buildHistory` 只投影（`blocksToMessages` / `projectAll` 均不回写块树）。 */
        storeInput?: BlockStore,
    ): RequestView {
        const home = diyHome();
        const globals = assembleGlobals(home, projectFromUri(taskUri), {
            taskUri,
            // 同上：预览与真发同一份装配（房间取本任务自己的房间）
            room: roomRuntimeFact({ roomId: taskUri, taskUri })?.value ?? null,
        }) as unknown as Record<string, unknown>;
        const delivery = buildDelivery(globals, loadSystemPlaces(home));
        const { cwd } = resolveCwdWithNote(home, taskUri);
        const L = this.getLimits();
        const tools = buildTools(cwd, L, taskUri);
        const store = storeInput ?? replay(readJsonl<Op>(opsFile(taskUri)));
        // 与真发**同一条链**（含压缩注记）：面板里的"压缩后预览"就是这一份
        const histView = this.deliveryHistoryForView(store, policy, taskUri);
        const summaryText = summaryOverride !== undefined ? summaryOverride : this.effectiveSummary(taskUri);
        // 摘要与注记一样是**自动生成的段** → 各占顶层键，不进 user.message（##310 九轮）
        const messages = normalizeUserRuns(
            withRuntime(histView.messages, delivery.runtime.text, histView.note, renderSummaryPart(summaryText)),
        );
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
        // 摘要针对**当前配置下会被丢弃的轮**（与 compact 同一份预算），不再用旧的 keepTurns 旋钮。
        const p = this.planCompact(taskUri, loadAutoCompact(diyHome()).policy);
        if (p.droppedIds.length === 0) return { text: "", data: emptySummary(), cost: null };
        const model = personaForTask(diyHome(), taskUri).model;
        const { rm, key } = this.resolveModel(model);
        const dropped = droppedTextOf(p.store, p.droppedIds);
        this.noteTraffic(taskUri, "summary", rm, 2);
        const res = await generateText({
            model: this.modelFor(rm, key),
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
        // 一次算两份视图（base/mod）→ 复用 planCompact 刚折好的块树：整读 + 解析 + 折叠只做一次。
        // 同步链路内文件不会变，且投影只读（不回写块树），故两份视图看到的是**同一份**历史。
        const store = p.store;
        // base = **未压缩**的投递（全量历史、无注记）—— 配置 / 历史分离后，"当前配置"就是 mod，
        // 拿它当 base 会得出"无差异"。预览的价值是看"这次压缩**去掉/改了什么**"，故 base 取全量。
        const base = this.buildRequestView(taskUri, null, undefined, undefined, store);
        // 勾选摘要但尚未生成 → 用占位骨架（让用户先看见"会得到什么"，且不花一分钱）
        const sum = p.policy.summary
            ? summaryText !== undefined
                ? summaryText
                : this.effectiveSummary(taskUri) || summaryPlaceholder(emptySummary(p.droppedIds.length))
            : "";
        const mod = this.buildRequestView(taskUri, p.policy, p.keptFromTurnId, sum, store);
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
     * 「必保层（`must` 级）实占字节」测量（##344 M2 · `plan check` 的硬判据）。
     *
     * 只跑**必保级**：那是预算**管不到**的部分（撑爆就白压 —— 压了跟没压一样，还白付重建代价）。
     * 硬上限 = 模型上下文窗口 token × 4（无 tokenizer，与全仓同一个粗估口径）；窗口未知 ⇒ 兜底常量。
     */
    measureMustStages(taskUri: string, keep: readonly KeepStage[]): { mustBytes: number; hardCapBytes: number } {
        const policy = loadAutoCompact(diyHome()).policy;
        const capTokens = contextLimitOf(personaForTask(diyHome(), taskUri).model);
        const hardCapBytes = capTokens !== undefined ? capTokens * 4 : DEFAULT_MUST_HARD_CAP_BYTES;
        const must = keep.filter((s) => s.must === true);
        if (must.length === 0) return { mustBytes: 0, hardCapBytes };
        const all = projectAll(replay(readJsonl<Op>(opsFile(taskUri))));
        const p = keepStagesToPlan(must, Number.MAX_SAFE_INTEGER, clipSpecOf(toolResultOf(policy)));
        const sel = runPlan(all, p, { costOf: costOfWith(optsFor(policy, taskUri)) });
        return { mustBytes: sel.keptBytes, hardCapBytes };
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
                writeFileAtomic(toolOutFile(taskUri, c.id), typeof b?.output === "string" ? b.output : "");
            } catch (e) {
                console.error(`[local-agent] 工具原文落盘失败 ${c.id}:`, e);
            }
        }

        const ts = new Date().toISOString();
        const rec: CompactEventRecord = {
            kind: "compact",
            v: 4,
            id: ts,
            ts,
            by,
            trigger,
            policy: p.policy,
            // ##378：plan 只记**内容寻址版本指针**（`planVersion`）—— 全文在 `$DIY_HOME/plan-store/`，
            // 不再内嵌（同内容反复内嵌 = 去重 0，且没有版本链）。
            plan: p.planSnapshot,
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
        if (!noop) {
            // ##378：先把 plan 版本物化进 CAS；链尾不是它（手改配置 / 版本化前配的 plan）⇒ 补录一行，
            // 保证账里的 `planVersion` 一定能被「列出来 / 回查 / 回滚」（否则是悬空指针）。
            const home = diyHome();
            const doc = planVersionDoc({ source: p.planSnapshot.source, keep: p.planKeep });
            writePlanVersion(home, doc);
            if (currentPlanVersion(home)?.version !== p.planSnapshot.planVersion) {
                appendPlanVersion({
                    home,
                    doc,
                    op: "set",
                    via: "user",
                    taskUri,
                    brief: `压缩时补录：配置中的 plan 不在链上（${p.planKeep.map((k) => k.type).join(" / ") || "空级列表"}）`,
                });
            }
            appendCompactEvent(taskUri, rec);
        }
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

    /**
     * 用户主动停止：中止在跑的轮次。**唯一的"停"入口**（##305：孤儿不再自动回收）。
     * 消费端断开**不**走这里 —— 刷新/切页/关窗不再掐掉正在跑的轮次。
     */
    cancel(taskUri: string): boolean {
        const s = this.sessions.get(taskUri);
        if (!s?.running) return false;
        // 显式带 `source`：`TurnEndReason.aborted.data.source` 是**可见文案的判据**
        // （shared/turn-end 的 `abortText`），也是"用户停止"与"流意外中断"的分档位。
        // 不带 reason 的话 `abortSource(signal, "abort")` 会把它兜成 `"abort"`，
        // 与旧日志里"来源不明的中断"同档 —— 那正是 R4 要消掉的分叉（##308）。
        s.running.abort({ source: "user" });
        return true;
    }

    /**
     * 入队一条插话 —— **入队本身不开轮**（它只管"记下来"；正在跑的轮次按投递时机取走，
     * 没有轮次在跑则留待下一轮）。
     *
     * 调用方（api-impl 的 chat handler）在入队后必须做「无活跃轮次则唤醒一轮」的判定
     * （见同处的注释与 hasActiveTurn）：否则空闲时入队的留言**没有任何机制会因它启动一轮**，
     * 永远躺在 .diy/drafts.yaml 里（##303：模型永远看不到，用户以为发出去了）。
     */
    steerAdd(taskUri: string, mode: SteerMode, text: string, author?: string): SteerItem[] {
        const r = this.queue.add(taskUri, mode, text, undefined, author);
        sessionRegistry.noteActivity(taskUri); // queue 是注册表的活态属性
        return r;
    }

    /**
     * 此刻本会话**是否有轮次在跑**（判据 = `chat()` 的排队判据，**同一个** `turns` 注册表）。
     *
     * 用途（##341 review1 P2-1）：替用户跑轮次的调用方（工作流驱动环）**起轮前**要先问这一句 ——
     * `chat()` 对忙会话的既有语义是「**不拒绝、改排队**」（##306 插话），于是"起一轮"会静默退化成
     * "排一条插话"：调用方既收不到正文，它的提示词还进了别人的对话队列。
     * 只读、不改任何状态 —— 判据与动作分开，调用方自己决定怎么办。
     */
    busy(taskUri: string): boolean {
        return this.turns.has(taskUri);
    }

    /**
     * 本会话的**观察者数** = 本轮 chat 流的消费端（`run.subs`）+ 该会话 op 流的订阅者
     * （UI 窗口 / CLI watch，`opsFeed`）。
     *
     * 用途：`agent.local.running` 的可见性标注（detached / subscribers，[5] ##308 数据源）。
     * **不用于回收**（##305 拍板：不做"无人即停"—— 会误杀正常长任务）。
     * 两个来源都要算：CLI 只消费 chat 流、UI 只订阅 op 流 —— 少算一个就会把"有人正在看"
     * 的轮次标成 detached（##308 页面上会误报"没人看"）。
     */
    watchers(taskUri: string): number {
        return (this.turns.get(taskUri)?.subs.size ?? 0) + opsFeed.subscriberCount(taskUri);
    }

    /**
     * 用**队列现有内容**开一轮（不新增入队）—— 队列为空则不产任何 op。
     *
     * 这是「无活跃轮次时的留言」与「立即发送」共用的落点：留言的语义就是"发一句话"，
     * 空闲时它本就该像普通消息一样立刻发出（##303 倾向的 c 方案）。
     */
    async *chatQueued(
        taskUri: string,
        modelOverride?: string,
        reasoningEffortOverride?: ReasoningEffort,
    ): AsyncGenerator<Op> {
        const seed: TurnInput[] = this.queue.list(taskUri).map((it) => ({
            text: it.text,
            kind: it.mode,
            steerId: it.id,
            // 署名随队列项一起带进开场块（##166 §40 A）：排队跨轮次，投递时已无从查"谁说的"
            ...(it.author ? { author: it.author } : {}),
        }));
        if (seed.length === 0) return;
        yield* this.chat(taskUri, "", modelOverride, reasoningEffortOverride, undefined, seed);
    }

    /**
     * 「立即发送」：把队列整批**现在就送出去**，不等轮末 / 下一步的时机。
     *
     * 两个分支合起来才是"现在"：
     *   · 有活跃轮次 → 全部转 next-step —— 那是这一轮里唯一还能到达的点（下一个模型步之前）；
     *   · 没有轮次   → 立刻开一轮，队列内容作开场白。
     *
     * 无 op 产出（队列空 / 只是加急）不代表失败：调用方按需重拉队列快照即可。
     */
    async *flushSteers(
        taskUri: string,
        modelOverride?: string,
        reasoningEffortOverride?: ReasoningEffort,
    ): AsyncGenerator<Op> {
        const items = this.queue.list(taskUri);
        if (items.length === 0) return;
        if (this.busy(taskUri)) {
            // 加急：next-turn 的都改成 next-step（已是 next-step 的原样；用户拖过的顺序不动）
            for (const it of items) {
                if (it.mode === "next-step") continue;
                try {
                    this.queue.toggleMode(taskUri, it.id);
                } catch (e) {
                    // 单条写失败不放弃其余：用户在横条上能看见哪些没加急成功（仍是时钟图标）
                    console.error(`[local-agent] 插话加急失败 ${taskUri}#${it.id}:`, e);
                }
            }
            return;
        }
        yield* this.chatQueued(taskUri, modelOverride, reasoningEffortOverride);
    }

    /** 当前待投递的插话（FIFO，顺序即投递顺序） */
    steerList(taskUri: string): SteerItem[] {
        return this.queue.list(taskUri);
    }

    /** 取消一条待投递插话（幂等：id 不存在就返回原队列） */
    steerCancel(taskUri: string, id: string): SteerItem[] {
        const r = this.queue.remove(taskUri, id);
        sessionRegistry.noteActivity(taskUri);
        return r;
    }

    /** 切换一条插话的投递时机（next-step ⇄ next-turn；差别只在投递点，两者都整批投）。 */
    steerToggleMode(taskUri: string, id: string): SteerItem[] {
        const r = this.queue.toggleMode(taskUri, id);
        sessionRegistry.noteActivity(taskUri);
        return r;
    }

    /** 重排待投递插话的顺序（横条上的拖拽排序；顺序即投递顺序） */
    steerReorder(taskUri: string, ids: string[]): SteerItem[] {
        const r = this.queue.reorder(taskUri, ids);
        sessionRegistry.noteActivity(taskUri);
        return r;
    }

    /**
     * 变更历史的「起点重置」标记（##310）。
     *
     * 为什么需要它：`baseline` 的语义是**一段会话的起点**，理想触发点是「会话启动」。可会话注册表 /
     * 关停启动机制还没落地，写起点的判据只能退化成「文件里还没有二版记录」—— 于是老任务升级后、
     * 或想"从此刻重新起算"时，没有任何入口能让它再写一条起点。
     *
     * 这是**临时**入口，动作刻意做成与会话启动**完全一致**：置标记 → 下一步真发时写一条新 baseline。
     * 等会话注册表/关停启动落地，把置标记的两处（`clear` 与 `rebaseline` 命令）换成「会话启动」一处即可，
     * 命令本身留作调试口，不必回收。
     *
     * 只在内存里：**进程重启即失效** —— 重启不是会话边界（对话从盘上重建、继续），这点是刻意的；
     * 真需要「重启后也算新起点」，那是会话注册表的语义，不该在这里假装实现。
     */
    private rebaselinePending = new Set<string>();

    /** 标记：该任务下一步真发时写一条新 baseline（新会话起点）。会话注册表落地后由「会话启动」自动置位。 */
    markRebaseline(taskUri: string): void {
        this.rebaselinePending.add(taskUri);
    }

    /**
     * **跨轮**的投递游标：该任务**上一次真发**的投递快照（tree + 值 hash），每任务一份。
     *
     * 为什么必须跨轮（实测的 bug）：变更是「**这次**请求的当前值 vs **上一次**请求的当前值」。
     * 曾经把游标放成一轮一个局部量（`let ctxPrevSnap = 轮首那份`）—— 于是它只能看见一轮**之内**
     * 的变化（step 2..N），而最常见的变化（用户改了正文/标题，再来问一句）发生在**两轮之间**：
     * 新轮次的轮首值已经是改后的值，拿它当基准 ⇒ 永远 diff 出空 → 变更日志从不记录。
     * 实测：真发改标题 → 下一轮落不出任何 `changed`（只有 baseline）。
     *
     * 内存里即可（`rule.core-log`：核心逻辑不依赖日志）；进程重启后为空 → 由 `seedCtxSnap`
     * 从盘上**播种**上一次真发的值（steps 末条的 hash + changelog 重放出的值树），
     * 播不出来（老任务没 baseline / 从没真发过）才退回"以轮首值为基准"——**少报不错报**。
     */
    private ctxSnap = new Map<string, CtxSnapshot>();

    /**
     * 跨进程重启后**播种**跨轮游标（`ctxSnap` 是内存 Map，重启即空）。
     *
     * 材料（都在盘上，且都是"上一次真发"的事实）：
     *   · `valueHashes` ← `steps.jsonl` 末条 —— **真值 hash**，判定"变没变"足够精确；
     *   · 值树 ← changelog 最后一条 `baseline` + 之后各 `changed` 的 `after`（`foldCtxTree`）——
     *     只够产出 before **摘要**（长值在 changelog 里本就是截断摘要）。
     * 缺任一份 → `null`，调用方退回"以轮首值为基准"（**少报不错报**）。
     */
    private seedCtxSnap(taskUri: string): CtxSnapshot | null {
        try {
            const lastStep = readDeliverySteps(taskUri).at(-1);
            if (!lastStep) return null;
            const tree = foldCtxTree(readCtxLogEntries(taskUri));
            if (!tree) return null;
            return { tree, valueHashes: lastStep.valueHashes };
        } catch (e) {
            console.warn(`[local-agent] 播种变更游标失败（退回轮首基准）${taskUri}:`, e);
            return null;
        }
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
            sessionRegistry.noteActivity(taskUri);
        } catch (e) {
            console.error(`[local-agent] 清空插话队列失败 ${taskUri}:`, e);
            ok = false;
        }
        // 文件清单必须**穷举**：加新日志（如 usage / compact）时漏一处，就是「彻底删除」删不干净
        // （旧实现就漏了 usage.jsonl —— 用量账本按会话存，留着它会让删除后仍查到本会话的花费）。
        // ##379：新老两个落位都删（`sessionFilesToClear` 是唯一清单）——
        // 只删 `opsFile` 命中的那一份，另一份会被读侧双认兜底重新认领 = 清空静默失效。
        for (const f of sessionFilesToClear(taskUri)) {
            try {
                rmSync(f, { force: true });
            } catch (e) {
                // force:true 已吸收 ENOENT；能到这里的都是真故障（权限/只读盘），不能冒充成功
                console.error(`[local-agent] 删除日志失败 ${f}:`, e);
                ok = false;
            }
        }
        // 被裁剪工具输出的原文：按本任务账本里引用过的 id 删，命中**两个落位**——
        // ① 本任务会话目录下那份（`<会话目录>/toolout/`，##379 起的落位）；
        // ② legacy 共享目录 `local/toolout/` 兜底那份（迁移前写下的）。
        // legacy 目录是跨任务共享的，同 id 撞名在旧布局下本就无解（只能都删）；
        // 迁移后每会话一份，撞名面随之消失 —— 所以这里不再需要「只删自己的」这层猜想。
        for (const e of readCompactLog(taskUri)) {
            if (e.kind !== "compact") continue;
            for (const c of e.details?.clipped ?? []) {
                try {
                    for (const f of toolOutFileCandidates(taskUri, c.id)) rmSync(f, { force: true });
                } catch (err) {
                    console.error(`[local-agent] 删除工具原文失败 ${c.id}:`, err);
                    ok = false;
                }
            }
        }
        // 会话内容已从盘上消失 → 换发 epoch、水位归零，并通知所有订阅方重建块树。
        // 少了它，订阅方拿着旧 since 会以为「新写入落进了旧会话」（epoch 不变 = 同一本史书）。
        opsFeed.reset(taskUri);
        // 变更日志**故意不在上面的删除清单里**：它按任务存、是跨会话的**审计时间线**（"这个变量一共变过几次"
        // 要求它活过清零），而本轮的对话（ops/llm/steps…）才是该销毁的东西。代价是旧条目引用的 turnId
        // 没了 → `context changelog` 按 turnId join 不到投递快照/用量，徽章给 null（不谎报）。语义等价物：
        // 「清对话」≠「清审计」。所以这里只**置起点标记**：下一次真发落一条新 baseline，等于给新会话另起一段。
        this.rebaselinePending.add(taskUri);
        // 内存态无论如何都丢：留着它才是真的不一致（盘上文件仍在 → 重进会重新加载）
        this.sessions.delete(taskUri);
        // 折叠缓存同理：日志已删，留着就是读一份不存在的文件。
        // 键是 `${taskUri}#${start}`（分页后一个 task 可能有多条窗口），按前缀清干净。
        for (const k of [...this.historyCache.keys()]) {
            if (k.startsWith(`${taskUri}#`)) this.historyCache.delete(k);
        }
        return ok;
    }

    /**
     * 一轮对话：实时产出块协议 Op；op 即传即落盘（存储=传输）。同 task 并发**排队**（##306：不拒绝，
     * 排进插话队列由在跑的轮次轮末整批取走 —— 见下方 `this.turns.has` 分支）。
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
    /**
     * ⚠️ **参数位次**（##266 review1 R3.2）：① `taskUri` ② `message` ③ `modelOverride`
     * ④ `reasoningEffortOverride` ⑤ `signal` ⑥ `seed` ⑦ `origin`。
     * 位置参数已有 7 个，且真实调用点常一次给 4 个 `undefined`（如 `room-service` 的投递）
     * ⇒ **再加参数前先想 options 对象**；此刻至少照这行数位次，别靠肉眼对齐。
     *
     * 第 23 刀按这句把 ⑦ 从「`author?: string`」收成「`origin?: TurnOrigin`」——
     * 一个参数承载「这条消息的随附事实」（谁说的 + 从哪个房间来的），**再扩不必加第 8 个位次**。
     */
    async *chat(
        taskUri: string,
        message: string,
        modelOverride?: string,
        reasoningEffortOverride?: ReasoningEffort,
        /** RPC 流的取消上下文：客户端断开（刷新/切页/杀 CLI）时即时退订 —— 见下方 `withCleanup`。 */
        signal?: AbortSignal,
        /**
         * 首轮输入（缺省 = 调用方这一条 message）。
         *
         * 给出时**用它开场**，message 忽略 —— 「用队列开一轮」走的就是这条路（见 chatQueued）：
         * 不新增入队、直接把已有的待投递留言当开场白发出去（##303）。
         */
        seed?: TurnInput[],
        /**
         * 本轮 message 的**随附事实**（##166 §40 A / ##377 第 23 刀）：
         * `author` = 发言者成员 id（room 投递时 = **发起投递的成员 id**）· `room` = 房间来源。
         * seed 给出的情形下忽略它（那些条各自带 author）。
         */
        origin?: TurnOrigin,
    ): AsyncGenerator<Op> {
        const persona = personaForTask(diyHome(), taskUri);
        const model = modelOverride ?? persona.model;
        let rm: ResolvedModel;
        let key: string;
        try {
            ({ rm, key } = this.resolveModel(model));
        } catch (e) {
            // 装配期就失败了（模型 id 不在清单里 / 人物没配模型）：**一句 error 都没有地抛**是
            // 最容易被忽略的形态（用户只看到"点了发送没反应"，或会话里一条错）。本地这份事实
            // 明确，直接组一条通知（不经文案判据），抛仍旧抛 —— 提示不改变失败语义。
            modelNoticeHub.push(
                unavailableNoticeFromLocal(errText(e), {
                    taskUri,
                    personaId: persona.id,
                    personaName: personaDisplayName(persona.id),
                    model,
                }),
            );
            throw e;
        }
        // 手写 personas.yaml 可能把档位留空：兜底到该模型自己的默认档，不把空档发给上游
        const reasoningEffort = reasoningEffortOverride ?? (persona.reasoningEffort || reasoningOf(model).default);
        let sess = this.getSession(taskUri);
        // 该会话已有轮次在跑 —— **不拒绝，改排队**（##306 / ##180 专项第 1 步）。
        // 「窗口只是后端的使用窗口」：同任务第二个客户端发消息不该拿到错误，
        // 而该排进插话队列，由正在跑的轮次在轮末整批取走（见下方续轮循环）。
        // 判据是 `turns` 注册表而非生成器：轮次寿命不再等于这条流的寿命（##305）。
        if (this.turns.has(taskUri)) {
            yield* this.enqueueWhileRunning(taskUri, sess, message, origin?.author);
            return;
        }

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

        // ── 建「轮次运行」并**分离启动驱动**（##305）────────────────────────
        // 轮次的寿命不再等于这条 RPC 流的寿命：驱动（driveTurn）归本管理器持有，
        // 本生成器只是它的订阅者。刷新/切页/关窗/RPC 断开 ⇒ 只退订，不 abort ——
        // 「刷新 = 重新接上视图」。无人消费时的开销由 maxSteps 步数上限收口（见 TurnRun 头注）。
        const run: TurnRun = {
            taskUri,
            ctrl: new AbortController(),
            subs: new Set(),
        };
        sess.running = run.ctrl;
        this.turns.set(taskUri, run);
        // 先注册订阅再启动驱动：op 的路径是「落盘 → push 给当前订阅者」，晚注册会丢开头几条。
        // 注册是同步的，与驱动的首个 await 之间没有竞态窗口。
        const q = new AsyncQueue<Op>();
        run.subs.add(q);
        // chat 流订阅者也是 `viewers` 的一半（见 watchers）⇒ 增 / 退同样要推一次注册表帧，
        // 否则「窗口发完消息就断开」会让 viewers 停在旧值（review1 P2-1 同一类缺口）。
        // op 流那一半由 ops-feed 的订阅者变化回调覆盖（见 session-registry 构造器）。
        sessionRegistry.noteActivity(taskUri);
        // signal（RPC serverStream 的取消上下文）= 本订阅的**第二条出口**，与 ops-feed / file-watcher
        // 是同一条修法：传输断开时 RPC 层调的是 `ctrl.abort()` + `void g.return()`，而 `return()` **排在
        // 悬挂的 `next()` 之后**（生成器卡在 `await next()`）—— 只靠 return 出口的话，「模型思考中（无 op
        // 产出）刷新页面」会让 q 一直滞留在 run.subs 里 ⇒ watchers() 虚高 ⇒ `agent.local.running.subscribers`
        // （[5] ##308）误报「有人看」，且 publish 往无人读的队列里堆 op（无界）。
        const sub = withCleanup(
            q,
            () => {
                run.subs.delete(q);
                sessionRegistry.noteActivity(taskUri); // 退订 = 一次"谁在看"的变化
            },
            signal,
        );
        const driving = this.driveTurn(run, sess, message, model, reasoningEffort, key, rm, persona.id, seed, origin).catch((e) => {
            // 驱动异常按原语义经流上抛（RPC 层转 error 帧），由订阅端在流尾 rethrow
            run.error = e;
        });
        // for-await 的 IteratorClose（消费端 return 展开 = 刷新/切页/关窗/杀 CLI）会调到 sub 的
        // return → 只摘掉订阅。这正是本次改造的落点：**轮次继续跑**，重连走 ops 水位（##307 读侧）。
        for await (const op of sub) yield op;
        await driving; // 等驱动落位（订阅流关闭正是驱动尾部触发）→ run.error 必已写入
        if (run.error) throw run.error;
    }

    /**
     * **轮次驱动**（##305）：自持消费 runTurn 内层生成器，把 op「落盘（sink）+ 收敛内存（store.apply）
     * + 推给订阅者」。全程没有 yield —— 消费端来了走、走了留，驱动都照常跑完本轮。
     *
     * 由 chat() 以 `void` 启动；异常记入 `run.error`（订阅端在流尾 rethrow，保持"错误经流传递"的旧语义）。
     * 收尾（abort 上游 / appendLlm / 注销 / 关订阅流）全在 finally —— 任何退出路径都不留僵尸轮次。
     */
    private async driveTurn(
        run: TurnRun,
        sess: LocalSession,
        message: string,
        model: string,
        reasoningEffort: ReasoningEffort,
        key: string,
        rm: ResolvedModel,
        personaId: string,
        /** 首轮输入（缺省 = 调用方那一条 message）—— 「用队列开一轮」的落点，见 chatQueued（##303）。 */
        seed?: TurnInput[],
        /** 本轮 message 的随附事实（seed 给出的情形下忽略 —— 那些条各自带，见 chat 的 origin） */
        origin?: TurnOrigin,
    ): Promise<void> {
        const taskUri = run.taskUri;
        const ctrl = run.ctrl;
        /** 推 op 给当前所有订阅者（落盘与内存收敛由各调用点负责 —— 见 emit/seal 的头注） */
        const publish = (op: Op): void => {
            for (const s of run.subs) s.push(op);
        };
        let done = false;
        /** 驱动自身抛出的异常（兜底收口时据此判「error」而不是「消费端断开」，见 finally） */
        let driveError: unknown = null;
        /**
         * 兜底收口的原因（review1 P3-2）：走到 finally 的兜底 = closeTurn **没跑到**，
         * 此处按**可证的事实**分类，不再借用 ##305 的"消费端断开"（此处与消费端无关）：
         *   · 驱动抛异常（装配期 / 流异常）→ `error{drive-turn, message}`
         *   · 显式中断（用户 cancel / 上游 abort）→ `aborted{source}`
         *   · 两者皆非却没走完 → `interrupted`（未正常收尾）
         * 幂等：closeTurn 正常收口过时 turn 已清，这个原因不会被用上（noteTurnEnd 只刷新心跳）。
         */
        const fallbackEndReason = (): TurnEndReason => {
            if (driveError != null) {
                return {
                    type: "error",
                    data: {
                        source: "drive-turn",
                        message: driveError instanceof Error ? driveError.message : String(driveError),
                    },
                };
            }
            if (ctrl.signal.aborted) return { type: "aborted", data: { source: abortSource(ctrl.signal, "abort") } };
            return { type: "interrupted", data: {} };
        };
        try {

            // 落盘与投递解耦：sink 在 emission 时直接写文件并广播，即使消费端提前断开，
            // 日志也不丢尾、别的窗口也照样看得见（唯一落盘点，见 opsSink 头注）
            const sink = this.opsSink(taskUri);
            // ── 先收敛上一轮遗留：tool 的业务终态 + 结构开口（写进 ops，而不是投影时现造）──
            // 不收敛的后果：每次重建历史都现场合成一句「未完成→请重试」，agent 重载会话后
            // 会把被截断的命令再跑一次（任务 92 的「一对话就自杀」）。落盘后它变成已结束的
            // 历史事实，投影与 UI 都只是翻译它。
            // 结构开口（danglingStopPatches）也在这里补，不只在加载时补：自愈原先只挂
            // getSession（每进程一次），于是"上一轮没闭合"能一直挂到主进程重启（生产实测：
            // 开口 turn 跨越 9 轮、挂了 6 天）。此刻 sess.running 已由上方互斥守卫保证为空 ——
            // 上一轮真在跑的话新消息连这个函数都进不来 —— 所以未 stop 的块必是残留
            // （崩溃 / 被杀 / 轮次被中途 abort）。
            for (const op of this.healResidualOps(sess)) {
                sink(op);
                sess.store.apply(op);
                publish(op);
            }

            // ── 轮次循环：首轮 = 调用方消息，之后各轮 = 插话队列喂进来的消息 ──
            // 轮末队列非空则自动开下一轮（用户不必再敲回车），且**一次把队列发完**：
            // 排队多条的心愿是"一起告诉它"，拆成多轮只会多几次请求、多个轮次边界。
            // seed 给出 = 用调用方指定的开场（队列内容）；否则就是调用方这一条 message
            let pending: TurnInput[] =
                seed && seed.length > 0
                    ? seed
                    : [
                          {
                              text: message,
                              kind: "user",
                              ...(origin?.author ? { author: origin.author } : {}),
                              ...(origin?.room ? { room: origin.room } : {}),
                          },
                      ];
            // ── 房间上下文（##377 第 25/26 刀）──────────────────────────────────
            // 病灶：第 18 刀的「本房间近期发言」只在**被投递**时注入 ⇒ 成员**自己起一轮**
            // （任务页点跑 / 定时任务 / CLI 一句话）读不到房间刚才聊了什么。
            //
            // ⚠ 第 26 刀起注入点是 **runtime 变量单元**（`room.members` / `room.recent`），
            //   **不再拼进 user 正文**：正文是发送时刻快照、且进会话历史（压缩会当人话改写、
            //   回放分不清谁说的）；runtime 是带类型的 YAML 信封，每轮现拼、按 place 增量。
            //   于是「自起 / 投递」两条路径在这里**同一处产出**，不再需要 `isDelivery` 那种
            //   「正文里是不是已经带了」的隐式判据（第 25 刀 lab 实测过它漏一次就注入两遍）。
            //
            // 看哪间房：自起 = 本任务自己的房间；**投递 = 来源房间**（`origin.room.roomId`）——
            // 那才是"刚才谁跟我说了什么"发生的地方。排除正文里那一条（`sayId`），避免同一句话出现两次。
            //
            // 水位：自起轮**成轮之后**前移到流尾（宁可重复不可漏，见 `commitSelfStartContext`）；
            // 投递轮**不在这里前移**（归 `room-service`，它按 `sayId` 前移）—— 两边都动会把水位往回拨。
            let ctxCommit: (() => void) | null = null;
            let roomValue: RoomRuntimeValue | null = null;
            try {
                const fact = roomRuntimeFact({
                    roomId: origin?.room?.roomId ?? taskUri,
                    taskUri,
                    ...(origin?.room?.sayId ? { sayId: origin.room.sayId } : {}),
                });
                if (fact) {
                    roomValue = fact.value;
                    if (!origin?.fromDelivery) {
                        const f = fact;
                        ctxCommit = () => commitSelfStartContext(f.roomId, f);
                    }
                    console.log(
                        `[local-agent] 房间上下文 ${fact.roomId} → runtime.room：${fact.items} 条 / 省略 ${fact.omitted} 条`,
                    );
                }
            } catch (e) {
                console.error(`[local-agent] 房间上下文读取失败（本轮照常发送）${taskUri}:`, e);
            }
            for (let round = 0; pending.length > 0 && !ctrl.signal.aborted; round++) {
                // 手动驱动内层生成器（而不是 `yield*` 委托）：委托会把 op 直接交给消费端，
                // 跳过这里的 `sess.store.apply` —— 而 store 是本模块的**单一权威**
                // （wire = store = UI = LLM），漏一次 apply 会让下一轮重建 messages 时看不到
                // 上一轮的产出（实测症状：`InvalidPromptError: messages must not be empty`）。
                // 手动驱动同时还能拿到内层的返回值（failed），for-await 会把它丢掉。
                // 逐步用量记录的身份字段：这几项 chat() 时已知，但不进任何日志就答不出
                // 「哪种配置更省」（##211 §六.2）—— 尤其同一会话换模型/换面时。
                const inner = this.runTurn(taskUri, sess, pending, model, reasoningEffort, ctrl.signal, key, rm, sink, {
                    persona: personaId,
                    apiFace: apiOf(model),
                    contextLimit: contextLimitOf(model),
                    room: roomValue,
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
                        // 第一个 op（turn start）到 = 这一轮真开了 ⇒ 前移水位（见 `ctxCommit` 的注）。
                        // 在此之前崩 / 早退（超预算不发）都不前移 —— 下一轮重复注入，不漏。
                        if (ctxCommit) {
                            const commit = ctxCommit;
                            ctxCommit = null;
                            commit();
                        }
                        sess.store.apply(r.value);
                        publish(r.value);
                    }
                } finally {
                    // 驱动循环退出（内层正常收尾 / 抛错）：尽力把内层也关掉，别让它的收尾悬在半路。
                    // **消费端断开不走这里**（##305：它只退订），驱动照常跑完本轮。
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
                    // 结构性 op 批的纪律：**先整批落盘 + 收敛内存，再逐条投递**（同 runTurn 的 seal）。
                    // 逐条 sink→yield 在生成器被 return 展开时会被切半：start 落盘、stop 没落 → 盘上留个开口
                    // error 块（errorBlock 同一个坑）。少了 apply 则内存 store 与盘分叉 —— store 是
                    // 本模块的单一权威（见上方"手动驱动内层生成器"的注释）。
                    for (const op of ops) {
                        sink(op);
                        sess.store.apply(op);
                    }
                    for (const op of ops) publish(op);
                    break;
                }
                // 轮末**整批取走**：队列里剩下的全部（两种模式都算）作为下一轮的开场一次性发出。
                // 为什么不再"每轮一条"：用户排队 3 条的心愿是"这三句一起告诉它"，
                // 拆成 3 轮等于让模型对同一件事回 3 次，还平白多 2 次请求 + 2 个轮次边界；
                // 顺序仍取队列序（FIFO = 投递顺序，用户拖过序就按拖过的来）。
                // ⚠️ 这里**只读不取**：真正的出队发生在 runTurn 开场块 sink 之后（先记账再出队）——
                // 在这中间崩掉，最坏是下次重复投一遍，不会丢；反过来就是用户的话凭空消失。
                try {
                    pending = this.queue.list(taskUri).map((it) => ({
                        text: it.text,
                        kind: it.mode,
                        steerId: it.id,
                        ...(it.author ? { author: it.author } : {}),
                    }));
                } catch (e) {
                    console.error(`[local-agent] 插话队列读取失败，停止自动续轮 ${taskUri}:`, e);
                    break;
                }
                if (pending.length === 0) break;
            }
            done = true;
            // llm dump 移到 finally（见那里：链式 return 会截断 try 尾，finally 才是每条退出路径的保证）
        } catch (e) {
            // 只记因、不吞：原样再抛，由 chat() 的 `.catch` 写进 run.error（错误仍经流上抛）。
            driveError = e;
            // R5（##305 review2 → 本任务收口）：**此刻**没有任何订阅者时，这条异常将无出口 ——
            // chat() 的 `throw run.error` 落在已经 return 的生成器上（消费端早走了），
            // 结果是一个真实的驱动故障在日志里一片空白。所以在这里判一次并显式上报。
            // 判据必须用 `run.subs` 的**当下值**：finally 里会 `run.subs.clear()`，
            // 等到 chat() 那边再看就恒为空（人人都成"无订阅者"）。
            if (run.subs.size === 0) {
                console.error(`[local-agent] 轮次驱动异常且无人订阅（异常仅此可见）${taskUri}:`, e);
            }
            throw e;
        } finally {
            // ⚠️ 这里**不再**因「消费端断开」而 abort（##305）：轮次由本管理器独立驱动，
            // 消费端只是订阅者 —— 断开只退订（见 chat 的 for-await）。此处 abort 只在
            // **驱动自身异常**（done 未置位）时兜底，停掉上游不让它空转。
            // （AbortController.abort() 按规范不抛错，此处无需 try/catch）
            if (!done) ctrl.abort();
            sess.running = null;
            // 轮末落盘：**append-only 全量日志**（不再整份覆盖、不再受压缩边界影响）。
            //   时刻合法：本轮的 turn 块已在 runTurn 的 finally 里 stop ⇒ 内容此后不再变
            //   （「turn 已 stop 即定稿」）。中断 tool 块的收敛发生在下一轮开场，但它只改
            //   status/output 字段，而投影按 status 分流（见 local-blocks）⇒ 收敛前后 append
            //   的字节逐字相同，不必等它。
            // ⚠️ 必须在 finally、不能只放在 try 尾 —— 用户点停止（`cancel()` → `ctrl.abort()`）会让
            // 内层生成器被 return 展开，把 try 的后半段**整段截断**（任务 201 R1-S1：旧实现因此在
            // 主动停止后既缺 turn 的 stop、也缺这份 dump）。finally 无 yield，不会被吞没，
            // 每条退出路径都能留下最后一轮。
            // 空树跳过：装配期就抛错时块树未动，什么也不该写。
            if (sess.store.roots().length > 0) this.appendLlm(taskUri, sess);
            // ⚠️ 兜底注销活跃轮次 —— **不能只依赖 runTurn 的 closeTurn**：
            //   runTurn 里 try{streamText} 之前的那些步骤（装配系统上下文、读模版、算 cwd）
            //   都不在 try 覆盖内，任何一步抛错就等于跳过 closeTurn → 注册表留下僵尸 turn。
            //   以前这只影响"崩溃现场"的可读性（UI 看的是本地 running，异常时它会被复位）；
            //   但现在 UI 把 agent.local.running 当**运行态真值**（session 194），僵尸会表现为
            //   「永远显示生成中 + 停止按钮点了没反应」，用户只能重启。
            //   noteTurnEnd 幂等：closeTurn 已收口时（turn 已清）这里只刷新 lastActivity。
            //
            // 结束原因**不能借用 `aborted{detached}`**（review1 P3-2）：那是 ##305 的"消费端断开"
            // 语义，而这条路径恰恰与消费端无关 —— 走到这里意味着 **closeTurn 压根没跑到**
            // （装配期抛错 / 流异常 / 生成器被展开）。故按可证的事实分三类：
            sessionRegistry.noteTurnEnd(taskUri, fallbackEndReason());
            // 归档本轮（##305）：注销注册表 + 关掉所有订阅流（消费端据此正常收尾）。
            // 放在 noteTurnEnd 之后：先让「运行态真值」翻下去，再放消费端走完。
            this.turns.delete(taskUri);
            for (const s of run.subs) s.close();
            run.subs.clear();
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
        rm: ResolvedModel,
        sink: (op: Op) => void,
        /** 落盘身份（人物/面/窗口）：同一会话可换模型，故它是**行**的属性（##211 §六b.6） */
        identity: {
            persona: string;
            apiFace: LocalModelApi;
            contextLimit?: number;
            /** 房间上下文（##377 第 26 刀）：`roomRuntimeFact().value`；`null` = 本任务没有房间 */
            room?: RoomRuntimeValue | null;
        },
    ): AsyncGenerator<Op, { failed: boolean; turnId: string }, void> {
        const turnId = `t${Date.now()}`;
        const cwd0 = resolveCwdWithNote(diyHome(), taskUri).cwd;
        // 轮次事实的**唯一**登记点（##240 review1 P2-3：runtime-context 的 activeTurns 已收敛为
        // 本注册表的投影，故此处不再另调它 —— 两份由同一批调用点驱动 = 迟早漂移）。
        sessionRegistry.noteTurnStart(taskUri, { turnId, model, cwd: cwd0 });
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
        /**
         * 结构性 op 批的落盘纪律：**先把整批 sink 完，再逐条投递**。
         *
         * 为什么必须整批：生成器被 return 展开（轮次被中断 / 驱动收尾）时**只执行到 yield 就停**（见 closeTurn
         * 头注）。一个块的 start/delta/stop 若逐条 `yield* emit`，断开能正好切在中间 —— 盘上留下
         * "开口块"（生产实测：error 块 start 落了、delta/stop 丢了，"本轮已取消"那句话凭空消失，
         * 只剩一个永远转圈的块）。结构性 op（一个块的完整生命周期）是原子单位，必须先全部落盘。
         * 流式 delta 不在此列：它天生逐条即时投递，单条 delta 不构成结构。
         *
         * 这里**不**做 `sess.store.apply`：正常路径由 chat() 的驱动循环在 yield 时 apply。
         * 若断开恰好切在本批中途，内存 store 会少 apply 尾巴（盘上是完整的）—— 由"开新一轮时的
         * 残留收敛"（chat() 开场的 healResidualOps）补齐，盘与内存不会永久分叉。
         */
        const seal = function* (ops: Op[]): Generator<Op, void, void> {
            for (const op of ops) {
                sink(op);
                if (op.op === "start") started.add(op.id);
            }
            for (const op of ops) yield op;
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
        const errorBlock = function* (
            source: string,
            text: string,
            extra?: Record<string, JSONVal>,
        ): Generator<Op, void, void> {
            const id = `${turnId}_e${++eN}`;
            yield* seal([
                { op: "start", id, kind: "error", parent: turnId, meta: extra ? { source, ...extra } : { source } },
                { op: "delta", id, fields: { message: text } },
                { op: "stop", id },
            ]);
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
        // 本轮**最后一步**的生成速度（tok/s = 该步输出 ÷ (响应耗时 − TTFT)，口径见 shared/usage.stepRate）。
        // 为什么要进 turn patch：状态栏的 ⚡ 要能"没在跑时也留在那儿"（老的速度不消失），
        // 而流内部的 token 计数拿不到 ⇒ 只能每步落一次、由 UI 显示最后一次实测值。
        let lastStepRate: number | null = null;
        // 轮均速度（##349）的 Σ 累加：各步总输出与各步响应耗时（含首字等待）。
        // 每步结束时重算一次 → 直播中也在长，轮末即为该轮平均。
        let rateOutSum = 0;
        let rateMsSum = 0;
        let turnRate: number | null = null;
        // 本轮累计金额。**一步都没价目 → 保持 null**（页脚显示「$—」）：
        // 早先这里初始化成全 0 对象、并且把无价目的步按 0 计入 —— 于是"没价目"被画成"$0.0000"，
        // 正是 ##372「会话金额恒为 0」的显示形态。
        let turnCost: CostBreakdown | null = null;
        // 本轮**无价目**的步数：只计数，由页脚标注"合计是部分和"（##372 附带要求 1）
        let turnUnpriced = 0;
        // 收尾原因追踪：步数耗尽检测（最后动作是 tool 且 step 用满 = 模型还想干活被掐）
        let lastAct: "none" | "text" | "tool" = "none";
        /**
         * 本轮**结束原因**（##288 拍板①）：closeTurn 时 patch 进 turn 块。
         *
         * `null` = 尚未判定。判据分散在流循环的几条分支里（finish / error / abort / catch），
         * 一旦写入就**粘住**（`setEndReason` 先到先得）：`error` 之后照常会收到 finish，
         * 那是同一次流的收尾，不是新结论 —— 后者不许把 error 降级成 completed。
         *
         * 兜底（closeTurn）：跑完流却没写（被中断 / 崩溃）见 `streamDone`。
         */
        let endReason: TurnEndReason | null = null;
        /** 流循环是否**正常跑完**（区别「return 展开」：那时内层 for-await 被丢弃，不会置位） */
        let streamDone = false;
        const setEndReason = (r: TurnEndReason): void => {
            if (endReason === null) endReason = r;
        };

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
            // ⚠️ `meta.steer` 这个键名有两处消费：renderer 的 `applyOpsFrame` 用「带 steer 标记的
            // user 块到达」判定"插话已投递 → 重拉队列快照"（见 localChatStore 的 sawSteerDelivered），
            // 以及这里渲染插话样式。改键名必须**同时**改那处，否则横条会一直挂着"待发送"
            //（模型其实已经看见了）—— 症状静默、只表现为 UI 落后。
            return [
                {
                    op: "start",
                    id,
                    kind: "text",
                    parent: turnId,
                    meta: {
                        role: "user",
                        steer: item.mode,
                        steerId: item.id,
                        ...(item.author ? { author: item.author } : {}),
                    },
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
                    sessionRegistry.noteActivity(taskUri);
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
         * 绕过 finally → 注册表（session-registry）留僵尸轮次、落盘 ops 缺 turn 的 stop、审计缺 turn-end。
         *
         * ⚠️ 副作用必须**同步做完，且在任何 yield 之前**。原因：生成器被 return 展开（轮次被中断 /
         * 驱动收尾）时，finally 里只执行到**第一个 yield** 就把控制权交回调用方
         * —— 若把「落盘 stop / noteTurnEnd / 审计」写在 `yield* emit(...)` 之后，它们全都不会执行
         * （实测：`{stop 落盘后 yield}` 的写法在 return 展开下只会执行到 yield，审计一行不跑）。
         * 所以顺序固定为：① sink（同步落盘）② noteTurnEnd / 审计（同步）③ 尽力 yield 给还活着的消费端。
         */
        const closeTurn = function* (currentStepId: string, steps: number): Generator<Op, void, void> {
            const ops: Op[] = [];
            // 轮次结束原因（该轮事实，##288）：正常分支已写好；没写 = 流没跑完（被中断 / 崩溃）
            // → `aborted{detached}` —— 生成器被 return 展开时唯一可证的事实。
            const reason: TurnEndReason = endReason ?? (streamDone ? { type: "completed", data: {} } : { type: "aborted", data: { source: "detached" } });
            // 三档判据（##394）：轮末是「异常能到达用户 / 日志」的边界 —— 先分类，再随审计落痕。
            // **只加映射、不动 `TurnEndReason` 值域**（判据归 shared/error-triage；预期内 = triage null）。
            const endTriage = triageOfTurnEnd(reason);
            // ── 本轮的开口 tool 块先钉成终态（##375）──
            // 取消（用户停止 → `cancel()` → ctrl.abort）会掐断 LLM 流：SDK 再也发不出这条工具
            // 调用的 tool-result / tool-error ⇒ 块停在 `status:"running"`、收不到 stop（UI 上就是
            // 一行「停不掉的工具」，且它会以"未完成"的形状进历史）。这里是**轮次唯一收口**
            // （正常 / 中断 / 生成器被 return 展开三条路都走它），故在此收敛。
            // 正常收尾时本轮没有开口 tool 块 → 恒为空批，不动既有语义。
            ops.push(...interruptedToolPatchesOfTurn(sess.store, turnId));
            ops.push({ op: "patch", id: turnId, fields: { endReason: reason } });
            // 轮次耗时（该轮事实）：turnId 内嵌开始毫秒（`t${Date.now()}`）→ 收尾此刻
            const durationMs = Date.now() - Number(turnId.slice(1));
            ops.push({ op: "patch", id: turnId, fields: { durationMs } });
            if (currentStepId !== turnId) ops.push({ op: "stop", id: currentStepId });
            ops.push({ op: "stop", id: turnId });
            // ① 同步副作用（无 await、无 yield）：无论走正常收尾还是 return 展开，这一段必定执行完
            for (const op of ops) {
                sink(op);
                // 块树同步收敛（stop 幂等）：closeTurn 的 op 由内层产出、**不经驱动的 apply 循环**
                // （驱动只 apply 它从内层 next() 收到的 op）—— 盘与内存权威（store）须在此一致，
                // 下一轮 blocksToMessages / 下降沿 reload 都读它
                sess.store.apply(op);
            }
            // 注册表收口（R5）：只清 turn、**条目保留**（turnCount +1 / 记末轮 endReason）。
            // 放在同一段同步副作用里，与 closeTurn 的其他落定动作同生共死。
            sessionRegistry.noteTurnEnd(taskUri, reason, { steps, tokens: acc.total });
            appendAudit(diyHome(), {
                phase: "turn-end",
                taskUri,
                model: model,
                result: `steps=${steps} usage=${acc.in}/${acc.out} cached=${acc.cached}`,
                // 三档判据（##394）：`null`（预期内）不写，别在审计里制造"每轮都是一件事"的假象
                ...(endTriage.triage ? { triage: endTriage.triage } : {}),
                ...(endTriage.code ? { code: endTriage.code } : {}),
            });
            // ② 尽力投递：消费端还在就让它看到 stop；已断开则在此停住 —— 状态早已一致（①已完成）
            for (const op of ops) yield op;
        };

        // 轮次事实：模型 + 思考级别（渲染时读它署名/展示档位，不读当前配置 —— 任务 196 的教训）
        yield* emit({ op: "start", id: turnId, kind: "turn", meta: { model: model, reasoningEffort } });

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
        const globals = assembleGlobals(diyHome(), projectFromUri(taskUri), {
            taskUri,
            room: identity.room ?? null,
        }) as unknown as Record<string, unknown>;
        // 划分规则读**真源**（$DIY_HOME/context.yaml；缺失/损坏则推荐名单 + 出声）——
        // 与上下文树页读的是同一份，所以页面上看到的 system/runtime 划分就是这里会用的划分。
        const delivery = buildDelivery(globals, loadSystemPlaces(diyHome()));

        // ── 每步重算上下文（##310）──────────────────────────────────
        // 轮首这份 delivery 原本整轮复用 → 长轮次里变量变了模型仍按旧值干活（几小时的 tool 循环
        // 全建在过期数据上）。prepareStep 每步重算一次，**变了才注入**（没变不动 ⇒ 前缀缓存只在
        // 真变那步失效）。system 与 runtime 各走各的通道（见 prepareStep）。
        const rebuildDelivery = (): Delivery => {
            const g = assembleGlobals(diyHome(), projectFromUri(taskUri), {
                taskUri,
                room: identity.room ?? null,
            }) as unknown as Record<string, unknown>;
            return buildDelivery(g, loadSystemPlaces(diyHome()));
        };
        // 上一步投递的两个容器文本（比较基准；初值 = 轮首这份）
        let prevSystemText = delivery.system.text;
        let prevRuntimeText = delivery.runtime.text;
        // runtimeDiff 的比较基准 = **本轮首步投出去的那份 runtime**（模型上下文里就是它）。
        // 不用跨轮游标：跨轮变化已由本轮首步的**全量** runtime 带上，再说一遍是噪音。
        let prevRunSnap: CtxSnapshot = { tree: delivery.tree, valueHashes: delivery.valueHashes };

        // 变更历史（##310 二版）：每步**有变才写**；一段会话的起点 = 一条 baseline（整棵树）。
        // 变更单位 = 原子单元（`chain` 整体一条，不下钻数组 —— 原子字段要变一起变）。
        const ctxUnits = atomicUnitPaths();
        let ctxSeq = lastCtxLogSeq(taskUri);
        // 该不该写起点：还没有二版记录（新任务 / 从没写过的新格式），或有人显式要求重新起算
        // （会话清零、`diy context rebaseline`）。**每轮只在轮首判一次**：轮中途置的标记下一轮生效。
        let ctxBaselineWritten = hasV2CtxLog(taskUri) && !this.rebaselinePending.has(taskUri);
        // 变更比较的基准 = **上一次真发**的值（跨轮游标；缺省才退回本轮的轮首值）。
        // 用轮首值当基准就只能看见"轮内变化"，跨轮变化（改完正文再来问）会永远漏掉 —— 见字段注释。
        // 内存里没有（进程刚起）= 尝试从盘上**播种**上一次真发的值；播不出来才退回本轮的轮首值。
        let ctxPrevSnap: CtxSnapshot =
            this.ctxSnap.get(taskUri) ??
            this.seedCtxSnap(taskUri) ?? {
                tree: delivery.tree,
                valueHashes: delivery.valueHashes,
            };
        // 预算判据与模版线**共用同一个函数**（services/prompt-registry 的 systemOverBudget）：
        // 曾经这里是内联的 `bytes > budget`，逻辑等价但两处各写一遍 —— 日后任何一侧改口径
        // （比如"等于预算算不算超"）都会悄悄分叉，而单测只覆盖得到被调用的那一侧（209 第 3 轮 R-1）。
        const over = systemOverBudget(delivery.system.bytes, contextLimitOf(model));
        if (over) {
            const kb = (n: number) => (n / 1024).toFixed(1);
            const budgetMsg =
                `系统上下文超出预算（${kb(over.used)} KB > ${kb(over.budget)} KB），本轮未发送。` +
                `请精简项目 AGENTS.md，或在上下文树页把易变变量划到 runtime。`;
            setEndReason({ type: "error", data: { source: "budget", message: budgetMsg } });
            yield* errorBlock("budget", budgetMsg);
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
            yield* seal([
                {
                    op: "start",
                    id: uid,
                    kind: "text",
                    parent: turnId,
                    meta: {
                        role: "user",
                        ...(item.kind === "user" ? {} : { steer: item.kind, ...(item.steerId ? { steerId: item.steerId } : {}) }),
                        // 署名（##166 §40 A）：有则落，无则**不落键**（省略 = 本任务本人，
                        // 老数据 / 任务页正常发言都不带，读侧据此区分左右气泡）
                        ...(item.author ? { author: item.author } : {}),
                        // 房间来源（##377 第 23 刀）：`{ roomId, sayId }` —— 收件方据此知道这句话
                        // **是别的房间投过来的**（不是本任务的人在说话）。同样有则落、无则不落键。
                        ...(item.room ? { room: item.room } : {}),
                    },
                },
                { op: "delta", id: uid, fields: { content: item.text } },
                { op: "stop", id: uid },
            ]);
            // 落位即出队（**先 sink 再出队**，与 next-step 的 landClaimedSteers 同一条铁律）：
            // sink 是"这句话进对话流"的权威，出队是"它不再是待办"。反过来一旦崩在中间，
            // 队列里没有、ops 里也没有 —— 用户白打。现在最坏是重复投一遍（可恢复）。
            if (item.steerId) {
                try {
                    this.queue.remove(taskUri, item.steerId);
                    sessionRegistry.noteActivity(taskUri);
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
        // 该步的流形状（##288）：每步重置，随该步的用量账一起落盘
        let shape = newShape();
        const rawSink = (row: Record<string, unknown>): void => {
            if (!raw) return;
            try {
                appendFileSync(raw, `${JSON.stringify(row)}\n`, "utf-8");
            } catch (e) {
                console.error(`[local-agent] raw dump 写入失败 ${raw}:`, e);
            }
        };

        let failed = false;
        // 本轮是否出现过**流内 error part**（SDK 以 part 报错、**不抛异常**，见下面 `case "error"`）。
        // 环境感知（##384）用它当闸门：这种失败之后流仍会**正常收尾**，若不设闸门就会在收尾处
        // 把刚记下的连败清零 —— 连败永远到不了阈值，「网络不可达」红条永远不亮（实测踩过）。
        let streamErrorPart = false;
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
            const hist = this.deliveryHistory(taskUri, sess.store);
            const sent: ModelMessage[] = normalizeUserRuns(
                withRuntime(hist.messages, delivery.runtime.text, hist.note, renderSummaryPart(this.effectiveSummary(taskUri))),
            );
            // 本轮的**投递选择事实**（配置驱动压缩）：分表用它标注「本步（轮首）投递被压过」（##272 B1）。
            // 与 compact 事件解耦 —— 事件只在触发/手动时写；这里每轮首都有（投递本就无条件按当前配置筛选）。
            const selPolicy = loadAutoCompact(diyHome()).policy;
            const allMsgs = projectAll(sess.store);
            const sel = selectHistoryByBudget(allMsgs, selPolicy.modeData.budgetBytes, optsFor(selPolicy, taskUri));
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
            this.noteTraffic(taskUri, turnId, rm, 2);
            const result = streamText({
                model: this.modelFor(rm, key),
                system: delivery.system.text,
                messages: sent,
                tools,
                stopWhen: stepCountIs(L.maxSteps),
                abortSignal: signal,
                headers: { "x-opencode-session": sessionIdOf(taskUri) },
                maxOutputTokens: modelMax, // 按模型硬上限（models.dev），reasoning 模型会先吃一部分
                // none 用 AI SDK 标准关闭语义；"default"（平台默认）**什么都不发**（交上游默认行为，
                // 见 shared/model-config.DEFAULT_EFFORT）；其他值由 OpenAI-compatible provider 原样转发。
                // provider 配置可以提供 minimal/xhigh/max 等非通用值，不能压缩成固定枚举。
                ...(reasoningEffort === "none"
                    ? { reasoning: "none" as const }
                    : reasoningEffort && reasoningEffort !== "default"
                      ? {
                            // 命名空间必须与 provider 包一致（##184 坑 4）：
                            // chat 面 = @ai-sdk/openai-compatible（openaiCompatible）；
                            // responses 面 = @ai-sdk/openai（openai）。写错面 → 上游收不到档位。
                            providerOptions:
                                rm.api === "responses"
                                    ? { openai: { reasoningEffort } }
                                    : { openaiCompatible: { reasoningEffort } },
                        }
                      : {}),
                maxRetries: 2,
                // 研究开关：把**上游原始 chunk**（归一之前的 SSE 载荷）也塞进 fullStream 的 raw part。
                // 只有 raw dump 开着时才要 —— 它能把"ai-sdk 归一丢了什么"变成可核对的证据（##288）。
                ...(raw ? { includeRawChunks: true } : {}),
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
                    if (signal.aborted) return {};
                    let instructions: string | undefined;
                    let nextMessages: ModelMessage[] | undefined;
                    // ── 上下文及时刷新（##310）──
                    // 每步重算；**变了才注入**（没变什么都不返回 ⇒ 不砸前缀缓存）：
                    //   · system  −→ instructions（SDK 的 system 覆盖，carry forward 到后续步）
                    //   · runtime −→ 就地替换尾部那条 user 容器（它是"当前值"，不是历史）
                    try {
                        const fresh = rebuildDelivery();
                        // ── 变更历史（##310）：每步一条，**有变才写** ──
                        // 首条写 baseline（整棵树，会话起点）；之后只写真变的步 —— "什么都没变"不落盘。
                        const stepNo = stepNumber + 1;
                        const ref = { turnId, stepId: `${turnId}_s${stepNo}`, step: stepNo };
                        if (!ctxBaselineWritten) {
                            appendCtxLog(taskUri, {
                                seq: ++ctxSeq, type: "baseline", ts: new Date().toISOString(), model,
                                wireVersion: fresh.wireVersion, ref, data: { tree: fresh.tree },
                            });
                            // 标记是一次性的：写完即销，下一步起走正常「有变才写」。
                            this.rebaselinePending.delete(taskUri);
                            ctxBaselineWritten = true;
                        } else {
                            const changes = changesOf(ctxPrevSnap, fresh, ctxUnits);
                            if (changes.length > 0) {
                                appendCtxLog(taskUri, {
                                    seq: ++ctxSeq, type: "changed", ts: new Date().toISOString(), model,
                                    wireVersion: fresh.wireVersion, ref, data: { changes },
                                });
                            }
                        }
                        ctxPrevSnap = { tree: fresh.tree, valueHashes: fresh.valueHashes };
                        this.ctxSnap.set(taskUri, ctxPrevSnap);
                        if (fresh.system.text !== prevSystemText) {
                            prevSystemText = fresh.system.text;
                            instructions = fresh.system.text;
                        }
                        if (fresh.runtime.text !== prevRuntimeText) {
                            // runtime 变了 → **追加**一条只含 `runtimeDiff:` 的信封（用户 2026-10-15
                            // 「runtime 变 → 追加什么变了，形态 = 与实际用户消息分离的 user 消息」）。
                            // 为什么追加而不是就地把旧容器换掉：模型要的不只是新值，还要**知道哪几个
                            // 单元变了** —— 就地替换只给一坨新值，变化本身看不见。
                            // 基准 = **本轮首步投出去的那份**（模型上下文里的就是它），不是跨轮游标：
                            // 跨轮的那些变化已由本轮首步的**全量** runtime 覆盖，重复说一遍是噪音。
                            const changedRun = changesOf(prevRunSnap, fresh, ctxUnits)
                                .map((c) => c.path)
                                .filter((p) => isRuntimePlace(fresh.tree, p));
                            const diff = runtimeDiffDelivery(fresh.tree, changedRun);
                            prevRuntimeText = fresh.runtime.text;
                            prevRunSnap = { tree: fresh.tree, valueHashes: fresh.valueHashes };
                            if (diff.text) {
                                nextMessages = [...messages, { role: "user" as const, content: diff.text }];
                            }
                        }
                    } catch (e) {
                        // 重算失败**不阻断**发送：这是增强（及时性），不是正确性前提 —— 沿用上一步的投递
                        console.error(`[local-agent] 每步重算上下文失败（沿用上一步投递）${taskUri}:`, e);
                    }
                    // ── 插话注入（原逻辑；只在第二步及之后）──
                    if (stepNumber > 0) {
                        const items = claimStepSteers();
                        if (items.length > 0) {
                            nextMessages = [
                                ...(nextMessages ?? messages),
                                ...items.map((it) => ({ role: "user" as const, content: it.text })),
                            ];
                        }
                    }
                    if (instructions === undefined && nextMessages === undefined) return {};
                    return {
                        ...(instructions === undefined ? {} : { instructions }),
                        ...(nextMessages === undefined ? {} : { messages: nextMessages }),
                    };
                },
            });

            try {
                for await (const part of result.fullStream) {
                    rawSink({ kind: "part", seq: ++rawSeq, ts: new Date().toISOString(), part });
                    switch (part.type) {
                        case "start-step":
                            shape = newShape();
                            // 插话落位点：**唯一无歧义的位置** —— start-step 在流里保证排在上一步的
                            // 所有 part 之后，而"下一步"还没产出任何内容。认领发生在 prepareStep（可能
                            // 早于消费端处理完上一步的 part），落位必须等到这里，否则插话块会插到
                            // 上一步未完的内容前面（落盘顺序与 UI 顺序都会错）。
                            landClaimedSteers();
                            yield* flushSteer();
                            stepN++;
                            stepId = `${turnId}_s${stepN}`;
                            sessionRegistry.noteTurnStep(taskUri, stepN);
                            yield* emit({ op: "start", id: stepId, kind: "step", parent: turnId });
                            break;
                        case "reasoning-start": {
                            markShape(shape, "r");
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
                            markShape(shape, "t");
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
                            markShape(shape, "x");
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
                            // 终态批（输出 + status + stop）原子落盘：切在中途会留下"状态已 done、
                            // 块还开着"的 tool 块，而自愈只补 stop，不补那句输出
                            yield* seal([
                                { op: "delta", id: part.toolCallId, fields: { output: outText(part.output) } },
                                { op: "patch", id: part.toolCallId, fields: { status: "done" } },
                                { op: "stop", id: part.toolCallId },
                            ]);
                            break;
                        case "tool-error": {
                            const id = (part as { toolCallId?: string }).toolCallId ?? stepId;
                            // 三档判据（##394）：工具失败是**另一条边界**（异常在这里第一次变成"给用户看的东西"）。
                            // 只分类 + 落痕，不改文案与状态语义（文案归 shared/turn-end，铁律 5）。
                            const tv = triageOf((part as { error?: unknown }).error);
                            console.warn(`[local-agent] tool-error triage=${tv.triage} code=${tv.code ?? "-"} ${tv.reason} (${taskUri})`);
                            if (id !== stepId) yield* ensure(id, "tool", stepId, { tool: "tool", status: "streaming" });
                            yield* seal([
                                { op: "delta", id, fields: { output: errText((part as { error?: unknown }).error) } },
                                { op: "patch", id, fields: { status: "error" } },
                                { op: "stop", id },
                            ]);
                            break;
                        }
                        case "error": {
                            const err = (part as { error?: unknown }).error;
                            const msg = errText(err);
                            // 模型不可用的**主路径**（实测：`[model_coming_soon]` 从这里来，不走 catch）
                            reportModelUnavailable(err, taskUri, identity.persona, model);
                            // 环境感知（##384）：网络层失败按**轮次**计连败（ENOTFOUND / ETIMEDOUT / …），
                            // 连续 N 次 → 顶栏「网络不可达」红条。上游 5xx 不算（那是服务端故障，网络通着）。
                            networkStreak.fail(err);
                            // 记下"本轮失败过"：这条分支只是 `break`，流之后仍会正常收尾（见 streamErrorPart 声明）
                            streamErrorPart = true;
                            setEndReason({ type: "error", data: { source: "llm", message: msg } });
                            // 把「这次失败对应哪条实际请求」一并记下：错误块据此直接跳到那条
                            // 请求/响应（能定位就定位，不靠用户猜 trace_id）。
                            const failId = traffic.latestFailure(sessionIdOf(taskUri));
                            yield* errorBlock("llm", msg, failId != null ? { reqId: failId } : undefined);
                            break;
                        }
                        case "abort": {
                            const src = abortSource(signal, "abort");
                            setEndReason({ type: "aborted", data: { source: src } });
                            yield* errorBlock("abort", abortText(src));
                            break;
                        }
                        case "finish-step": {
                            // 每步 usage：① 落一条独立账（usage.jsonl，逐步明细/金额的唯一来源）
                            // ② 累加进本轮桶（对话流页脚）
                            // zen 流尾 totalUsage 偶发缺失，逐步累加同时是双保险（见 finish 分支）。
                            const fsPart = part as unknown as {
                                usage?: UsageLike;
                                performance?: StepUsageRecord["performance"];
                                response?: { id?: string; modelId?: string };
                                finishReason?: string;
                                rawFinishReason?: string;
                            };
                            const su = fsPart.usage;
                            if (su) {
                                addStepUsage(acc, su as TurnUsage);
                                const b = bucketsOf(su);
                                turnBuckets = sumBuckets([turnBuckets, b]);
                                lastStepBuckets = b;
                                // **测不出就留着上一次的**：有的步没有输出 token（空回复 / 纯工具步），
                                // 直接赋 null 会把状态栏那枚 ⚡ 打回更早一轮（review ##253 小项2）。
                                lastStepRate = stepRate(fsPart.performance, b.outputTotal) ?? lastStepRate;
                                // 轮均累加（##349）：只计"有计时且确有输出"的步（与 `avgRate` 同判据）
                                const respMs = fsPart.performance?.responseTimeMs;
                                if (respMs != null && respMs > 0 && b.outputTotal > 0) {
                                    rateOutSum += b.outputTotal;
                                    rateMsSum += respMs;
                                }
                                turnRate = rateFromTotals(rateOutSum, rateMsSum);
                                // **按 response.modelId 查价**：上游可能路由改写模型（##211 §四.4.4）。
                                // 但回执多半是**裸 id**，裸 id 被 ≥2 个 provider 收录即歧义（##372）——
                                // 故先把回执模型**限定到本请求的 provider/account** 再查。**查不到即无价目**：
                                // 用户口径 2026-10-17「谁家的模型找谁家的价」——不回退、不猜 provider、
                                // 不拿别的东西的价冒充；依据落账 `priceBasis`/`priceRef` 供事后翻账。
                                const priced = findPricedModel(fsPart.response?.modelId, model);
                                const rates = ratesOfModel(priced.model, b.inputTotal);
                                const cost = rates ? costBreakdown(rates, b) : null;
                                // **无价目 ≠ 0**：只累加有价目的步，无价目的只计数（##372 附带要求 1）
                                if (cost) turnCost = turnCost ? sumCosts([turnCost, cost]) : cost;
                                else turnUnpriced++;
                                sessionRegistry.noteTurnUsage(taskUri, acc.total);
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
                                    ...(fsPart.rawFinishReason ? { rawFinishReason: fsPart.rawFinishReason } : {}),
                                    // 形状快照（观察位）：与这一步的 finishReason 同行，才能回答
                                    // 「没结论的那一步，形状到底是什么」（##288）
                                    streamShape: { ...shape },
                                    usage: snapshotUsage(su)!,
                                    ...(fsPart.performance ? { performance: fsPart.performance } : {}),
                                    rates: rates ? { ...rates, asOf: MODEL_COST_AS_OF } : null,
                                    cost,
                                    // 计价依据（##372）：`response` 命中回执 / `request` 回执缺失→按本请求模型 /
                                    // `none` 无价目（不回退）。**与 responseModel 同行**才能事后回答"这条 — 是怎么来的"
                                    priceBasis: priced.basis,
                                    ...(priced.model ? { priceRef: priced.model.ref } : {}),
                                    contextParts: ctxParts,
                                    // 投递选择事实**只在轮首**（stepN===1）：一轮只在轮首按当前配置重建投递，
                                    // 后续步复用同一份历史（##272 B1 / ##321）。
                                    ...(stepN === 1 ? { historySelection } : {}),
                                });
                                yield* emit({
                                    op: "patch",
                                    id: turnId,
                                    fields: { usage: turnUsagePatch(turnBuckets, lastStepBuckets, turnCost, identity.contextLimit, stepN, ctxParts, lastStepRate, turnRate, turnUnpriced) },
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
                                setEndReason({ type: "max-tokens", data: { maxOutputTokens: modelMax } });
                            } else if (stepN >= L.maxSteps && lastAct === "tool") {
                                notice = `达到 maxSteps=${L.maxSteps} 步上限，本轮强制收尾（模型仍在请求工具）；继续发消息可接力`;
                                setEndReason({ type: "max-steps", data: { steps: stepN, limit: L.maxSteps } });
                            } else {
                                setEndReason({ type: "completed", data: {} });
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
                                    fields: { usage: turnUsagePatch(turnBuckets, lastStepBuckets, turnCost, identity.contextLimit, stepN, ctxParts, lastStepRate, turnRate, turnUnpriced) },
                                });
                            }
                            // turn 的 stop 由 closeTurn 发（finally 里那一处）：收尾必须闭合
                            break;
                        }
                    }
                }

                // 流循环跑到这里 = 流**正常收尾**（无异常、无 return 展开）。置位供 closeTurn 兜底：
                // 若各分支都没写 endReason（provider 连 finish 都没发），至少有"跑完了"这个事实。
                streamDone = true;
                // 环境感知（##384）：这一轮跑通了 ⇒ 网络层连败清零、`network-down` 红条自动消。
                // 判据是"**轮次**成功"而不是"某个 HTTP 200"：一次请求成功不代表网络稳定，
                // 而一轮对话完整收尾足以证明链路可用。
                //
                // `!streamErrorPart` 这道闸门是必需的（实测踩过）：SDK 的网络失败以 **error part** 形式
                // 报出（不抛异常），流随后仍会正常收尾 —— 此时 `streamDone` 也是 true。若不设闸门，
                // 上一行刚计的连败会被这里立刻清零，连败**永远到不了阈值**，红条永远不亮。
                if (!streamErrorPart) networkStreak.succeed();
                // LLM 历史由外层 chat() 从块树统一重建（见 chat 末尾），此处不操作
            } catch (e) {
                // 取消（停止按钮 → cancel/abort；消费端断开不再走这里，##305）与真实错误分流：前者是预期收尾，后者记 error 块
                if (signal.aborted) {
                    const src = abortSource(signal, "abort");
                    setEndReason({ type: "aborted", data: { source: src } });
                    yield* errorBlock("abort", abortText(src));
                } else {
                    const msg = errText(e);
                    // ── 「模型不可用」的可见性（##369 ①）──
                    // 判据是 shared/model-unavailable 的**纯函数**（表驱动单测在同名 tests/core）：
                    // 只挑四类（模型未上架 / id 不认识 / 认证失败 / 配额），**上游 5xx 与网络超时不算**
                    // —— 那两类混进来会让 bar 天天亮（告警疲劳），且动作完全不同（该等，不是该配模型）。
                    // 这里只**产生一条事实**给顶栏 bar，不阻断流程：轮次照旧收尾、会话照旧留 error 块。
                    reportModelUnavailable(e, taskUri, identity.persona, model);
                    // 环境感知（##384）：网络层失败连败计数（判据在 shared/env-watch 纯函数）
                    networkStreak.fail(e);
                    setEndReason({ type: "error", data: { source: "stream", message: msg } });
                    yield* errorBlock("stream", msg);
                    failed = true;
                }
            }
            // 兜底 flush（安全网）：正常路径下 landClaimedSteers 之后紧接着就 flush 了，
            // 走到这里通常为空；留着是为了"将来新增别的投递点"也不会漏给消费端。
            yield* flushSteer();
        } finally {
            // ⚠️ 收尾**必须在 finally 里**（历史 bug 的复现版）：生成器被 return 展开（轮次被中断 /
            // 驱动收尾）时，try/catch 之后的顺序语句一律不执行 —— 那会留下未 stop 的 turn（UI 显示"本轮未完成"
            // + 重放时被 interruptedToolPatches 当成中断轮）、注册表里的僵尸轮次、缺 turn-end 审计。
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
        ? { messages: opts.messages, note: "" }
        : getLocalAgent().deliveryMessages(taskUri);
    // 与真发**逐字同形**：末条 user = 本轮输入 → 外面套**尾部信封**（history? + runtime + user），
    // 再合并相邻 user。别各插一条消息 —— 那样合出来是「YAML + 裸文本」，预览会撒谎。
    const messages: ModelMessage[] = normalizeUserRuns(
        withRuntime(
            [...hist.messages, { role: "user", content: opts.lastUser ?? "[仿真占位]真实下一轮此处为用户输入" }],
            opts.runtime ?? "",
            hist.note,
            renderSummaryPart(getLocalAgent().effectiveSummary(taskUri)),
        ),
    );
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
