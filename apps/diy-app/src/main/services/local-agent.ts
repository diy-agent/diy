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
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic, type FsLike } from "../core/atomic-write";
import { fieldNames, renderFieldDocs } from "@diy-agent/context/schema/schema-doc";
import { findInOpsFile, type FindResult, type FindScopes } from "./local-find";
import { diyHome, projectDir, projectFromUri } from "../core/state";
import {
    keyOf,
    hasAnySessionData,
    llmFile,
    llmLogRelPath,
    localDir,
    resolveSessionFile,
    sessionFileForWrite,
    sessionFilesToClear,
    sessionIdOf,
    sessionStateFile,
    streamPath,
    turnsFileRel,
    opsFile,
} from "../core/local-paths";
import { readJsonlTail } from "../core/jsonl-tail";
import {
    appendCompactionEntry,
    appendTurnRecord,
    checkOpsRef,
    clipTurnText,
    readBoundary,
    readTurnEntries,
    readTurnRecords,
    synthesizeTurnOps,
    type CompactionEntry,
    type TurnRecordState,
} from "./local-turns";
import { estimateTokensOf, normalizeHistoryLimit, selectCompactableRange } from "@diy-agent/compaction/history-limit";
import { retainTokensOf, triggerTokensOf } from "@diy-agent/compaction/select-kept-boundary";

// 路径实现只在 `core/local-paths`（= `@diy-agent/persistence`）一处 —— 测试也从那里取。
import { createOpsAppender, type OpsAppender, type OpsRef } from "@diy-agent/persistence";
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
    selectHistory,
    selectHistoryByCut,
    selectForDelivery,
    type BlockKind,
    type BlockNode,
    type BudgetSelection,
    type DeliveryOpts,
    type LocalModelMessage,
    type Op,
    type JSONVal,
    type TurnEndReason,
} from "./local-blocks";
import { decodeCursor, encodeCursor, isTurnStartAt, seekTurnStartAtOrBefore, seekWindowStart } from "./local-ops-seek";
import { appendAudit } from "./agent-audit";
import { addSystemEvent } from "./journal-store";

/**
 * 轮末「模型没机会说出口」的 code（##404 待办 3 的判据）。
 *
 * 只有这几类会进任务 journal（`author: system`）：共同点是**本轮缺收尾那句话**，
 * 事后查「为什么这轮没结果」时 `agent` 条目是空的。其余收尾（步数上限 / 上游报错 / 额度）
 * 模型自己看得见、会在对话里交代，写进 journal 只是重复。
 *
 * 与 `error-triage.ts` 的分工：那边说「要不要当事处理」，这里说「要不要留痕」—— 两把尺子，
 * 别合并（一个 defect 可能模型自己说清了；一个 external-unknown 可能恰恰没人说）。
 */
const TURN_SILENT_END_CODES: ReadonlySet<string> = new Set([
    "agent/aborted-detached", // 生成器被 return 展开（中断 / 驱动收尾）
    "agent/aborted", // 中断来源不明
    "agent/interrupted", // 流中断 / 崩溃恢复补 closer
    "agent/app-crash", // 宿主异常退出
    "agent/app-restart", // 宿主重启打断本轮
]);
import { capToolOutput, toolOutFile, toolOutFileCandidates, toolOutRelPath } from "./tool-output";
import { abortText } from "../../shared/turn-end";
import type { TurnGate, TurnGateDecision } from "../../shared/turn-gate";
import { triageOf, triageOfTurnEnd } from "../../shared/error-triage";
import type { DegradedCause, DegradedHistory, DegradedTier } from "../../shared/degraded-history";
import { errText } from "../../shared/error-report";
import { reportError } from "./error-report";
import { readCauseEvidence } from "./interrupted-cause";
import { classifyInterruptedCause, turnStartedAtOf } from "../../shared/interrupted-cause";
import { os } from "../os";
import { noShellHint } from "../os";
import { buildInvocation, preferredShell, shellSpecs, shellToolName } from "../os";
import type { ShellSpec } from "../os";
import { opsFeed } from "./ops-feed";
import { HUMAN_MEMBER_ID, type DeliveryOrigin, type TurnOrigin } from "../../shared/room";
// 「模型不可用」通知（##369 ①）：判据在 shared/model-unavailable，通知中心在 model-notice
import { modelNoticeHub, noticeFromError, unavailableNoticeFromLocal } from "./model-notice";
// 冷缓存提示（##477）：首步请求前算 gap、首步 usage 到手后回填成败（判据在 shared/cache-hint）
import { cacheHint } from "./cache-hint";
import { networkStreak } from "./env-watch";
import { AsyncQueue, withCleanup } from "./async-queue";
import { sessionRegistry } from "./session-registry";
// 轮首房间上下文（##377 第 25 刀）：**只读盘 + 水位**，不 import room-service（那条是反方向，
// 会造成循环 —— room-service 静态 import 本模块的 getLocalAgent）。
import { commitSelfStartContext, roomRuntimeFact, type RoomRuntimeValue } from "./room-context";
import { addStepUsage, newUsageAcc, setTurnUsage, type TurnUsage } from "./turn-usage";
// 自量（##404 / ##9 提案）：本进程里的「最近一步」账。记账点 = finish-step（与 appendUsage 同一处），
// 读点 = 每步重建上下文 —— 读时零 IO（理由见 services/self-usage.ts 头注）。
import { noteSelfStep, selfLastBuckets, selfOf } from "./self-usage";
// 冷缓存等待（##486）：上一步全冷 ⇒ 本步真发前等 1s（判据在 shared/warm-wait.ts）。
import { warmWaitIfCold } from "./warm-wait";
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
import { buildDelivery, type Delivery } from "@diy-agent/context/delivery";
// 纯 JS sha256（`@diy-agent/context/hash`）：tools 字节 hash 用得了 renderer 包的那个实现就够；
// 不为一个观测字段把 node:crypto 拉进 main 的依赖面（与 144 的"hash 可复现"同一条约定）。
import { sha256Hex } from "@diy-agent/context/hash";
import { assemblyHardCapBytes } from "../../shared/context/request-preflight";
import { estimateRequest, tighterHistoryCapBytes } from "../../shared/context/request-preflight";
import { chatEnvelope, isEnvelopeText, userEnvelope, withNotify, type NotifyItem } from "@diy-agent/context/envelope";
import { describeAnomalies, readLlmLog } from "../../shared/context/log-schema";
// ##491：provider 私有约定（补什么字段 / 要什么 header）全在策略层，应用层只问「这个端点要补什么」
import { bodyTransformFor, headersFor } from "@diy-agent/llm-provider/strategies";
import {
    autoCompactPolicyInput,
    detectAutoCompactTriggers,
    TRIGGER_TEXT,
    type AutoCompactConfig,
    type AutoCompactFacts,
    type AutoCompactIssue,
} from "@diy-agent/compaction/compact-config";
import {
    autoCompactFile,
    loadAutoCompact,
    loadAutoCompactDetailed,
    readAutoCompactText,
} from "../core/auto-compact-config";

import { appendContextStat } from "../core/context-stats";
import { traffic } from "../core/traffic";
import { appendCtxLog, hasV2CtxLog, lastCtxLogSeq, readCtxLogEntries } from "../core/context-changelog";
import { statFromStep } from "../../shared/context/stats";
import {
    atomicUnitPaths,
    changelogUnitPaths,
    changesOf,
    foldCtxTree,
    type CtxSnapshot,
} from "../../shared/context/changelog";
import type { DeliveryStepRecord } from "../../shared/context/steps";
import { segmentSystemSnapshotOf, segmentSystemTextOf, type SnapshotReason } from "../../shared/context/segment-snapshot";
import { stepDeltaOf } from "../../shared/context/step-delta";
import {
    clipSpecOf,
    clippedIdsOfEvent,
    compactPointOf,
    boundaryOfPoint,
    COMPACT_STATE_FILENAME,
    DEFAULT_REASONING_CLIP,
    estimateTokens,
    fmtBytes,
    makeDeliveryTransform,
    listTurnIds,
    normalizeCompactState,
    toolResultOf,
    type CompactTrigger,
    normalizePolicy,
    OPS_SCHEMA_CURRENT,
    parseCompactLog,
    resolveBoundary,
    utf8Bytes,
    type ClippedToolDetail,
    type CompactEventRecord,
    type CompactPlanSnapshot,
    type CompactLogEvent,
    type CompactPolicy,
    type CompactState,
    type DroppedTurnDetail,
    type EffectiveBoundary,
    type MeasureEventRecord,
    type RateSnapshot,
    type SizeSnapshot,
} from "@diy-agent/compaction/compaction";
import { layerFacts, type LayerRow, type RequestView } from "../../shared/context/request-view";
import {
    emptySummary,
    parseSummary,
    summaryExtractionPrompt,
    summaryPlaceholder,
    type SummaryData,
} from "@diy-agent/compaction/summary";
import { renderSummarySection } from "./prompt-registry";
import { assembleGlobals, systemOverBudget } from "./prompt-registry";
// read / write / edit 三个工具的实现已搬到 `@diy-agent/tools`（##514）：本文件只保留宿主的装配
// （注入 cwd / 预算 / 审计与 bash / job 这类带进程身份的工 —— 见 buildTools）。
import { buildTools as buildPackageTools } from "@diy-agent/tools";
// shell 工具（bash / pwsh）的**内核**也搬进了 `@diy-agent/tools`（##515 第 1 步）：
// 执行器 runBash / 结果头 / 工具定义都在那边，本层只注入宿主切面（审计、进程名册、job 账本）。
import {
    makeShellTool,
    markBashTruncated,
    runBash,
    type BashControl,
    type BashRun,
    type BashRunHooks,
    type ShellRuntime,
} from "@diy-agent/tools";
// 单测仍从本模块取（历史 import 路径不变）：实现真源在包内，这里只是转发。
export { runBash, markBashTruncated, DetachError } from "@diy-agent/tools";
export type { BashControl, BashRun, BashRunHooks, ShellSpec } from "@diy-agent/tools";
import { READ_MAX_BYTES } from "../core/file-read";
import { SteerQueue, fileSteerPort } from "../core/steer-queue";
import { DEFAULT_STEER_MODE, steerModeLabel } from "../../shared/steer-mode";
import { isHumanAuthor, type SteerItem, type SteerMode } from "../core/drafts";

import {
    apiOf,
    contextLimitOf,
    costOf,
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
import { personaOutputOverride, taskOutputOverride } from "../core/output-budget";
import { inboxEntryOf, inboxHub } from "./inbox";
import { DEFAULT_COST_ALARM, costAlarmsOf, newCostAlarmState, usdText } from "../../shared/cost-alarm";
import {
    OUTPUT_SCENE_DEFAULTS,
    describeOutputBudget,
    resolveOutputBudget,
    type OutputBudget,
    type OutputScene,
} from "../../shared/output-budget";
import type { InboxEntry } from "../../shared/inbox";
import { taskTurnGate } from "../core/turn-gate";
import { ensureReasoningReplay, isDeepSeekWire, type ReasoningReplayOpts } from "./reasoning-replay";
import { resolveModelKey } from "../core/model-runtime";
import { invariant } from "../../shared/error-triage";
import { runRegistry, type RunInfo } from "./run-registry";
import { effectiveBashArgs } from "../../shared/tool-args";
import { ownedGroups } from "./owned-groups";
import { foregroundBash } from "./foreground-bash";
import { runsOfTask } from "../../shared/run-status";
import { makeJobTool } from "@diy-agent/jobs/node";
import { localISOString } from "@diy-agent/time";

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

/**
 * thinking 回放的归一开关（##398）：本次请求要补 `reasoning_content` 吗？
 *
 * 判据（body 里钉死的三条，别凭感觉）：
 *   ① **本次是 thinking 模式**：档位非 `none`（`none` 是唯一显式关掉思考的语义）——
 *      与真发发推理参数的条件同源（本文件 streamText 之前那段）。
 *      **不按「模型是否支持该档」再收窄**：真发并不校验 supported（手写 personas 的档位不在
 *      词表里也照发，见 `reasoningEffort` 的解析），这里收窄会漏补（漏补 = 继续 400），
 *      而多补一个空串的成本为零（上游接受空串，实测见 scripts/probe-reasoning-400.mts 的 E 组）。
 *      `default`（平台默认）也算 thinking：那只是"我们不发档位参数"，不是"关掉思考"。
 *   ② **是不是 deepseek 系**：见 `reasoning-replay.ts::isDeepSeekWire`（收窄，别放宽）。
 *   ③ **只对 chat 面**：`@ai-sdk/openai-compatible` 才把消息级 `providerOptions.openaiCompatible`
 *      透传到 wire。responses 面（`@ai-sdk/openai`）命名空间是 `openai`、也没有 `reasoning_content`
 *      这个字段 —— 在那里补既到不了 wire，还会塞进一个包里不认的键。
 */
export function reasoningReplayOptsOf(rm: ResolvedModel, reasoningEffort: ReasoningEffort): ReasoningReplayOpts {
    const thinking = reasoningEffort !== "none";
    const deepseek =
        rm.api !== "responses" && isDeepSeekWire({ provider: rm.provider, model: rm.id, baseUrl: resolveBaseUrl(rm) });
    return { thinking, deepseek };
}

// 解析「人物/覆盖里写的模型引用」→ 运行时模型 + 密钥：见 LocalAgentManager.resolveModel。

/**
 * 输出预算（##429）：**软硬分离**。
 *
 * 曾经的病（实测）：这里直接返回 models.dev 的 `limit.output`，于是「模型的物理上限」
 * 就是「我们愿意付的上限」（生产最贵一条：output=131072=2^17，正好撞死）。
 * 现在真发值 = `min(软上限, 模型硬上限)`，判据全在 `shared/output-budget.ts`。
 *
 * 这个函数只管「模型能给多少」；「我们愿意给多少」由 `outputBudgetOf` 叠三层后合并。
 */
function modelHardLimit(modelId: string): number | null {
    // ⚠️ 未知模型返回 null = 「模型硬上限未知」，**不是 0**：0 会让 `streamText` 直接拒
    // （"maxOutputTokens must be >= 1"，##184 实测），而 null 的语义是「只有软上限可用」。
    return maxOutputTokensOf(modelId) ?? null;
}

// ─── 运行限制配置（默认值 < $DIY_HOME/local/limits.json < 环境变量 DIY_LOCAL_*）──
export interface LocalAgentLimits {
    /** 单轮最大模型步数（含工具步）；耗尽仍想调工具 → 强制收尾并 notice 提示 */
    maxSteps: number;
    /**
     * 单次模型请求的**全局**输出软上限（推理模型 reasoning 先吃预算）。
     *
     * ##429 起它只是覆盖链上的一层（任务 > 人物 > 本字段/env > 场景缺省），
     * 并且**还是天花板**：任何更具体的配置都不得超过它（「我这台机器最多付这么多」）。
     * 缺省值 16384 = 对话场景缺省（对齐 pi 的模型配置默认值）；`maxOutputTokensSource`
     * 说清这个数是「用户配的」还是「没人配、只是缺省」—— 两者语义不同（见下）。
     */
    maxOutputTokens: number;
    /**
     * `maxOutputTokens` 的来源：`env` / `file` = 用户显式配置（当作全局软上限参与覆盖链）；
     * `default` = 没人配（此时不压制场景缺省 —— 否则摘要 2000 / 小任务 200 会被它顶掉）。
     *
     * 这个字段是**派生值**，不是配置项：`setLimits` 只接受数字，不为它开写口。
     */
    maxOutputTokensSource: "env" | "file" | "default";
    /** 单步成本告警阈值（USD）；`0` = 关闭该类告警（##429 要求 ⑤） */
    costWarnStepUsd: number;
    /** 单轮累计成本告警阈值（USD）；`0` = 关闭该类告警 */
    costWarnTurnUsd: number;
    /**
     * `runBash` 在**没收到显式 `timeoutMs`** 时的兜底（缺省 300s）。
     *
     * ⚠️ **工具路径不再用它**（##454 用户裁决 2026-10-29：「默认不超时，有人设置 tool 超时
     * 就要尊重」）：`bash` 工具补的缺省值是 `0`（不设超时），见 `shared/tool-args.ts`。
     * 这个字段只剩直接调 `runBash(…, undefined)` 的内部代码与单测在用。
     *
     * 历史：曾经的 30s 是**反被利用**的 —— 全量单测 / 构建这类命令本来就跑不完，必然被杀 ⇒
     * agent 学会 `nohup … &` + `sleep N` 轮询，一次工作被切成十几步、每步还要重发整个上下文
     * （##402 实测：87 分钟里约 20 分钟是 sleep 空转、18 次被超时杀）。
     */
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
    maxOutputTokens: OUTPUT_SCENE_DEFAULTS.chat,
    maxOutputTokensSource: "default",
    costWarnStepUsd: DEFAULT_COST_ALARM.stepUsd ?? 0,
    costWarnTurnUsd: DEFAULT_COST_ALARM.turnUsd ?? 0,
    bashTimeoutMs: 300_000,
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

/** 非负数值（0 有意义：成本告警的「关闭」；非法值 → undefined） */
function envNonNegNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        console.warn(`[local-agent] 非法环境变量 ${key}=${raw}，忽略`);
        return undefined;
    }
    return n;
}

/**
 * 合并链：默认值 < 文件 < 环境变量；非法值逐级忽略。纯函数可单测。
 *
 * ##429 改了两处语义，都不是纯新增：
 *   ① `maxOutputTokens` 从「真发值」降级为「**全局软上限 + 天花板**」，并额外报 `maxOutputTokensSource`
 *      —— “没人配”与“配成了 16384”必须能分开，否则摘要（2000）/ 小任务（200）的场景缺省会被顶掉。
 *   ② 新增两个成本告警阈值（`0` = 关闭），同样默认值 < 文件 < env。
 */
export function resolveLimits(
    file: Partial<LocalAgentLimits> | null,
    env: NodeJS.ProcessEnv = process.env,
): LocalAgentLimits {
    const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
    /** 非负（0 有意义：告警阈值 = 关闭） */
    const nonNeg = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
    const base = { ...DEFAULT_LIMITS, ...(file ?? {}) };
    const fileOut =
        typeof (file ?? {}).maxOutputTokens === "number" &&
        Number.isFinite((file ?? {}).maxOutputTokens) &&
        ((file ?? {}).maxOutputTokens as number) > 0
            ? ((file ?? {}).maxOutputTokens as number)
            : undefined;
    const envOut = envPosInt(env, "DIY_LOCAL_MAX_OUTPUT_TOKENS");
    return {
        maxSteps: envPosInt(env, "DIY_LOCAL_MAX_STEPS") ?? num(base.maxSteps, DEFAULT_LIMITS.maxSteps),
        maxOutputTokens: envOut ?? fileOut ?? DEFAULT_LIMITS.maxOutputTokens,
        // 来源比数值更重要：`default` = 没人配（不压制场景缺省）
        maxOutputTokensSource: envOut !== undefined ? "env" : fileOut !== undefined ? "file" : "default",
        // 阈值允许 0（= 关闭该类告警）：判据是**非负**，不是正数
        costWarnStepUsd:
            envNonNegNumber(env, "DIY_LOCAL_COST_WARN_STEP_USD") ??
            nonNeg((file ?? {}).costWarnStepUsd, DEFAULT_LIMITS.costWarnStepUsd),
        costWarnTurnUsd:
            envNonNegNumber(env, "DIY_LOCAL_COST_WARN_TURN_USD") ??
            nonNeg((file ?? {}).costWarnTurnUsd, DEFAULT_LIMITS.costWarnTurnUsd),
        bashTimeoutMs:
            envPosInt(env, "DIY_LOCAL_BASH_TIMEOUT_MS") ?? num(base.bashTimeoutMs, DEFAULT_LIMITS.bashTimeoutMs),
        outputClipChars:
            envPosInt(env, "DIY_LOCAL_OUTPUT_CLIP_CHARS") ?? num(base.outputClipChars, DEFAULT_LIMITS.outputClipChars),
        readMaxBytes: envPosInt(env, "DIY_LOCAL_READ_MAX_BYTES") ?? num(base.readMaxBytes, DEFAULT_LIMITS.readMaxBytes),
        maxSteerQueue:
            envPosInt(env, "DIY_LOCAL_MAX_STEER_QUEUE") ?? num(base.maxSteerQueue, DEFAULT_LIMITS.maxSteerQueue),
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
    /**
     * **结构化机器事件**（可选）：job 结束等（##442 2026-10-27）。落点 = 该条 user 块的
     * `meta.notify`，投影时走 `notify:` 而不是 `chat:`。
     */
    notify?: NotifyItem;
}

interface LocalSession {
    /** 块树（Op 重放）：UI 与 fold 的唯一权威；llm.jsonl 只是观察 dump */
    store: BlockStore;
    /** llm 全量日志（append-only）已写出的消息条数 = 下次 append 的起点（真值在盘上，加载时对账得出） */
    logged: number;
    /**
     * `store` 的投影在 llm.jsonl 里的**行号偏移**（##420）= 被压缩跳过、本次没 replay 的消息条数。
     * 0 = 全量加载（原有语义）；> 0 时对账只比「偏移之后那一段」，且**绝不从前缀重建**（前缀已不在内存）。
     */
    llmBase: number;
    /** 本次加载的重放起点（断代标记回给 UI：不许静默空白） */
    replay: OpsReplay;
    /**
     * op 流的**写入器**（##432 刀 1）：行号 / 字节锚点由它产出，`turns` 的 ref 直接取它的返回值。
     * core 只说「追加一条 op」，不碰「这一行在文件的哪一字节」。
     */
    stream: OpsAppender;
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

/**
 * 手动压缩条的**一轮一行**（##519，用户 2026-11-05 定稿的形态：横向滑杆 + 轮次表）。
 *
 * 口径：每轮吃掉多少 token 用 `usage.jsonl` 的**实测总量差分**（相邻步相减），不估算 ——
 * 实测这个仓里每步增量 370~114k，估算只能对个位数。轮 = 一行；标题取 turns.jsonl 的 user 首行。
 *
 * 价格也在这里算（用户 2026-11-05：「把下一轮压缩后预计的价格也找个地方标清晰」）：
 * 用**上一步**的价目（`rates`）乘「压后的输入 token」+「上一步的输出 token」，
 * 明确标注**未计缓存折扣**（真发时缓存读占大头，实际会明显更低）。
 */
export interface KeptRoundRow {
    turnId: string;
    /** 轮次标签（轮1…轮N，按账本顺序） */
    label: string;
    /** 首句（turns.jsonl 的 user 取首行；没有则空） */
    title: string;
    /** 这一轮吃掉多少 token（实测增量之和） */
    tokens: number;
    /** 当前生效边界是否保留它（无边界 ⇒ 全保留） */
    kept: boolean;
}

export interface KeptRoundsView {
    /** 旧 → 新（最后一轮 = 最新） */
    rounds: KeptRoundRow[];
    /** 总轮数（尾部窗口里能看到的，含**已压掉**的） */
    total: number;
    /** 已经压掉、不可再选回来的轮数（边界之前的） */
    droppedCount: number;
    /** 当前边界保留几轮 */
    keptCount: number;
    /** 更早的轮未加载（尾部窗口外）—— 界面必须标出来 */
    truncated: boolean;
    windowTokens: number | null;
    /** 上一步实测总 token（窗口占用，与环同源） */
    usedTokens: number | null;
    /** 当前边界保留的历史 ≈ token（无边界 = null） */
    retainedTokens: number | null;
    /**
     * 下一轮的价格估算（USD）。`null` = 该会话还没有价目（新会话 / 无价模型）。
     * **不含缓存折扣**：真发时 cacheRead 通常占 95%+，所以这个数是上限，别当账单。
     */
    price: {
        /** 固定开支（system + tools）≈ token —— 压不掉的那部分 */
        fixedTokens: number;
        /** 上一步的输出 token（下一轮按同样输出估） */
        outTokens: number;
        /** 每百万 token 的美元价（上一步的价目） */
        perMInput: number;
        perMOutput: number;
        /** 价目依据（模型标识）—— 界面要显示，别让人以为是无源数字 */
        basis: string;
    } | null;
}

/** 首行摘要（标题用；过长截断，换行折成空格） */
function firstLineOf(text: string): string {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > 40 ? `${one.slice(0, 40)}…` : one;
}

/** 读「保留最近 N 轮」的轴（只读；不建目录、不写任何东西） */
export function keptRoundsView(taskUri: string): KeptRoundsView {
    const usages = readStepUsagesTail(taskUri, 800);
    // ① 逐步差分 → 按轮聚合（顺序 = 账本顺序，即旧 → 新）
    const order: string[] = [];
    const perTurn = new Map<string, number>();
    let prevTotal = 0;
    for (const u of usages) {
        const total = bucketsOf(u.usage as UsageLike).total;
        // **不 clamp 负增量**：压缩后总量会掉，clamp 会把"掉下去的那段"重复计入（实测会算出
        // 逐轮之和 > 历史消息本身，用户一眼看出来不对）。这里保留带符号增量，后面再对齐一次。
        const delta = total - prevTotal;
        prevTotal = total;
        if (!perTurn.has(u.turnId)) {
            perTurn.set(u.turnId, 0);
            order.push(u.turnId);
        }
        perTurn.set(u.turnId, (perTurn.get(u.turnId) ?? 0) + delta);
    }
    // ② 首句（turns.jsonl；读失败不影响压缩位置）
    const titles = new Map<string, string>();
    try {
        for (const rec of readTurnRecords(taskUri)) {
            if (rec.user !== "") titles.set(rec.turnId, firstLineOf(rec.user));
        }
    } catch {
        /* 轮记录缺失：标题留空，位置照常算 */
    }
    // ③ 当前生效边界（无边界 = 一轮都没压）
    const boundary = latestBoundary(taskUri);
    const boundaryTurnId = (boundary as unknown as { keptFromTurnId?: string | null } | null)?.keptFromTurnId ?? null;
    const cutIdx = boundaryTurnId === null ? 0 : order.indexOf(boundaryTurnId);
    const keptFrom = boundaryTurnId === null || cutIdx < 0 ? 0 : cutIdx;   // 边界不在窗口内 ⇒ 当作全保留
    // 对齐：逐轮之和应等于「实测占用 − 固定开支」（同一份账上的两个数必须自洽，
    // 否则界面会出现「留 36 轮 = 375k」而上面写「历史 278.8k」的矛盾）。
    const cfgLimit0 = normalizeHistoryLimit(loadAutoCompact(diyHome()).history?.limit);
    const winTokens0 = cfgLimit0.windowTokens ?? contextLimitOf(personaForTask(diyHome(), taskUri).model) ?? null;
    const fixed0 = getLocalAgent().fixedTokensOf(taskUri);
    const lastTotal = usages.length > 0 ? bucketsOf(usages[usages.length - 1]!.usage as UsageLike).total : 0;
    const rawSum = order.reduce((n, id) => n + Math.max(0, perTurn.get(id) ?? 0), 0);
    const targetHist = Math.max(0, lastTotal - fixed0);
    const scale = rawSum > 0 && targetHist > 0 && rawSum > targetHist ? targetHist / rawSum : 1;
    // **只列还能保留的轮**（边界之后）。边界之前的已经压掉，选不回来 ——
    // 列出来还让滑块拖回去，就是「压完还能恢复」的假象（用户实测问过这一点）。
    const rounds: KeptRoundRow[] = order.slice(keptFrom).map((turnId, j) => ({
        turnId,
        label: `轮${keptFrom + j + 1}`,
        title: titles.get(turnId) ?? "",
        tokens: Math.round(Math.max(0, perTurn.get(turnId) ?? 0) * scale),
        kept: true,
    }));
    const keptCount = rounds.length;
    // ④ 窗口与价格（价目取上一步；`rates` 是每百万 token 的美元价）
    const cfgLimit = cfgLimit0;
    const windowTokens = winTokens0;
    const last = usages[usages.length - 1];
    const usedTokens = last ? bucketsOf(last.usage as UsageLike).total : null;
    const rates = (last?.rates ?? null) as { input?: number; output?: number } | null;
    const lastBuckets = last ? bucketsOf(last.usage as UsageLike) : null;
    const outTokens = lastBuckets ? lastBuckets.text + lastBuckets.reasoning : 0;
    // 只给**原料**：压后价必须随滑杆变，所以乘哪份 token 由界面按当前选择算（上一版在这里
    // 直接算出 afterUsd，于是拖动滑杆价格纹丝不动 —— 用户实测发现的那个 bug）。
    const price =
        rates && typeof rates.input === "number" && typeof rates.output === "number"
            ? {
                  fixedTokens: fixed0,
                  outTokens,
                  perMInput: rates.input,
                  perMOutput: rates.output,
                  basis: last?.priceRef ?? last?.responseModel ?? last?.model ?? "上一步价目",
              }
            : null;
    return {
        rounds,
        total: rounds.length,
        droppedCount: keptFrom,
        keptCount,
        truncated: usages.length >= 800,
        windowTokens,
        usedTokens,
        retainedTokens: boundary ? (boundary as unknown as { retainTokens?: number }).retainTokens ?? null : null,
        price,
    };
}

/** 尾部用量（面板成本表用；不整读 4.6 MB） */
function readStepUsagesTail(taskUri: string, maxLines = 500): StepUsageRecord[] {
    const tail = readJsonlTail(usageFile(taskUri), { maxBytes: 512 * 1024, maxLines });
    const out: StepUsageRecord[] = [];
    for (const line of tail.lines) {
        try {
            out.push(JSON.parse(line) as StepUsageRecord);
        } catch {
            /* 坏行跳过 */
        }
    }
    return out;
}

/** 只读最后一条用量（尾部限读；autoCompactStatus 每轮都要，不能整读 4.6 MB） */
function readLastStepUsage(taskUri: string): StepUsageRecord | null {
    const tail = readJsonlTail(usageFile(taskUri), { maxBytes: 64 * 1024, maxLines: 1 });
    const line = tail.lines.at(-1);
    if (!line) return null;
    try {
        return JSON.parse(line) as StepUsageRecord;
    } catch {
        return null;
    }
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
 * 合并**相邻的 user 消息**为一条。
 *
 * ⚠️ 依据已实测订正（2026-10-16，##310）：**本仓在用的两家 provider 都不拒连续同角色**
 * —— `goat`（`api.commandcode.ai`）与 `opencode-go`（`opencode.ai/inference/go`）对
 * `[{user: A},{user: B}]` 以及 content 数组形式的连续 user 均返回 200。所以这条合并
 * **不是**"provider 要求"，而是**收敛语义**：投递**天然会造出连续 user**
 * （变量增量 / summary 作为尾部 user 插在本轮输入之前），合并成一条能让"给模型的这份信封"
 * 只有一处 user，减少歧义、少一条消息。**若将来遇到真拒连续同角色的 provider，这里就是唯一改动点。**
 *
 * 合并只动相邻 user、位置与总文本不变（前缀缓存不受影响：摘要/增量本就在变化段），
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
        // 【##421】**信封形态的消息不参与合并**：自动生成的段（`history:` 注记）自占一条消息，
        // 它放在历史第一条之前 —— 若被并进相邻 user，就又是一坨「元数据伪装成用户原话」（##310 八轮坑）。
        if (m.role === "user" && last?.role === "user" && !isEnvelope(m) && !isEnvelope(last)) {
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

/** 信封消息（自占顶层键的自动生成段）—— 不参与 user 合并，见 `normalizeUserRuns` 与 `isEnvelopeText` */
function isEnvelope(m: ModelMessage): boolean {
    return m.role === "user" && typeof m.content === "string" && isEnvelopeText(m.content);
}

/**
 * **段首 system 快照**（##442 用户 2026-10-27；铁律见 2026-10-31 口径）。
 *
 * 读**上一次真发**那一步的 `systemText`（`steps.jsonl` 末条）作为本条会话的基线：
 *   · 没有历史 / 老格式（信封里没有顶格 `vars:`）⇒ 用本轮现算的（重建一次）；
 *   · 否则逐字复用 —— 这是前缀缓存能命中的前提。
 *
 * ⚠️ **不按 places 相等判**：可选单元（如 `self`）第一次出现时，live 的单元会比快照多一个
 * —— 那是「新变量」，应该走 user 增量，不该把整条 system 重建（否则每出现一个新单元
 * 就砸一次前缀缓存，正是这条要防的）。
 *
 * 判据本体在 `shared/context/segment-snapshot.ts`（纯函数、可单测）：`vars: {}` 也算新格式，
 * 逐行相等判据会把它误判成老格式 ⇒ 每轮砸缓存。
 */
function frozenSystemSnapshotOf(
    live: Delivery,
    lastStep: DeliveryStepRecord | null,
    boundaryAt: string | null,
): { text: string; reason: SnapshotReason } {
    return segmentSystemSnapshotOf({
        liveText: live.text.text,
        lastText: lastStep?.systemText ?? null,
        lastCompactAt: lastStep?.compactAt ?? null,
        boundaryAt,
    });
}

/** 只要文本（预览路径用；真发要顺带留痕，用 `frozenSystemSnapshotOf`） */
function frozenSystemTextOf(live: Delivery, lastStep: DeliveryStepRecord | null, boundaryAt: string | null): string {
    return segmentSystemTextOf({
        liveText: live.text.text,
        lastText: lastStep?.systemText ?? null,
        lastCompactAt: lastStep?.compactAt ?? null,
        boundaryAt,
    });
}

/**
 * **压缩通知**（##442 最大精简）：有边界时，在 system 之后放一条 user 消息。
 *
 * 只有两个字段：`source`（llm.jsonl 绝对路径）+ `summary`（model 摘要 / self 的固定提示 / 空）。
 * 不再带 at / 行号 / 条数 / task —— 那些都是派生值或每轮会变的量。
 * 两次压缩之间逐字节不变（source 固定；summary 只在压缩时写）。
 */
const COMPACT_SELF_HINT = "前文已压缩，未生成摘要。需要时按行查 source（每行一条消息）。";
const COMPACT_MODEL_MISSING_HINT = "前文已压缩；model 模式摘要未生成。需要时按行查 source（每行一条消息）。";

/** 有边界时产出一条压缩通知；没有边界 ⇒ null（调用方逐字不变） */
function compactNoticeItem(
    taskUri: string,
    mode: "model" | "self",
    summary: string,
    boundary?: CompactionEntry | null,
): NotifyItem | null {
    let b: CompactionEntry | null;
    try {
        b = boundary === undefined ? readBoundary(taskUri) : boundary;
    } catch {
        return null;
    }
    if (!b) return null;
    // ##442 step 5：只留 source/summary，但 self / 空摘要必须给一个起点，否则 12MB 文件无从查起。
    const locator = `原文从第 ${b.cut.llmLine} 行开始（source 每行一条消息）。`;
    const hint = mode === "self" ? COMPACT_SELF_HINT : COMPACT_MODEL_MISSING_HINT;
    const text = !summary || mode === "self" ? `${hint}\n${locator}` : `${summary}\n\n${locator}`;
    return { kind: "compact", source: llmFile(taskUri), summary: text };
}

/**
 * 把头部 notify 并进 system 之后**第一条 user**，避免 `notify` 单发造成连续两条 user。
 * 历史 user 一律是信封（chat:），所以键序仍是 notify → chat。
 */
function withHeadNotice(messages: ModelMessage[], item: NotifyItem | null): ModelMessage[] {
    if (!item) return messages;
    const out = [...messages];
    const idx = out.findIndex((m) => m.role === "user" && typeof m.content === "string");
    if (idx < 0) return [{ role: "user", content: userEnvelope({ notify: [item] }) }, ...out];
    const content = out[idx]!.content as string;
    if (!isEnvelopeText(content)) return [{ role: "user", content: userEnvelope({ notify: [item] }) }, ...out];
    out[idx] = { ...out[idx]!, role: "user", content: withNotify(content, item) } as ModelMessage;
    return out;
}

/** 预检 tightCap 额外丢历史时，把 cap 事件并进末条 user 的 notify（不新增消息） */
function addCapNotify(messages: ModelMessage[], taskUri: string, dropped: number): ModelMessage[] {
    if (dropped <= 0) return messages;
    const item: NotifyItem = {
        kind: "compact",
        source: llmFile(taskUri),
        summary: `预检超限：已额外丢弃 ${dropped} 条历史（原文见 source）`,
    };
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role !== "user" || typeof m.content !== "string") continue;
        const out = [...messages];
        out[i] = { ...m, content: withNotify(m.content, item) };
        return out;
    }
    return messages;
}

/**
 * 投递口径的历史 = **消息**（无可选片段）。
 */
export interface HistoryDelivery {
    messages: ModelMessage[];
    /**
     * ##420：本次读的**重放起点**（`deliveryMessages` 预览路径才带）。
     * 里面的 `kind` / `note` 就是断代的**可见标记**（用户 2026-10-23：不许静默空白）——
     * UI 看到空会话时必须能说出“为什么空”。
     */
    replay?: OpsReplay;
}

/** 读某任务的投递快照（时间正序；文件不存在 = 还没真发过） */
export function readDeliverySteps(taskUri: string): DeliveryStepRecord[] {
    // 读侧兜底：`places` 新记录必写，但老快照/手写行可能缺 → 给个 [] 更稳（renderer 按它算归属）。
    return readJsonl<DeliveryStepRecord>(stepsFile(taskUri)).map((r) => ({
        ...r,
        places: r.places ?? [],
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
 * 轮末状态三档（`turns.jsonl` 的 `state`，##424）。
 *
 * 值域只有三个（body 定死）：`error` = 本轮到错误收口；`aborted` / `interrupted` = 被中断；
 * 其余（自然说完 / 打满步数 / 输出截断）都是 **ok** —— 它们是「这一轮跑完了」的不同形态，
 * 不是失败。不该在这里造第四档（消费侧只认三个值）。
 */
function turnStateOf(reason: TurnEndReason): TurnRecordState {
    switch (reason.type) {
        case "error":
            return "error";
        case "aborted":
        case "interrupted":
            return "interrupted";
        default:
            return "ok";
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
    /**
     * 降级重建的可见标记（##424 刀 2）：**有它就意味着「这份历史不是 ops 原文」**。
     * `ops` 此时是 `turns.jsonl` 折成的只读文本历史（user + assistant 正文），
     * UI 顶部挂横幅、行内标「原始记录已清理」——**不许静默空白**。正常路径恒 undefined。
     */
    degraded?: DegradedHistory;
}

/**
 * 折叠缓存的一条（per task **+ 窗口起点**）。
 *
 * `compact` / `loggedIssues` 是 ##92 加的：
 *   · `compact` —— `compactOps(store)` 的产物（块树没变就复用；142 MB 会话一次 ~80ms / 数十 MB 对象）
 *   · `loggedIssues` —— 已出过声的 issue 条数（只在新 issue 出现时打日志，别每次取历史重打一遍）
 */
interface FoldCacheEntry {
    start: number;
    consumed: number;
    prefix: string;
    store: BlockStore;
    /** 折叠流缓存；`compactConsumed === consumed` 时有效（null = 还没算） */
    compact: Op[] | null;
    compactConsumed: number;
    loggedIssues: number;
}

// 降级标记的类型/文案在 shared（跨层契约：main 产出、renderer 消费，见 shared/degraded-history）
export type { DegradedCause, DegradedHistory };

/** 折叠缓存的上限（LRU）：块树常驻内存，多开几个大会话也不至于无界堆积。 */
const HISTORY_CACHE_MAX = 8;

/** 渲染端首载 / 轮末重取的默认段预算（与渲染端 `HISTORY_WINDOW_BYTES` 同值；渲染端刷新时不传预算）。 */
const WINDOW_SEEK_DEFAULT_BYTES = 4 * 1024 * 1024;

/**
 * 带游标的段**长度上限**（##92 第 4 条）：游标起点固定、文件只增不减 ⇒ 不封顶的段会随会话长开
 * 无限膨胀（首载 4 MB，长开能涨到几十 MB，每次都整段重 fold）。超了就从**尾部重新 seek** 一个段：
 * 段起点变了，渲染端的前缀守卫自会把它整体重置成这一段（比继续拿几十 MB 更诚实）。
 */
const WINDOW_CAP_BYTES = 16 * 1024 * 1024;

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

/**
 * 从 `from` 字节读到文件尾 → op 列表（##420：会话加载的**唯一跳前缀入口**）。
 *
 * 就是 `readOpsRange(fp, from, size)`，但多一道**行首校验**：
 * `from` 来自账本的 `keptFromOpsOffset`（理论上必是轮首行的行首），但账本可能被手改 / 来自旧版本，
 * 一旦指到行中（更糟：指向一个多字节 UTF-8 字符的中间），从那儿解出的第一条就是半行脏 JSON
 * —— 而它的前缀字节会被当成一条独立 op 解出来，静默换掉一段历史。
 * 故：只有当 `from-1` 处的字节是 `\n` 才认它是行首，否则向后跳到下一个行首再开始
 * （0x0a 不可能是 UTF-8 的续字节，故这个判据对多字节字符也成立）。
 */
export function readOpsFrom(fp: string, from: number): Op[] {
    const size = fileSize(fp);
    if (size <= 0) return [];
    let start = Math.max(0, Math.min(from, size));
    if (start > 0 && start < size) {
        const atLineStart = prevByteIsNewline(fp, start);
        if (!atLineStart) start = skipToNextLineStart(fp, start, size);
    }
    if (start >= size) return [];
    return readOpsRange(fp, start, size).ops;
}

/** `readOpsFrom` 的 fold 版：同一跳前缀语义，直接把 op 喂进给定块树（投递预览复用 UI 缓存时的常见展开）。 */
function replayOpsInto(store: BlockStore, fp: string, from: number): BlockStore {
    for (const op of readOpsFrom(fp, from)) store.apply(op);
    return store;
}

/** `at-1` 处的字节是不是换行（读不到就当是 —— 宁可按行首处理，不无端跳行） */
function prevByteIsNewline(fp: string, at: number): boolean {
    try {
        const fd = openSync(fp, "r");
        try {
            const b = Buffer.allocUnsafe(1);
            if (readSync(fd, b, 0, 1, at - 1) !== 1) return true;
            return b[0] === 0x0a;
        } finally {
            closeSync(fd);
        }
    } catch {
        return true;
    }
}

/** 从 `at` 向后找下一个行首（= 第一个 `\n` 之后）；找不到（尾部半行）= 文件尾 */
function skipToNextLineStart(fp: string, at: number, size: number): number {
    const CHUNK = 64 * 1024;
    try {
        const fd = openSync(fp, "r");
        try {
            const buf = Buffer.allocUnsafe(CHUNK);
            let pos = at;
            while (pos < size) {
                const want = Math.min(CHUNK, size - pos);
                const got = readSync(fd, buf, 0, want, pos);
                if (got <= 0) break;
                const nl = buf.subarray(0, got).indexOf(0x0a);
                if (nl >= 0) return pos + nl + 1;
                pos += got;
            }
        } finally {
            closeSync(fd);
        }
    } catch {
        /* 读不到就当文件尾 */
    }
    return size;
}

/** 文件的完整行数（分块数换行，不整份读进内存；断代路径专用，量级 = 一次冷加载） */
function countFileLines(fp: string): number {
    if (!existsSync(fp)) return 0;
    const CHUNK = 256 * 1024;
    let n = 0;
    try {
        const fd = openSync(fp, "r");
        try {
            const buf = Buffer.allocUnsafe(CHUNK);
            let got: number;
            while ((got = readSync(fd, buf, 0, CHUNK, null)) > 0) {
                for (let i = 0; i < got; i++) if (buf[i] === 0x0a) n++;
            }
        } finally {
            closeSync(fd);
        }
    } catch {
        return n;
    }
    return n;
}

/**
 * 会话重放的**起点**（##420）：压缩账本记的 ops 字节偏移 —— 只读起点之后的段。
 *
 * 病根：`getSession` / `deliveryMessages` / `buildRequestView` / `measureMustStages` 都是
 * 「整份 replay ops.jsonl」，141 MB / 114 万行的会话每次开工都要走一遍全文件，而其中绝大多数
 * 轮次早被压缩掉了（投递侧根本不看它们）。
 *
 * 口径（用户 2026-10-23）：**不引入 L2 层、不引入 commit op、不双投影** —— L2 就是「ops 的一个
 * 读窗口」，它的载体就是账本里的一个字节偏移。故这里只做两件事：取偏移、配两个自证。
 */
export interface OpsReplay {
    /** 从哪个字节开始 replay（0 = 全量） */
    from: number;
    /**
     * `store` 的投影在 **llm.jsonl 里的行号偏移**（= 被跳过的消息条数；0 = 无偏移）。
     * 投递注记（`history.kept`）与 llm 日志对账都按行号对齐，跳了段就必须把这段加上。
     */
    lineBase: number;
    /**
     * full          从未压缩 / 旧账缺偏移 ⇒ 全量（行为与今天逐字一致）
     * offset        按账本偏移跳前缀（快路径）
     * schema-break  账本格式断代 ⇒ 起点 EOF（旧段退化为纯审计日志，永不再 replay）
     * truncated     文件比压缩时还短（被截断 / 换了一份）⇒ 起点作废，同样走断代
     */
    kind: "full" | "offset" | "schema-break" | "truncated";
    /** 断代的**可见标记**（日志 + 回给 UI）：不许静默空白 */
    note?: string;
    /** 生效锚点（full 时为 null；UI/排查用） */
    anchor: {
        compactId: string;
        schema: number;
        keptFromTurnId: string | null;
        keptFromOpsOffset?: number;
        keptFromLlmLine?: number;
        opsBytes?: number;
    } | null;
}

/**
 * 账本里**最近一条生效 compact**（倒扫尾部，不整份 parse）—— **懒迁移 / 回退路径**。
 *
 * ##431 起它的主调用已不是每步投递，而是「快照缺失或损坏」时的**一次性重建**：
 * 当前生效边界存在 `compact-state.json` 里（见 `ensureCompactState`），读它 O(1)。
 *
 * 为什么不能 `resolveBoundary(readCompactLog(...))`：compact.jsonl 是 append-only 且每条事件
 * 内嵌「被裁原文清单 / 摘要 / 过滤表达」，实测一个大会话长到 **274 MB / 458 行**（266 会话）。
 * `readFileSync` + `JSON.parse` 整套是**秒级同步阻塞**。
 *
 * 判据（append-only 单调）：**倒着扫**，见到的最新一条 compact 只要它之后没有 undo(ref) 就是生效边界
 * （undo 只能撤销已存在的 compact ⇒ 指向它的 undo 必在其后）。尾部窗口不够（行很长）就翻倍再扫，
 * 最坏退化成整份读 —— 与旧行为等价，只是不再无条件付这个代价。
 */
function scanLatestCompact(taskUri: string): { rec: CompactEventRecord; at: number } | null {
    const fp = compactFile(taskUri);
    let size = 0;
    try {
        size = statSync(fp).size; // sync-io-ok: 压缩账本尾部定位/读取（O(1)~几 MB），与 readOpsRange 同一同步 fold 窗口；改异步会把整条 replay 链染成 async
    } catch {
        return null; // 从未压缩过
    }
    if (size <= 0) return null;
    // 初窗 64 KB（够装 2~3 条 25 KB 的 compact 行）—— ##431 起这是**懒迁移/回退路径**，
    // 只在快照缺失时走一次；不必一上来就啃 4 MB（37 MB 账本实测 4 MB 起扫要 200 ms）。
    let window = 64 * 1024;
    for (;;) {
        const from = Math.max(0, size - window);
        let text: string;
        try {
            const fd = openSync(fp, "r"); // sync-io-ok: 压缩账本尾部定位/读取（O(1)~几 MB），与 readOpsRange 同一同步 fold 窗口；改异步会把整条 replay 链染成 async
            try {
                const buf = Buffer.allocUnsafe(size - from);
                let got = 0;
                while (got < buf.length) {
                    const n = readSync(fd, buf, got, buf.length - got, from + got); // sync-io-ok: 压缩账本尾部定位/读取（O(1)~几 MB），与 readOpsRange 同一同步 fold 窗口；改异步会把整条 replay 链染成 async
                    if (n <= 0) break;
                    got += n;
                }
                text = buf.subarray(0, got).toString("utf-8");
            } finally {
                closeSync(fd); // sync-io-ok: 压缩账本尾部定位/读取（O(1)~几 MB），与 readOpsRange 同一同步 fold 窗口；改异步会把整条 replay 链染成 async
            }
        } catch {
            return null;
        }
        // 非文件头 ⇒ 首行可能是半行（切在多字节字符中间也不怕：JSON.parse 失败即跳过）
        const lines = text.split("\n");
        // 每行在文件里的字节偏移（末尾 +1 是换行；字节数 ≠ 字符数，故用 Buffer 逐段量）
        const lineStarts: number[] = [];
        {
            let off = from;
            for (const l of lines) {
                lineStarts.push(off);
                off += Buffer.byteLength(l, "utf-8") + 1;
            }
        }
        if (from > 0) {
            lines.shift();
            lineStarts.shift();
        }
        const undone = new Set<string>();
        for (let i = lines.length - 1; i >= 0; i--) {
            const t = lines[i]!.trim();
            if (!t) continue;
            let ev: CompactLogEvent;
            try {
                ev = JSON.parse(t) as CompactLogEvent;
            } catch {
                continue; // 半行 / 坏行：跳过不影响判据（compact 也在同一窗口里）
            }
            if (ev.kind === "undo") {
                undone.add(ev.ref);
            } else if (ev.kind === "compact") {
                if (undone.has(ev.id)) continue;
                // `at` = 这条 compact 行的字节偏移（落进快照，供回查 / measure 记账）
                return { rec: ev, at: from + lineStarts[i]! };
            }
        }
        if (from === 0) return null; // 整份都扫完仍没有生效 compact
        window *= 4;
    }
}

// ─── 压缩状态快照（`compact-state.json`，##431）────────────────────────
//
// 口径（用户 2026-10-25）：「把 compact.jsonl 变为和 ops 一样的非核心依赖，就是日志」。
// 于是「当前生效边界是什么」这个**每步投递都要问**的问题，不再靠扫账本流水回答 ——
// 账本降级为纯审计日志（删了/坏了只丢历史，agent 照常跑），当前值落在这一个快照文件里。
//
// 三条硬约束：
//   · **原子覆盖**：tmp + rename（`writeFileAtomic`）—— 读者要么看到旧内容、要么看到新内容；
//   · **懒迁移**：快照缺失/损坏 ⇒ 扫一次账本尾部重建，**并出声**（warn），绝不静默当全量；
//   · **写失败不阻断**：它只是投影，写不进去顶多下次再重建（`appendCompactEvent` 同一口径）。

/** 账本尾部限读缺省（单次 < 10 ms；最近几十次压缩足够） */
const COMPACT_TAIL_BYTES = 256 * 1024;
const COMPACT_TAIL_LINES = 200;

/** 压缩状态快照的绝对路径（会话目录下的旁路 JSON） */
export function compactStateFile(taskUri: string): string {
    return sessionStateFile(taskUri, COMPACT_STATE_FILENAME.replace(/\.json$/, ""));
}

type CompactStateRead = { kind: "ok"; state: CompactState } | { kind: "missing" } | { kind: "broken"; error: string };

/** 读当前值快照（只读文件；坏形状 = `broken`，**不在这里**退化成全量判断）。 */
function readCompactState(taskUri: string): CompactStateRead {
    const fp = compactStateFile(taskUri);
    // sync-io-ok: 存在性判定（几百 B 的旁路快照，与 readOpsRange 同一同步 fold 窗口）
    if (!existsSync(fp)) return { kind: "missing" };
    try {
        // sync-io-ok: 当前值快照只有几百 B，读它替代「扫 274 MB 账本」，且与 readOpsRange 同一同步 fold 窗口
        const raw = JSON.parse(readFileSync(fp, "utf-8")) as unknown;
        const state = normalizeCompactState(raw);
        if (!state) return { kind: "broken", error: "形状不符（v / boundary 缺失或类型不对）" };
        return { kind: "ok", state };
    } catch (e) {
        return { kind: "broken", error: e instanceof Error ? e.message : String(e) };
    }
}

/** 原子覆盖写快照（`fs` 注入仅供单测做确定性故障注入：验证「写一半不毁旧文件」）。 */
export function writeCompactState(taskUri: string, state: CompactState, opts: { fs?: FsLike } = {}): void {
    const fp = compactStateFile(taskUri);
    const next: CompactState = { ...state, savedAt: localISOString() };
    try {
        writeFileAtomic(fp, `${JSON.stringify(next)}\n`, opts.fs ? { fs: opts.fs } : {});
    } catch (e) {
        // 只是投影：写不进去就下次再重建，绝不阻断会话
        console.error(`[local-agent] 压缩状态快照写入失败 ${fp}:`, e);
    }
}

/**
 * 确保快照存在（**懒迁移入口**）：
 *   · 快照可读 → 直接用（O(1)）；
 *   · 缺失 / 损坏 → 扫一次账本重建并写回（损坏必须 warn：它与「从未压缩」是两种事实）。
 *
 * 返回 `null` = 账本不存在（从未压缩过）—— 此时**不写**快照（没内容可写）。
 */
function ensureCompactState(taskUri: string): CompactState | null {
    const read = readCompactState(taskUri);
    if (read.kind === "ok") return read.state;
    if (read.kind === "broken") {
        console.warn(
            `[local-agent] 压缩状态快照不可用（${compactStateFile(taskUri)}）：${read.error} —— 回落扫一次账本重建（本步仍可继续）`,
        );
    }
    const ledger = resolveSessionFile(taskUri, "compact");
    if (!existsSync(ledger)) return null;
    const sc = scanLatestCompact(taskUri);
    // 命中 / 未命中都要写：`boundary: null` = 账本在但没有生效压缩（全被 undo），这份事实同样要缓存。
    // `opIds` / `measure` 从**限读尾部**汇总 —— 懒迁移允许不精确（只影响迁移归属与一条统计），
    // 但**不许整份读**（那正是本刀要消掉的病根）。
    const tail = readCompactLogTail(taskUri, { maxBytes: COMPACT_TAIL_BYTES, maxLines: COMPACT_TAIL_LINES });
    const opIdSet = new Set<string>();
    for (const e of tail.events) {
        if (e.kind !== "compact") continue;
        for (const id of clippedIdsOfEvent(e)) opIdSet.add(id);
    }
    const point = sc ? compactPointOf(sc.rec, sc.at) : null;
    const measure = point
        ? ([...tail.events].reverse().find((e) => e.kind === "measure" && e.ref === point.compactId) as
              | MeasureEventRecord
              | undefined)
        : undefined;
    const state: CompactState = {
        v: 1,
        boundary: point,
        opIds: [...opIdSet],
        ...(measure ? { measure } : {}),
    };
    writeCompactState(taskUri, state);
    return state;
}

/**
 * **当前生效边界**（投递 / UI 重放共用的唯一入口）。
 * 只读快照；缺失/损坏时懒迁移重建一次（warn）。返回 `null` = 从未压缩过（或归档账本已不存在）。
 */
function latestBoundary(taskUri: string): EffectiveBoundary | null {
    const state = ensureCompactState(taskUri);
    const fromState = state?.boundary ? boundaryOfPoint(state.boundary) : null;
    if (fromState) return fromState;
    // 回落 turns.jsonl：`appliedHistoryRange` 写边界时只落 turns 账 + 内存态，
    // **没有**写压缩账本 / compact-state.json —— 于是 `ensureCompactState` 扫不到、读回 null，
    // 界面就说「压完还是 N 轮」（用户实测的那个 bug）。这里补一条只读回落，
    // 让「手压边界」在任何进程里都看得见（写侧不动，避免双写两份真源）。
    try {
        const b = readBoundary(taskUri);
        if (!b) return null;
        return {
            compactId: b.at,
            keptFromTurnId: b.cut.turnId,
            keepFromOpIndex: 0,
            ...(b.ref ? { keptFromOpsOffset: b.ref.ops.offset } : {}),
            keptFromLlmLine: b.cut.llmLine,
            schema: OPS_SCHEMA_CURRENT,
            policy: { mode: "budget", modeData: { budgetBytes: b.retainTokens ?? 0, toolResult: { render: "asis" } }, summary: false } as never,
            ts: b.at,
        };
    } catch {
        return null;
    }
}

/** `resolveOpsReplay` 的缓存（键 = ops 大小 + 账本大小/mtime；三者任一变了才重算）。 */
const replayCache = new Map<string, { streamSize: number; cSize: number; cMtime: number; replay: OpsReplay }>();

/** 缓存上限：只服务「当前打开的几个会话」，别把 N 个任务的判定常驻内存。 */
const REPLAY_CACHE_MAX = 16;

/** 仅测试：清掉重放判定缓存（键含 ops/账本 size+mtime，正常由它们自发失效）。 */
export function resetOpsReplayCache(): void {
    replayCache.clear();
}

/**
 * 解析某任务的 ops 重放起点（纯读：账本 + 文件大小，不碰 ops 内容）。
 *
 * 判定顺序（任一破了就退到更保守的一档）：
 *   ① 没有生效压缩（从未压过 / 全被 undo）→ 全量；
 *   ② 账本 `schema` 与当前不符 → **断代**（EOF + 可见标记）；
 *   ③ `size < 账本.opsBytes` → 文件被截断/替换 → **断代**（**绝不回退 0**：0 可能读到旧格式的别的会话）；
 *   ④ 账本没记 `keptFromOpsOffset` / `keptFromLlmLine`（v1 旧账、全清压缩）→ 全量。
 *
 * 为什么 `keptFromLlmLine` 是**必需**的（而不是可选优化）：跳了前缀之后块树只含保留段，
 * 投递注记的行号与 llm.jsonl 的 append 对账都会**整体错位**被跳过的条数；不知道错多少就只能全量重放。
 *
 * 热路径口径（##92 / ##431）：这是**判定 + 缓存**的外壳 —— 当前生效边界读 `compact-state.json`
 * （几百 B；缺失才扫一次账本尾部并懒迁移），结果按 (ops 大小, 账本 size/mtime) 缓存。
 * 账本本身已降为**纯审计日志**：删了 / 坏了只丢历史页，不阻碍本轮。
 */
export function resolveOpsReplay(taskUri: string): OpsReplay {
    // ⚠️ **只读解析**（`streamPath`，不建目录）：这是纯读口（大小 / 账本 mtime），
    // 却每轮真发、每次开会话页都被调 —— 用写侧 `opsFile` 会顺手把空会话目录建出来（##444 P2）。
    const fp = streamPath(taskUri);
    const streamSize = fileSize(fp);
    let cSize = -1;
    let cMtime = -1;
    try {
        // 账本也是**读**口（只探 mtime）：用写侧 `compactFile` 会把空会话目录建出来（##444 P2）。
        const st = statSync(resolveSessionFile(taskUri, "compact")); // sync-io-ok: 压缩账本尾部定位/读取（O(1)~几 MB），与 readOpsRange 同一同步 fold 窗口；改异步会把整条 replay 链染成 async
        cSize = st.size;
        cMtime = st.mtimeMs;
    } catch {
        /* 没账本 = 从未压缩 */
    }
    const hit = replayCache.get(taskUri);
    if (hit && hit.streamSize === streamSize && hit.cSize === cSize && hit.cMtime === cMtime) return hit.replay;
    const replay = computeOpsReplay(taskUri, fp, streamSize);
    replayCache.delete(taskUri);
    replayCache.set(taskUri, { streamSize, cSize, cMtime, replay });
    if (replayCache.size > REPLAY_CACHE_MAX) {
        const oldest = replayCache.keys().next().value;
        if (oldest !== undefined) replayCache.delete(oldest);
    }
    return replay;
}

function computeOpsReplay(taskUri: string, fp: string, size: number): OpsReplay {
    const full: OpsReplay = { from: 0, lineBase: 0, kind: "full", anchor: null };
    let b: EffectiveBoundary | null = null;
    try {
        b = latestBoundary(taskUri);
    } catch {
        return full;
    }
    if (!b) return full; // 从未压缩 → 全读（安全，行为与升级前逐字一致）
    const anchor = {
        compactId: b.compactId,
        schema: b.schema,
        keptFromTurnId: b.keptFromTurnId,
        ...(b.keptFromOpsOffset !== undefined ? { keptFromOpsOffset: b.keptFromOpsOffset } : {}),
        ...(b.keptFromLlmLine !== undefined ? { keptFromLlmLine: b.keptFromLlmLine } : {}),
        ...(b.opsBytes !== undefined ? { opsBytes: b.opsBytes } : {}),
    };
    if (b.schema !== OPS_SCHEMA_CURRENT) {
        const lines = countFileLines(llmFile(taskUri));
        return {
            from: size,
            lineBase: lines,
            kind: "schema-break",
            note: `格式断代：账本 schema=${b.schema}、当前=${OPS_SCHEMA_CURRENT}（旧 ops 段不再 replay，只作审计）`,
            anchor,
        };
    }
    if (b.opsBytes !== undefined && size < b.opsBytes) {
        const lines = countFileLines(llmFile(taskUri));
        return {
            from: size,
            lineBase: lines,
            kind: "truncated",
            note: `起点作废：ops 现有 ${size}B < 压缩时 ${b.opsBytes}B（被截断/替换）→ 断代，不回退从 0 读`,
            anchor,
        };
    }
    if (b.keptFromOpsOffset === undefined || b.keptFromLlmLine === undefined) {
        // v1 旧账 / 全清压缩（keptFromTurnId = null 时不记偏移）：跳了就没法对齐行号 → 老实全读
        return { ...full, anchor };
    }
    return { from: b.keptFromOpsOffset, lineBase: Math.max(0, b.keptFromLlmLine - 1), kind: "offset", anchor };
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

/**
 * 账本**限读**结果（##431）。`truncated` = 有更早的记录没读 —— **必须**透给界面，
 * 不许静默截断（与 ##416「不隐藏信息」同一口径）。
 */
export interface CompactLogTail {
    events: CompactLogEvent[];
    truncated: boolean;
    /** 文件当前字节数（不存在 = 0） */
    size: number;
    /** 实际开始读的字节偏移（0 = 从头读的） */
    from: number;
}

/** `compact.events` RPC 的回包（限读结果；`truncated` 由界面显式标出） */
export type CompactEventsResult = CompactLogTail;

/**
 * 读取压缩账本的**尾部限读**（文件不存在 = 从未压缩过；坏行由 parseCompactLog 跳过）。
 *
 * 这是账本的**唯一生产读口**：账本已降为审计日志（##431），页面要的只是最近几次压缩，
 * 而 266 会话实测它 274 MB —— 整份 `readFileSync` + parse 会把主线程按死秒级。
 */
export function readCompactLogTail(
    taskUri: string,
    opts: { maxBytes?: number; maxLines?: number } = {},
): CompactLogTail {
    // 纯读：`compactFile` 是写侧（会建目录），这里用解析后的实际落位（##444 P2）
    const fp = resolveSessionFile(taskUri, "compact");
    const tail = readJsonlTail(fp, {
        maxBytes: opts.maxBytes ?? COMPACT_TAIL_BYTES,
        maxLines: opts.maxLines ?? COMPACT_TAIL_LINES,
    });
    return {
        events: parseCompactLog(tail.lines.join("\n")),
        truncated: tail.truncated,
        size: tail.size,
        from: tail.from,
    };
}

/**
 * 整份读取账本。**只给对照/测试用**（判据：懒迁移重建的结果必须与「扫整份」逐字段一致），
 * 生产路径一律走 `readCompactLogTail` —— 整份读正是本刀要消掉的病根。
 */
export function readCompactLogFull(taskUri: string): CompactLogEvent[] {
    const fp = compactFile(taskUri);
    if (!existsSync(fp)) return [];
    try {
        // sync-io-ok: 仅供测试 / 等价性对照，不是生产读口（生产读口= readCompactLogTail）
        return parseCompactLog(readFileSync(fp, "utf-8"));
    } catch (e) {
        console.error(`[local-agent] 压缩账本读取失败 ${fp}:`, e);
        return [];
    }
}

/**
 * 追加一条压缩账（写失败只出声 —— 记账不能阻断会话）。
 * @returns 该行在账本里的**字节偏移**（写入前的大小；落进快照供回查）
 */
function appendCompactEvent(taskUri: string, ev: CompactLogEvent): number {
    const fp = compactFile(taskUri);
    let at = 0;
    try {
        at = statSync(fp).size; // sync-io-ok: 一次 stat 拿追加起点；与 appendFileSync 同一记账窗口
    } catch {
        at = 0; // 文件还不存在 ⇒ 从 0 开始
    }
    try {
        appendFileSync(fp, `${JSON.stringify(ev)}\n`, "utf-8");
    } catch (e) {
        console.error(`[local-agent] 压缩账写入失败 ${fp}:`, e);
    }
    return at;
}

/**
 * 压缩后首次真发的实测补写（**零额外请求**：借本轮第一步的 usage 记账）。
 *
 * 用户明确放弃了「压缩效果评估」（##230#25），但请求发出去就没了 —— 现在不存，
 * 将来想算账也无从回补。所以只在有「未实测的压缩」时写一条 measure，不做任何判断与提示。
 */
function maybeRecordMeasure(taskUri: string, rec: StepUsageRecord): void {
    // ##431：判据从快照读（`measure.ref` 是否已是这条 compact）—— 不再读账本，也不再扫尾部。
    const state = ensureCompactState(taskUri);
    const point = state?.boundary;
    if (!state || !point) return;
    if (state.measure?.ref === point.compactId) return; // 这条 compact 已实测过

    const b = bucketsOf(rec.usage as UsageLike);
    const ev: MeasureEventRecord = {
        kind: "measure",
        v: 1,
        ref: point.compactId,
        ts: localISOString(),
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
    };
    appendCompactEvent(taskUri, ev);
    writeCompactState(taskUri, { v: 1, boundary: point, opIds: state.opIds, measure: ev });
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
function optsFor(
    policy: CompactPolicy,
    taskUri: string,
    collect?: ClippedToolDetail[],
    /**
     * 【##406 刀 2】装配后硬上限（字节）。缺省 = 按模型窗口算（`assemblyHardCapBytes`）；
     * 预检要**再压一次**时由调用方传更小的值（`tighterHistoryCapBytes`）。
     */
    hardCapBytes?: number,
): DeliveryOpts {
    const transform = makeDeliveryTransform(policy, (id) => toolOutRelPath(taskUri, id), collect);
    return {
        ...transform,
        // 推理的全局回落（##374 T2）：与工具侧的 `defaultClip` 对称
        defaultReasoningClip: DEFAULT_REASONING_CLIP,
        // 出口硬上限（##406 刀 2）：装完再把总字节收进窗口内，
        // 否则「上限 20k token / 实发 4.95 MB」可以同时成立（##401）
        hardCapBytes: hardCapBytes ?? assemblyHardCapBytes(contextLimitOf(personaForTask(diyHome(), taskUri).model)),
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
    /** 旧账本字段（级列表已删：只是为了读旧事件仍能解析） */
    planSnapshot: CompactPlanSnapshot;
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
    return s.length > n ? `${s.slice(0, Math.floor(n / 2))}\n…[截断]…\n${s.slice(-Math.floor(n / 2))}` : s;
}

/**
 * 工具执行时的**轮内锚点**（##408 刀 5）：bash 起的后台 job 要能指回「哪一轮哪一步哪个工具调用」。
 *
 * 为什么用 getter 而不是值：一轮里会跑多步，`stepId` 在流中会变（见 `_s<N>` 的生成点），
 * 而 tools 只构建一次 —— 传值等于把第一步的 id 焊死在后面所有步上。
 */
export interface TurnToolAnchor {
    readonly turnId: string;
    /** 当前步 id（`<turnId>_s<N>`；首批 = turnId） */
    stepId(): string;
}

/**
 * 造 shell 工具（`bash` / `pwsh`）——**依赖注入点**（##515 第 1 步：工具内核已搬进 `@diy-agent/tools`）。
 *
 * 工具语义（前台执行 / 超时 / 取消 / 杀组 / 结果头 / 抛错判据）全在包内；本函数只把 diy-app 的账挂上去：
 *   · 审计 → `agent-bash.jsonl`（补 taskUri；write-ahead：bash-start 先落盘再执行）
 *   · 进程组名册 → `ownedGroups`（认领孤儿用，##408 刀 10）
 *   · 转后台 → `foregroundBash`（UI 按钮接管，##408 刀 21）
 *   · 投递截断 → `capToolOutput` + `markBashTruncated`（##127 / ##419）
 *   · `background` → `runRegistry`（job 账本，##408 刀 8）
 *   · 杀整组 / detached 能力位 → `os` 策略（**唯一**允许平台差异的地方）
 */
function makeShellTools(cwd: string, limits: LocalAgentLimits, taskUri: string, anchor?: TurnToolAnchor) {
    const home = diyHome();
    // 平台能力注入：POSIX 杀进程组；Windows 靠 `taskkill /T /F` 杀整棵树（见 os/win32.ts）。
    // 判据与 `runBash` 头注一致：**组杀只在子进程未收尸时发**（pid 可复用）。
    const runtime: ShellRuntime = {
        processGroups: os.caps.processGroups,
        killGroup: (child) => {
            if (child.pid == null) return;
            if (child.exitCode !== null || child.signalCode !== null) return;
            os.killOwned([{ pid: child.pid }], "SIGKILL");
        },
    };
    return Object.fromEntries(
        shellSpecs().map((spec) => [
            shellToolName(spec),
            makeShellTool(spec, {
                cwd,
                limits: { bashTimeoutMs: limits.bashTimeoutMs },
                runtime,
                audit: (event) => appendAudit(home, { ...event, taskUri }),
                // 「生效参数」与聊天里显示的「工具实际收到」**同源**（`shared/tool-args.ts`）
                effectiveArgs: (raw) => {
                    const eff = effectiveBashArgs(raw);
                    return {
                        command: eff.args.command as string,
                        timeout: eff.args.timeout as number,
                        background: eff.args.background as boolean,
                    };
                },
                onSpawn: (pid, call) => {
                    // 组名册：记下"这个组是我起的" —— 命令里自己 `nohup xxx &` 的子孙被 reparent
                    // 到 launchd 后，只有组号还记得是谁起的。
                    ownedGroups.record(pid, { at: Date.now(), command: call.command, cwd, taskUri });
                },
                onControl: (ctl: BashControl, call) => {
                    // 转后台（##408 刀 21）：**只在拿到 toolCallId 时登记** —— 没有它就没法把按钮
                    // 和调用对上，宁可没按钮，也不造一个点不中的按钮。
                    if (!call.toolCallId) return;
                    const toolCallId = call.toolCallId;
                    foregroundBash.register(toolCallId, {
                        process: ctl,
                        command: call.command,
                        cwd,
                        origin: {
                            taskUri,
                            ...(anchor
                                ? { turnId: anchor.turnId, stepId: anchor.stepId(), toolCallId }
                                : { toolCallId }),
                        },
                    });
                },
                onEnd: ({ pid, toolCallId }) => {
                    // 结束的进程没有「转」这回事：留在表里只会让 UI 显示一个按了必失败的按钮。
                    // 转成功的条目已由 `foregroundBash.detach` 摘除，这里是无操作。
                    if (toolCallId) foregroundBash.drop(toolCallId);
                    // 前台命令跑完：组里没活口就把组记录撤掉（留下孤儿的组要留 —— 那是认领线索）。
                    if (pid !== undefined) ownedGroups.release(pid);
                },
                toModelOutput: (text, toolCallId) => {
                    const capped = capToolOutput(text, toolCallId, taskUri);
                    // 头里的 truncated 位只能在投递层定（真截断才知道），见 markBashTruncated
                    return capped.clipped ? markBashTruncated(capped.text) : capped.text;
                },
                // ── 后台模式（##408 刀 8）──
                // 前台 = 阻塞到结束；后台 = 立即返回 id + 日志路径，结束时插话唤醒。
                // 缺省**不设超时**（##454，前台后台同一条规则）；显式正数才真的到点整组 SIGTERM。
                background: async ({ command, timeoutMs, toolCallId }) => {
                    const proc = await runRegistry.spawn({
                        command,
                        cwd,
                        ...(toolCallId && anchor
                            ? {
                                  origin: {
                                      taskUri,
                                      turnId: anchor.turnId,
                                      stepId: anchor.stepId(),
                                      toolCallId,
                                  },
                              }
                            : { origin: { taskUri } }),
                        ...(timeoutMs > 0 ? { deadlineMs: timeoutMs } : {}),
                    });
                    appendAudit(home, { phase: "bash-background", taskUri, cwd, command, result: proc.id });
                    if (proc.pid !== undefined) {
                        ownedGroups.record(proc.pid, { at: proc.startedAt, command, cwd, taskUri, runId: proc.id });
                    }
                    if (proc.state === "failed") {
                        // 起不来的必须**抛**（命令根本没跑，不是结果）—— 与前台 spawn 失败同口径。
                        // `spawn()` 现在会 await 到 `spawn` / `error` 定局，所以走到这里时
                        // 失败已经确定（此前它只接同步抛，异步 error 事件让这段成了死代码：
                        // 工具先说「已转后台」，几十毫秒后再补一条「启动失败」）。
                        invariant(
                            false,
                            "agent/background-spawn-failed",
                            `${proc.error ?? "未知原因"}（工作目录：${cwd}）`,
                        );
                    }
                    return [
                        `[已转后台] ${proc.id}（pid ${proc.pid}）`,
                        `输出：${proc.logPath}`,
                        "结束时会自动通知你，**不要轮询**（sleep 再查 = 轮询）。现在可以继续干别的，或直接结束本轮。",
                        `随时查：job status ${proc.id} / job output ${proc.id} / job kill ${proc.id}`,
                    ].join("\n");
                },
            }),
        ]),
    );
}

export function buildTools(cwd: string, limits: LocalAgentLimits, taskUri: string, anchor?: TurnToolAnchor) {
    const shellTools = makeShellTools(cwd, limits, taskUri, anchor);
    // read / write / edit 的实现已搬到 `@diy-agent/tools`（##514 工具层抽包）：
    // 本层只做**依赖注入** —— cwd / 预算 / 审计（补上 taskUri 后落 agent-bash.jsonl）。
    // 顺序保持与原实现一致（bash → read → job → write → edit），免得 UI 的工具列表无谓变动。
    const fileTools = buildPackageTools({
        cwd,
        limits: { readMaxBytes: limits.readMaxBytes },
        onAudit: (event) => appendAudit(diyHome(), { ...event, taskUri }),
    });
    return {
        ...shellTools,
        read: fileTools.read,
                /**
         * `job` —— 后台进程的**唯一问询口**（##408 刀 8；##515 第 3 步实现搬进 `@diy-agent/jobs`）。
         *
         * 本层只做两件接线：
         *   · 表就用 diy-app 那一张 `runRegistry`（装配在 services/run-registry.ts）；
         *   · **可见性 = 本任务**（`origin.taskUri` 相等）—— 同一 app 里多任务并行时，
         *     A 不许列 B 的命令、kill B 的活，那是越权不是便利。
         */
        job: makeJobTool({ registry: runRegistry, visible: (r) => runsOfTask([r], taskUri).length > 0 }),
        /**
         * `write` —— 整文件写（##414）。实现与审计语义均在 `@diy-agent/tools`（##514），
         * 本层只把它接进工具集（审计经 fileTools 的 onAudit 补 taskUri 后落盘）。
         */
        write: fileTools.write,
        /**
         * `edit` —— **局部替换**（##415）。实现与审计语义均在 `@diy-agent/tools`（##514），
         * 本层只把它接进工具集（审计经 fileTools 的 onAudit 补 taskUri 后落盘）。
         */
        edit: fileTools.edit,
    };
}

/**
 * 当前 build 的**工具面 hash**（##519）。
 *
 * 口径与真发快照（`step.toolsHash`）**逐字相同**：`sha256Hex(JSON.stringify(buildTools(...)))`。
 * 启动时的漂移预报（`services/tools-surface-watch.ts`）拿它与上次启动比 —— 两个口径分叉就会有
 * 「启动说没变、真发却说变了」的假警报，故这里就写一处、两边都调它。
 *
 * cwd / taskUri 传什么不影响结果（工具面不许依赖它们，`tools-surface-golden` 钉着）；
 * 这里给空串是故意的：**能传空就说明它真不依赖**，将来谁加了 cwd 进去，golden 测试立刻红。
 * `limits` 同理用 `DEFAULT_LIMITS`：现在没有任何描述文案插值运行限制（`readMaxBytes` 只进
 * 执行路径，描述里的「2000 行 / 100KB」是字面量）；若将来真插了，golden 与这条口径都得重算。
 */
export function currentToolsSurfaceHash(cwd = ""): string {
    return sha256Hex(JSON.stringify(buildTools(cwd, DEFAULT_LIMITS, "")));
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
function reportModelUnavailable(e: unknown, taskUri: string, personaId: string, model: string, provider: string): void {
    const n = noticeFromError(e, {
        taskUri,
        personaId,
        personaName: personaDisplayName(personaId),
        model,
        // provider 段是 ##407 修复引导的定位依据（「去配 key」得知道去哪张卡上配）
        provider,
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

/** 准入拒绝块的 id 序号（**不落盘**，只在本次流的消费端里区分两条拒绝对话） */
let gateSeq = 0;

/**
 * 准入拒绝的 op（##400）：**沿用现有 error 块形状**（`start` / `delta` / `stop`，kind=`error`），
 * 但**不建轮次、不落盘** —— 本轮次没有被开启，`ops.jsonl` 里不该出现一条"发生了的事"。
 *
 * `meta.code` 与 `fields.notice` 是给 ##391 的 notice 三问留的**结构化入口**：
 *   来源 = 准入策略（`turn-gate`）· 原因 = 一句话（`reason`）· 详情 = 机制 + 怎么续（`detail`）。
 * 消费端（CLI / room 投递回执）至少读到 `message`；有 notice 面板的渲染端可直接拿 `notice`。
 */
function* rejectionOps(decision: Extract<TurnGateDecision, { allow: false }>): Generator<Op> {
    const id = `gate-${Date.now().toString(36)}-${++gateSeq}`;
    const message = decision.detail ? `${decision.reason}。${decision.detail}` : decision.reason;
    yield { op: "start", id, kind: "error", meta: { source: "turn-gate", code: decision.code } };
    yield {
        op: "delta",
        id,
        fields: {
            message,
            notice: {
                source: `开轮准入 · TurnGate（local-agent.ts::chat → taskTurnGate）`,
                reason: decision.reason,
                detail: decision.detail ?? "",
            },
        },
    };
    yield { op: "stop", id };
}

export class LocalAgentManager {
    private sessions = new Map<string, LocalSession>();
    /**
     * 压缩/快照的**会话内存态**（##442 step 4）：边界、最后一步、压缩次数。
     * 冷启动读一次 turns 全量 + steps 尾行；之后每轮不再整读 8.5MB steps / 300KB turns。
     * 外部写（undo / clear / 另一次 compact）由对应入口失效。
     */
    private compactStates = new Map<
        string,
        {
            boundary: CompactionEntry | null;
            lastStep: DeliveryStepRecord | null;
            compactionCount: number;
            ledgerMtimeMs: number;
        }
    >();

    private compactStateOf(taskUri: string): {
        boundary: CompactionEntry | null;
        lastStep: DeliveryStepRecord | null;
        compactionCount: number;
        ledgerMtimeMs: number;
    } {
        let ledgerMtimeMs = 0;
        try {
            // 只探 compact.jsonl 的 mtime：turn 记录每轮追加，拿 turns mtime 当失效判据会每轮全量重读
            ledgerMtimeMs = statSync(resolveSessionFile(taskUri, "compact")).mtimeMs; // sync-io-ok: 只探一次 mtime（undo / 另一次 compact 的失效判据）；**读口不建目录**（##444 P2）
        } catch {
            /* 文件不存在 = 0 */
        }
        const hit = this.compactStates.get(taskUri);
        if (hit && hit.ledgerMtimeMs === ledgerMtimeMs) return hit;
        if (hit) this.compactStates.delete(taskUri);
        let boundary: CompactionEntry | null = null;
        let compactionCount = 0;
        try {
            for (const e of readTurnEntries(taskUri)) {
                if ((e as CompactionEntry).kind === "compaction") {
                    boundary = e as CompactionEntry;
                    compactionCount++;
                }
            }
        } catch {
            /* 冷启动读失败 = 按“从未压缩/没有 step”处理；发送不受阻 */
        }
        let lastStep: DeliveryStepRecord | null = null;
        try {
            const tail = readJsonlTail(stepsFile(taskUri), { maxBytes: 256 * 1024, maxLines: 1 });
            const line = tail.lines.at(-1);
            if (line) lastStep = JSON.parse(line) as DeliveryStepRecord;
        } catch {
            /* 坏尾行 = 没有快照；下一轮重建 */
        }
        const st = { boundary, lastStep, compactionCount, ledgerMtimeMs };
        this.compactStates.set(taskUri, st);
        return st;
    }

    private invalidateCompactState(taskUri: string): void {
        this.compactStates.delete(taskUri);
    }

    /** 外部写了 turns 边界后刷新内存态（生产写路径已自动更新；测试 / 工具用） */
    refreshCompactState(taskUri: string): void {
        this.invalidateCompactState(taskUri);
    }

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
    private providers = new Map<
        string,
        { chat: ReturnType<typeof createOpenAICompatible> | null; resp: ReturnType<typeof createOpenAI> | null }
    >();
    /**
     * 会话历史的折叠缓存（per task **+ 窗口起点**）：已消费字节 + 前 4KB 指纹 + 增量 fold 出的块树。
     *
     * 为什么必须有：主进程是单线程，全量重放 74MB 会同步阻塞 ~1s 卡住所有 RPC
     * （含别的任务）。而轮末每次 append 只加一点点 —— 缓存后每轮成本 = **尾部大小 + O(块数)**。
     * 上限 HISTORY_CACHE_MAX（LRU）：块树常驻内存，不能无界堆积。
     */
    private historyCache = new Map<string, FoldCacheEntry>();
    private _limits: LocalAgentLimits | null = null;
    /**
     * 在跑的轮次（taskUri → TurnRun）：**轮次的唯一真源**（#305 起不再借道生成器寿命）。
     * 它同时是「同 task 已有轮次在跑」的判据（据此改为**排队**，##306；原 `sess.running`）与消费端订阅者的挂载点。
     */
    private turns = new Map<string, TurnRun>();
    /**
     * 插话队列项 → 消化它的那一轮（`steer/N` → `turnId`）的**增量索引**（##377 第 29 刀）。
     *
     * 为什么是索引而不是新存一份映射：`meta.steerId` 与块的 `parent` 本来就落盘了
     * （`steerBlockOps` / 轮首开场块），这一层只是把"按已有键反查"的成本摊到增量上 ——
     * room 读侧（`room.get`）要对每条 say 的每个投递查一次，每次都全量扫 20k ops 太浪费。
     *
     * `scanned` = 已建索引的 op 条数（ops 只增）。历史变短（会话清零 / 换了文件）⇒ 重建；
     * 同长度原地改写会被漏掉（`history()` 自己已有指纹判据，改写会重建 ops 数组，
     * 这里只在长度变短时重建 —— 记一笔边界，别指望它覆盖"同长度覆盖"）。
     */
    private steerTurns = new Map<string, { scanned: number; pending: Map<string, string>; map: Map<string, string> }>();

    /**
     * 语言模型解析的可注入出口（缺省按 API 面走 zen/go）。
     *
     * 存在理由：插话投递的时机（下一个模型步之前 / 下一轮）只能用**受控的上游**验证 ——
     * 真实 LLM 无法保证"这一步一定调工具、下一步一定给答复"，断言会假红。单测注入桩
     * 模型（`ai/test` 的 MockLanguageModelV3）后，步/轮边界变成确定事件，可逐条断言。
     */
    private readonly modelResolver?: (id: string, key: string) => LanguageModel;

    /**
     * 开轮准入策略（##400，**可选的**依赖倒置扩展点）。
     *
     * 内核只问一句「这个会话现在能不能开轮」，判据全在注入方（生产 = `core/task.taskTurnGate`，
     * 单测 = 假 gate）。不注入 ⇒ 一次都不问，行为与改动前一致。
     * 为什么不在内核写「任务已结案就别干活」：那会让内核依赖任务域（方向反了），
     * 也会把叙述上下文变成「每个 session 类型都要 agent 学一遍」（模型可以不遵守、无法测试）。
     */
    private readonly turnGate?: TurnGate;

    constructor(modelResolver?: (id: string, key: string) => LanguageModel, turnGate?: TurnGate) {
        this.modelResolver = modelResolver;
        this.turnGate = turnGate;
        // 注册表（##240）的活态属性取值器：viewers 只由**内容**订阅者构成（R3 —— 注册表自身的
        // 订阅者不许计入，否则注册表一开全库会话都显示"有人看"）；queue = 待投递留言条数。
        // 这里是注册表缺省取值器的**超集**（多算 chat 流订阅者 `run.subs`）；manager 未构造时
        // 注册表退回缺省（直查 ops-feed）——照样数得出来（review1 P2-1 缺口 C）。
        sessionRegistry.setDeps({
            viewersOf: (uri) => this.watchers(uri),
            // ##435：队列的收件人是 agent，不是人 —— 按署名把人写的与机器写的分开，
            // 只有前者才配叫「有人在等你回复」（L2 抢焦点）。判据见 `core/drafts.isHumanAuthor`。
            // 两个数**同一次 list()** 给出：view() 是热路径，拆成两次就是同一份 drafts.yaml 每帧读两遍。
            queueCountsOf: (uri) => {
                try {
                    const items = this.queue.list(uri);
                    return {
                        total: items.length,
                        human: items.filter((it) => isHumanAuthor(it.author)).length,
                    };
                } catch {
                    return { total: 0, human: 0 }; // 队列读盘失败不能让注册表崩（它只是"此刻的事实"，不是权威落盘）
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
        // 该端点要补的 body 变换（未验证的端点 = undefined，不挂恒等函数）
        const transformBody = bodyTransformFor(baseUrl);
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
        entry.chat ??= createOpenAICompatible({
            name: m.provider,
            baseURL: baseUrl,
            apiKey: key,
            // ##486 / ##491：opencode 网关的自动前缀缓存只活 ~5 分钟，跨轮（间隔常 >5min）会整段重算，
            // 靠策略补 retention（实测记录见 @diy-agent/llm-provider 的 strategies/opencode.ts）。
            // 其它上游没验证过这个字段 ⇒ 策略层不给变换，这里也就什么都不挂。
            ...(transformBody === undefined ? {} : { transformRequestBody: transformBody }),
        });
        return entry.chat(m.id);
    }

    /**
     * 发请求前登记归属 —— 流量观测（undici diagnostics_channel，见 core/traffic.ts）靠
     * 请求头里的**会话归属头**反查「这条记录属于谁」（头名与注入时机归 provider 策略，
     * 见 @diy-agent/llm-provider 的 strategies/opencode.ts），因此每次真发（streamText /
     * generateText）前必须登记一次：同时把计数归零（`attempt` 与步归属，见 ##409）。
     * 之后的**逻辑步**由 prepareStep 里的 `traffic.noteStep` 逐个标出。
     *
     * ##491 起只有认领会话头的端点（opencode 网关）才真带这个头；其它上游靠
     * `noteRun` 登记的 origin 兜底归属（见 traffic.ts 的 `originKind`）。
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
     * 输出预算（##429）—— **真发、预览、摘要三处共用这一个入口**。
     *
     * 链：任务（frontmatter `max_output_tokens`）> 人物（`maxOutputTokens`）>
     *     全局（limits.json / `DIY_LOCAL_MAX_OUTPUT_TOKENS`）> 场景缺省；
     * 之后 `tokens = min(软上限, 模型硬上限)`。判据本身在 `shared/output-budget.ts`（纯函数，可单测）。
     *
     * 为什么是 async：任务级覆盖要读 `AGENTS.md`（文件 IO 不进同步路径，见 `tool#async-io`）。
     */
    async outputBudgetOf(model: string, taskUri: string | null, scene: OutputScene): Promise<OutputBudget> {
        const L = this.getLimits();
        const home = diyHome();
        const task = taskUri ? await taskOutputOverride(home, taskUri) : null;
        const persona = taskUri ? personaOutputOverride(home, taskUri) : null;
        // 未配置（source=default）不等于配成 16384：前者要让场景缺省说话（摘要 2000 / 小任务 200）
        const global = L.maxOutputTokensSource === "default" ? null : L.maxOutputTokens;
        return resolveOutputBudget({ scene, task, persona, global, modelLimit: modelHardLimit(model) });
    }

    /** 成本告警阈值（`0` = 关闭该类），本轮起跑时的 limits 快照口径 */
    costAlarmCfgOf(L: LocalAgentLimits): { stepUsd: number | null; turnUsd: number | null } {
        return {
            stepUsd: L.costWarnStepUsd > 0 ? L.costWarnStepUsd : null,
            turnUsd: L.costWarnTurnUsd > 0 ? L.costWarnTurnUsd : null,
        };
    }

    /**
     * 往通知信箱落一条（N1 的「不许只闪一下」那一半，##429 要求 ④/⑤）。
     * 不阻塞轮次：记账失败只出声，绝不让一次对话因写不进账本而失败。
     */
    noteInbox(partial: Omit<InboxEntry, "id" | "ts">): void {
        void inboxHub.push(inboxEntryOf(partial)).catch((e) => console.error("[local-agent] 信箱落盘失败:", e));
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
        const merged: Record<string, unknown> = { ...(this.readLimitsFile() ?? {}) };
        // `0` 只对两个成本告警阈值有意义（= 关闭该类告警，##429）：其余字段仍是「有限正数」
        const allowZero: ReadonlySet<string> = new Set(["costWarnStepUsd", "costWarnTurnUsd"]);
        for (const [k, v] of Object.entries(patch) as [string, unknown][]) {
            // 非法值忽略（不写坏文件）：与 resolveLimits 同一判据（有限数；正数，或告警阈值的 0）
            if (typeof v === "number" && Number.isFinite(v) && (v > 0 || (v === 0 && allowZero.has(k)))) merged[k] = v;
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
        const sink = this.opSink(sess, taskUri);
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
    private opSink(sess: LocalSession, taskUri: string): (op: Op) => void {
        return (op) => {
            // ##432 刀 1：写盘与记账（字节偏移 / 行号）都在 `@diy-agent/persistence`
            if (!sess.stream.append(op)) {
                // 落盘失败不阻断流，但必须出声（否则丢行不可观测）；**不 publish**（水位不许超前盘）
                console.error(`[local-agent] 会话流落盘失败 ${taskUri}（本条不广播）`);
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
            s = {
                store: new BlockStore(),
                logged: 0,
                llmBase: 0,
                replay: { from: 0, lineBase: 0, kind: "full", anchor: null },
                stream: createOpsAppender(diyHome(), taskUri),
                loaded: false,
                running: null,
            };
            this.sessions.set(taskUri, s);
        }
        if (!s.loaded) {
            // ops 日志 → 块树 → LLM 历史（wire = store = UI = LLM 单一权威路径）
            // ##420：起点取压缩账本的字节偏移（只 replay 保留段）；从未压缩 / 旧账 / 断代 ⇒ from=0。
            const replay = resolveOpsReplay(taskUri);
            s.replay = replay;
            s.llmBase = replay.lineBase;
            if (replay.note) {
                // 断代必须**显式可见**（用户 2026-10-23）：一行日志 + `replay` 标记随会话回给 UI
                console.warn(`[local-agent] 会话 ${taskUri} ${replay.note}`);
            }
            for (const op of readOpsFrom(opsFile(taskUri), replay.from)) s.store.apply(op);
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
    private healResidualOps(taskUri: string, s: LocalSession): Op[] {
        // 现场勘验（##416）：一个开口轮怎么没跑完，先按**时间窗口**查 `log/app-exit.jsonl` 与 minidump。
        // 每批读一次（量级是「每天几条」），查不到就 null ⇒ `danglingStopPatches` 退回空 data，
        // 三档仍归 unknown（SIGKILL / 断电说不出口，不许猜）。
        const evidence = readCauseEvidence(diyHome());
        const now = Date.now();
        return [
            ...interruptedToolPatches(s.store),
            ...danglingStopPatches(s.store, {
                interruptedData: (turn) => {
                    const since = turnStartedAtOf(turn.id);
                    if (since == null) return null; // 没有窗口下界 ⇒ 不判（会把几天前的退出算进来）
                    const cause = classifyInterruptedCause(since, now, evidence);
                    if (!cause) return null;
                    // 落盘（##411 reportError）：同一判定留一条，ctx 带 taskUri / turnId / why / 证据路径
                    // —— 用户面仍只是一句话（`turnEndText`），细节在这里可回溯。
                    reportError(
                        Object.assign(new Error(`本轮未完成：${cause.why}`), {
                            name: "TurnInterrupted",
                            code: cause.code,
                        }),
                        {
                            where: "agent/turn-interrupted",
                            taskUri,
                            turnId: turn.id,
                            why: cause.why,
                            evidence: cause.evidence,
                            evidenceAt: localISOString(new Date(cause.at)),
                        },
                    );
                    return { why: cause.why, evidence: cause.evidence };
                },
            }),
        ];
    }

    private convergeOnLoad(taskUri: string, s: LocalSession): void {
        // 自愈补写的 op 也要走同一个 sink：它们同样是「会话内容」，UI 必须即时看见
        const sink = this.opSink(s, taskUri);
        // 先补 tool 的业务终态（patch + stop），再补剩余结构开口（stop）—— 前者已 stop 的块
        // 不会被后者重复处理（danglingStopPatches 只挑未 stop 的）。
        for (const op of this.healResidualOps(taskUri, s)) {
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
     *
     * ##420：`store` 可能是**只 replay 了保留段**的块树（`s.llmBase > 0`）—— 此时：
     *   · 对比从第 `llmBase + 1` 行开始（前缀不在内存，无从重建，也无必要重建）；
     *   · 「不一致」时**保留前缀原文**、只重写偏移之后的尾段（绝不把整份缩成只剩尾巴）。
     * 文件比 llmBase 还短（被截断 / 换了一份）⇒ 前段不可信，只追加、不改写，并大声说出来。
     */
    private reconcileLlmLog(taskUri: string, s: LocalSession): number {
        const fp = sessionFileForWrite(taskUri, "llm");
        const expect = llmLogLines(s.store);
        let actual: string[] = [];
        if (existsSync(fp)) {
            try {
                actual = readFileSync(fp, "utf-8")
                    .split("\n")
                    .filter((l) => l.trim() !== "");
            } catch (e) {
                console.error(`[local-agent] llm 日志读取失败 ${fp}:`, e);
                return 0;
            }
        }
        const base = Math.max(0, s.llmBase);
        if (base > 0 && actual.length < base) {
            console.warn(
                `[local-agent] llm 日志只有 ${actual.length} 行，少于重放起点 ${base}（被截断/替换）—— 只追加，不改写 ${fp}`,
            );
        }
        // 尾段 = 与 `store` 对齐的那一段（base=0 时就是整份，与旧行为逐字相同）
        const tail = actual.slice(base);
        let k = 0;
        while (k < tail.length && k < expect.length && tail[k] === expect[k]) k++;
        if (k === tail.length && k === expect.length) return k; // 一致
        if (k === tail.length) {
            // 文件是投影的前缀 → 只追加缺的尾部（崩溃残留轮），不动已写行
            try {
                appendFileSync(
                    fp,
                    expect
                        .slice(k)
                        .map((l) => `${l}\n`)
                        .join(""),
                    "utf-8",
                );
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
            const an = readLlmLog(tail.join("\n")).anomalies;
            if (an.length > 0) why = `；异常行：${describeAnomalies(an)}`;
        } catch {
            /* 诊断失败不影响重建 */
        }
        if (base > actual.length) {
            // 前缀都不够长：只能追加，不碰已有内容（宁可尾部多几行，也不删别人写过的历史）
            console.warn(
                `[local-agent] llm 全量日志短于重放起点（${actual.length} < ${base}），只追加尾段 ${fp}${why}`,
            );
            try {
                appendFileSync(fp, expect.map((l) => `${l}\n`).join(""), "utf-8");
                return expect.length;
            } catch (e) {
                console.error(`[local-agent] llm 日志补齐失败 ${fp}:`, e);
                return 0;
            }
        }
        console.warn(
            `[local-agent] llm 全量日志与 ops 投影不一致（第 ${base + k + 1} 条起），${base > 0 ? "按尾段重建" : "整份重建"} ${fp}${why}`,
        );
        try {
            // 原子写（##382 收敛）：整份重建也是「整文件覆盖」，与 core/atomic-write.ts 同语义。
            // 注意**调用方**这里的 catch 仍是「降级返回 k」—— 那是重建路径的既有策略，非写侧行为。
            // ##420：`base > 0` 时前缀不在内存（跳过了），**原样保留**，只重写偏移之后的尾段。
            writeFileAtomic(fp, [...actual.slice(0, base), ...expect].map((l) => `${l}\n`).join(""));
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
            appendFileSync(
                fp,
                expect
                    .slice(s.logged)
                    .map((l) => `${l}\n`)
                    .join(""),
                "utf-8",
            );
            s.logged = expect.length;
        } catch (e) {
            console.error(`[local-agent] llm 日志追加失败 ${fp}:`, e);
        }
    }

    /**
     * **投递口径的历史**（真发 / 预览 / panel 三处唯一入口）。
     *
     * 未压缩 → 与历史行为逐字一致（全量投影）。
     * 已压缩 → 同样只有 messages（##442 刀 2 删了 `history:` 索引注记：它在头部且每轮变，
     * 把前缀缓存整段打碎；压缩信息改由「压缩提示」表达，形态待 review）。
     *
     * 行号口径：llm.jsonl 只增且**第 i 行 = 全量投影第 i 条**（加载时已对账/补齐），
     * 故此处用全量投影的序号当行号 —— 它是模型回取时的真实落点。
     */
    private deliveryHistory(
        taskUri: string,
        store: BlockStore,
        collect?: ClippedToolDetail[],
        /** 【##406 刀 2】更紧的装配后硬上限（预检发现越线时重压一次用）；缺省 = 按模型窗口算 */
        hardCapBytes?: number,
        /** ##420：`store` 在 llm.jsonl 里的行号偏移（只 replay 保留段时 = 被跳过的消息条数） */
        llmLineBase = 0,
    ): HistoryDelivery {
        // 【配置 / 历史分离，用户 2026-10-07】投递口径 = **当前配置**（期望值），每次请求实时算 ——
        // 改预算**本轮即生效**。压缩账（compact.jsonl）只是**历史快照**（不可变，供回溯/对比），
        // 不再决定投递（旧实现读 `resolveBoundary` → 没压过就不生效，违反直觉）。
        const policy = loadAutoCompact(diyHome()).policy;
        return this.buildHistory(store, policy, collect, taskUri, hardCapBytes, llmLineBase);
    }

    /** 面板参数预览用（给定 policy + 边界现算，不读生效账本）—— 与真发同一条构造链 */
    private deliveryHistoryForView(
        store: BlockStore,
        policy: CompactPolicy | null,
        taskUri: string,
        llmLineBase = 0,
    ): HistoryDelivery {
        return this.buildHistory(store, policy, undefined, taskUri, undefined, llmLineBase);
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
        /** 【##406 刀 2】更紧的装配后硬上限；缺省 = 按模型窗口算 */
        hardCapBytes?: number,
        /**
         * ##420：`store` 在 llm.jsonl 里的**行号偏移**（= 读取侧跳过的消息条数）。
         * 注记的 `kept` 是「llm.jsonl 物理行号」，而 `store` 只含保留段 ⇒ 选择出的行号要整体加上它；
         * 忘了加 = 注记把模型指向一批**别的**消息（行号错位，且只错在跳过段的长度上）。
         */
        llmLineBase = 0,
    ): HistoryDelivery {
        const all = projectAll(store);
        // ##442：边界只在压缩事件时算一次并落盘；投递/预览只按它切，绝不新建边界。
        const range = this.appliedHistoryRange(taskUriOf, all, llmLineBase, { write: false, triggered: false });
        const opts: DeliveryOpts = policy
            ? { ...optsFor(policy, taskUriOf, collect, hardCapBytes), ...(range ? { historyCut: range } : {}) }
            : range
              ? { historyCut: range }
              : {};
        return { messages: blocksToMessages(store, opts) as unknown as ModelMessage[] };
    }

    /**
     * **当前生效的压缩边界**（##432 刀 2）—— 已落盘就直接用；没有边界且历史超了单条上限时，
     * **算一次**（`selectCompactableRange`）并落进 `turns.jsonl`（compaction entry），之后每步只读它。
     *
     * 返回的 `cut` / `headEnd` 是**本次 store 的下标**（store 可能只是保留段 ⇒ 减 `llmLineBase`）。
     * `null` = 没有边界（全量投递）。
     */
    private appliedHistoryRange(
        taskUri: string,
        all: readonly LocalModelMessage[],
        llmLineBase: number,
        opts: {
            write?: boolean;
            force?: boolean;
            triggered?: boolean;
            usedTokens?: number | null;
            /** 固定开支（信封 system + tools）估算；只用于「压完能不能降下来」 */
            fixedTokens?: number;
            /** 本次事件的触发线（预检用 0.8W；缺省 = 正常 trigger） */
            triggerAt?: number;
            /**
             * 保留量覆盖（token）：缺省 = 窗口 × 0.16（`retainTokensOf`）。
             *
             * 只给「手动拖压缩位置」（##519）用 —— 用户从尾部实测增量推出「留最近 N 步 ≈ 多少 token」，
             * 那条预算由他定。**只改留多少**：切在哪仍走同一条判据（user 消息 + 轮首），
             * 因为 `resolveOpsReplay` 的 seek 依赖轮首锚点（改它会连带 UI 重放退化）。
             */
            retainTokensOverride?: number;
        } = {},
    ): { cut: number; headEnd: number; wrote: boolean } | null {
        const cfgLimit = normalizeHistoryLimit(loadAutoCompact(diyHome()).history?.limit);
        const windowTokens = cfgLimit.windowTokens ?? contextLimitOf(personaForTask(diyHome(), taskUri).model);
        if (!windowTokens || windowTokens <= 0) return null;
        const retainTokens = opts.retainTokensOverride ?? retainTokensOf(windowTokens);
        const triggerTokens = triggerTokensOf(windowTokens);
        // 手动给预算时不受「预算须小于触发线」约束（人可能故意留很多）；只要预算为正
        if (!(retainTokens > 0)) return null;
        if (opts.retainTokensOverride === undefined && !(triggerTokens > retainTokens)) return null;

        const tokOf = (m: LocalModelMessage): number => estimateTokensOf(JSON.stringify(m.content ?? ""));
        const entry = taskUri ? this.compactStateOf(taskUri).boundary : null;
        let cut = 0;
        if (entry) {
            // 边界优先按 turnId 定位（切点已吸附轮首 ⇒ 消息级 ≡ 轮级）；没有 turnId 才回落行号。
            // turnId 在已加载段里找不到 = 切点在本段之前（partial replay），cut=0 正确。
            const c = entry.cut.turnId
                ? (() => {
                      const i = all.findIndex((m) => m.turn === entry.cut.turnId);
                      return i >= 0 ? i : 0;
                  })()
                : entry.cut.llmLine - 1 - llmLineBase;
            // v2 旧账把 limitTokens 当保留量；v3 用 retainTokens。
            // 旧边界保留量 > 新窗口的保留量 ⇒ 换到更小窗口，旧边界作废（按新窗口重算一次）。
            const oldRetain = entry.v === 2 ? (entry.limitTokens ?? 0) : (entry.retainTokens ?? 0);
            if (c > 0 && (!(oldRetain > 0) || oldRetain <= retainTokens)) cut = Math.min(c, all.length);
        }

        // 只有「压缩事件」才允许新建边界（triggered）；投递/预览/每轮 historySelection 只按旧边界切。
        // 自动：保留段还不到触发线 ⇒ 复用旧边界；用量都不到触发线 ⇒ 不压。
        // 手动（force）：两条都跳过，至少再丢一步。
        if (!opts.force) {
            if (!opts.triggered) return cut > 0 ? { cut, headEnd: 0, wrote: false } : null;
            const triggerAt = opts.triggerAt ?? triggerTokens;
            const used = opts.usedTokens ?? all.reduce((n, m) => n + tokOf(m), 0);
            if (used < triggerAt) return cut > 0 ? { cut, headEnd: 0, wrote: false } : null;
            // 压到目标 retain 也还在线上 ⇒ 结构性超限，写边界只会每轮空转
            const afterBest = (opts.fixedTokens ?? 0) + retainTokens;
            if (afterBest >= triggerAt) {
                console.warn(
                    `[local-agent] 压缩无意义 ${taskUri}：fixed ${opts.fixedTokens ?? 0} + retain ${retainTokens} >= trigger ${triggerAt}`,
                );
                return cut > 0 ? { cut, headEnd: 0, wrote: false } : null;
            }
        }

        const r = selectCompactableRange(all, {
            windowTokens,
            force: opts.force === true,
            // 已有边界不能把历史放回来；force 时至少前进一个 user。
            minCut: cut,
            ...(opts.retainTokensOverride !== undefined ? { retainTokens: opts.retainTokensOverride } : {}),
        });
        if (!r || r.cut <= cut) return cut > 0 ? { cut, headEnd: 0, wrote: false } : null;

        if (taskUri && (opts.write ?? true)) {
            const cutTurnId = all[r.cut]?.turn ?? null;
            const at = localISOString();
            // 补轮首 ops 锚点：之后 resolveOpsReplay 可以直接从 turns 边界 seek
            const turnRec = cutTurnId ? readTurnRecords(taskUri).find((t) => t.turnId === cutTurnId) : undefined;
            const ref = turnRec ? { ops: { offset: turnRec.ref.ops.offset, seq: turnRec.ref.ops.seq } } : undefined;
            appendCompactionEntry(taskUri, {
                at,
                retainTokens,
                windowTokens,
                cut: { llmLine: llmLineBase + r.cut + 1, turnId: cutTurnId },
                ...(ref ? { ref } : {}),
                // v3 同时写旧读侧字段（旧 UI / 旧账本读取路径仍能显示；不参与新算法）
                limitTokens: retainTokens,
                dropped: r.dropped,
                headLine: 0,
            });
            // 内存态同步：新边界 + 次数；lastStep 保留（下轮 frozenSystemTextOf 会因 compactAt 不同而重建）
            const state = this.compactStateOf(taskUri);
            state.boundary = {
                v: 3,
                kind: "compaction",
                at,
                retainTokens,
                windowTokens,
                cut: { llmLine: llmLineBase + r.cut + 1, turnId: cutTurnId },
                ...(ref ? { ref } : {}),
                limitTokens: retainTokens,
                dropped: r.dropped,
                headLine: 0,
            };
            state.compactionCount += 1;
            console.log(
                `[local-agent] 压缩事件 ${taskUri}：丢 ${r.dropped} 条（保留 ${retainTokens} token = 窗口 ${windowTokens} × 0.16）`,
            );
        }
        return { cut: r.cut, headEnd: 0, wrote: true };
    }

    /**
     * 本轮 user 那一行在 `keptBytes` 里占的字节（##421）；不在保留集里（或尾条不是 user）→ 0。
     *
     * 判据：**全量投影的尾条且 role=user** —— 真发每一步都会重建投递，但只有轮首那一步的尾条
     * 才是「本轮输入」（轮中途尾条是 tool-result，那时没有可扣的东西）。
     */
    private tailUserBytes(all: readonly LocalModelMessage[], sel: BudgetSelection, opts: DeliveryOpts): number {
        const i = all.length - 1;
        if (i < 0 || all[i]!.role !== "user" || !sel.kept.includes(i)) return 0;
        // 与选择阶段**同一个成本口径**（含该条实际生效的 clip）——否则扣的不是它被算进去的那个数
        return costOfWith(opts)(all[i]!, sel.clips?.[i] ?? null, sel.reasoningClips?.[i] ?? null);
    }

    /**
     * **自动压缩检测**（只读，不写任何东西）——UI 提示与 CLI 都用它。
     *
     * 只取两个事实（零额外请求、零额外模型调用）：
     *   · windowTokens         —— 最后一步**实测**用量（最后一步 = 窗口占用，见 ##211 §三）的 token 数
     *   · windowLimitTokens    —— 模型窗口；取不到 ⇒ 不自动压
     */
    async autoCompactStatus(taskUri: string): Promise<{
        config: AutoCompactConfig;
        facts: AutoCompactFacts;
        triggers: CompactTrigger[];
        reasons: string[];
        /** 配置真源 `auto-compact.yaml` 的**原始全文**（含注释）—— 供 UI「原始配置」只读视图 */
        raw: { path: string; text: string };
        /** 读配置时的**出声条目**（##370）：非空 = 有键缺失/非法（已逐键回落缺省）。UI 据此说「为什么」 */
        warnings: AutoCompactIssue[];
    }> {
        // 系统上下文：与上次真发那份比（口径与 steps.jsonl 的 systemText 完全一致）
        const home = diyHome();
        // 只读最后一条（尾部限读）：这里每轮都要跑，整读 usage.jsonl 是 4.6 MB
        const last = readLastStepUsage(taskUri);
        // 模型窗口上限（刀 1：窗口触发改成比例后必须有这个数才判；取不到 ⇒ null ⇒ 不触发）。
        // 优先用账本里当场记的 contextLimit，老账本没有就按模型 id 现查。
        const windowLimitTokens =
            (typeof last?.contextLimit === "number" && last.contextLimit > 0 ? last.contextLimit : undefined) ??
            (last?.model ? contextLimitOf(last.model) : undefined) ??
            null;
        const { config, issues: warnings } = loadAutoCompactDetailed(home, { windowLimitTokens });
        // 窗口覆盖（自建/测试模型没有 contextLimit 时）：配置里的 windowTokens 优先。
        const cfgWindow = normalizeHistoryLimit(config.history?.limit).windowTokens;
        // 窗口占用（**token 数**）：口径 = 该会话**最后一步实测用量** `usage.total`（真实 token 数，
        // 最后一步 = 窗口占用，见 ##211 §三；用户 2026-10-15 拍板 token 域，见 ##268 §6.9 D7）。
        // 没有用量账（老会话 / 手工造的会话）→ null：**无实测不判**，不退回「投影字节」估算
        // （那是被用户否掉的"文字数"口径；估出来的 token 数只会误导触发时机）。
        const windowTokens = last ? bucketsOf(last.usage as UsageLike).total : null;
        // ##423：投递出去的那段历史 ≈ token（最后一步轮首的投递选择快照）—— 「什么时候会压」拿它跟上限比
        const retainedTokens =
            typeof last?.historySelection?.keptTokens === "number" ? last.historySelection.keptTokens : null;
        // 已落盘的压缩边界（内存态；冷启动读一次 turns）
        const compactState = this.compactStateOf(taskUri);
        const bEntry = compactState.boundary;
        const boundary = bEntry
            ? {
                  at: bEntry.at,
                  dropped:
                      bEntry.v === 2
                          ? (bEntry.dropped ?? Math.max(0, bEntry.cut.llmLine - 1))
                          : Math.max(0, bEntry.cut.llmLine - 1),
                  limitTokens: bEntry.v === 2 ? (bEntry.limitTokens ?? 0) : (bEntry.retainTokens ?? 0),
              }
            : null;
        const facts: AutoCompactFacts = {
            windowTokens,
            windowLimitTokens: cfgWindow ?? windowLimitTokens,
            retainedTokens,
            boundary,
            compactionCount: compactState.compactionCount,
        };
        const triggers = detectAutoCompactTriggers(facts);
        const raw = { path: autoCompactFile(home), text: readAutoCompactText(home) };
        return { config, facts, triggers, reasons: triggers.map((t) => TRIGGER_TEXT[t]), raw, warnings };
    }

    /**
     * 投递口径的历史消息（与真发同源：压缩边界 + 索引注记 + 工具输出裁剪）。
     * **只读**：自己 replay ops，不加载会话、不落盘 —— 预览用，不应有副作用。
     * （不能用 llm.jsonl：那是 append-only 的**全量**日志，含已被压掉的轮。）
     */
    deliveryMessages(taskUri: string): HistoryDelivery {
        // ##420：只 replay 压缩账本起点之后那段（与 getSession 同一个起点、同一份判定）
        const replay = resolveOpsReplay(taskUri);
        const fp = streamPath(taskUri);
        const uiStart = this.uiReplayStart(taskUri);
        // ##92：本地预览与 UI 重放**同起点**时复用同一份块树（`foldedOps` 那条缓存）——
        // 266 实测冷启动 4.5s，打开一次投递预览面板就再吃一遍；而两条路径要的只是
        // 「同一棵树的两种投影」（这边投递消息、那边折叠 op 流）。缓存里的 `store` 只读
        // （`deliveryHistory` → `buildHistory` 只投影不改块），与 UI 侧共用安全。
        // 起点不一致（断代 / 偏移不是轮首 ⇒ UI 退全量）时照旧现折：投递口径不跟着 UI 的
        // 「宁可慢也要看得见」走 —— 那边能退全量，这边退全量就是重复喂旧轮次。
        const store =
            uiStart === replay.from
                ? this.foldedEntry(taskUri, fp, replay.from).store
                : replayOpsInto(new BlockStore(), fp, replay.from);
        // 断代/截断的标记随消息一起回给 UI（**不许静默空白**：用户看到一个空会话时必须知道为什么）
        // ##432 review E：**只读预览**（面板「投递预览」）不写 turns.jsonl —— 看页面不该改账本
        return { ...this.deliveryHistory(taskUri, store, undefined, undefined, replay.lineBase), replay };
    }

    /** 可选模型（去掉密钥等连接隐私字段，只下发元数据 + 限定名供 UI/CLI 展示） */
    listModels(): Array<Omit<ResolvedModel, "key" | "baseUrl" | "npm" | "kind">> {
        return getModelCatalog().map(({ key: _key, baseUrl: _b, npm: _n, kind: _k, ...meta }) => meta);
    }

    /**
     * 会话的 ops 视图（UI 重放）：块树的**重放起点与投递侧同一个 seek**（##92 → ##420）。
     *
     * 返回的是**折叠后的等价 op 流**（见 local-blocks 的 compactOps）—— 对消费端完全透明：
     * 同一棵块树、同样的渲染结果，只是把逐 token 的碎片压成"每块一次 start + 终值 + stop"。
     * 一次 74MB / 877,050 op 的会话因此变成约 15MB / 1.8 万 op（-98%），
     * 读盘、RPC、渲染端 fold 三段的成本一起降下来（任务 290：大会话假死的治本点）。
     *
     * 【##92 订正：压缩段不再重放】旧实现从字节 0 折整份（142 MB ⇒ 10.3s 同步阻塞），
     * 而压缩账本早已把「哪些轮还在投递里」钉成 `keptFromOpsOffset` —— 被压掉的段是**纯审计**
     * （`findInSession` 仍搜原文）。UI 重放同样从那儿起（见 `uiReplayStart`），压缩面板 /
     * 历史页要完整视图走 `compactEvents` / 检索，不再绑架聊天页的每次加载。
     *
     * 增量：per (task, 起点) 缓存已 fold 的块树 + 已消费字节 + **折叠流**，只读新增尾巴
     * （轮末 append 的代价 = 尾巴大小）。失效判据见下方 invalid —— 宁可把整段重放一遍，
     * 也绝不把两份文件的历史缝在一起。
     */
    history(taskUri: string): Op[] {
        // 降级链优先（##424 刀 2）：ops 读不出明细时用 turns.jsonl 重建；正常路径只是两次廉价判据
        const deg = this.degradedHistory(taskUri);
        if (deg) return deg.ops;
        return this.foldedOps(taskUri, streamPath(taskUri), this.uiReplayStart(taskUri));
    }

    /**
     * UI 重放的起点（##92）：与投递侧**同一个 seek**（##420 的 `keptFromOpsOffset`）。
     *
     * 病根：压缩只动了投递，UI 仍从字节 0 fold 整份 —— 266 会话 142 MB / 121 万 op，
     * 一次全量 fold 实测 **10.3s**（主线程同步）。而被压掉的段按 ##420 口径已是**纯审计日志**
     * （真发不再 replay），UI 也没必要为了“看得见”每秒重放一遍。原文仍在盘上，
     * `findInSession`（搜原文）/ `historyOlder`（上滚）照旧能拿到。
     *
     * 只在 `kind === "offset"` 时跳：断代/截断的会话（旧 schema / 文件被换）保留整份重放 ——
     * 那是**展示**，宁可慢也不能把用户的聊天记录静默变成空白（投递侧才必须断代）。
     * 账本偏移不是轮首（手改 / 旧版）⇒ 同样退全量：半个轮会把块树折成根。
     */
    private uiReplayStart(taskUri: string): number {
        const replay = resolveOpsReplay(taskUri);
        if (replay.kind !== "offset" || replay.from <= 0) return 0;
        return isTurnStartAt(streamPath(taskUri), replay.from) ? replay.from : 0;
    }

    /**
     * **降级链**（##424 刀 2）：ops 读不出明细时，用 `turns.jsonl` 重建只读文本历史。
     *
     * 触发（body 刀 2）：`resolveOpsReplay` 报 `schema-break` / `truncated`，或 ops 文件
     * 不存在 / 为空。正常路径（ops 可读）**不进这个函数体** —— 它先在两处廉价判据处 return，
     * turns 只在降级时被消费，正常时零成本。
     *
     * 拼装口径：
     *   · turns 里**锚点仍在存活段里**的轮直接跳过（真实 op 已经在 `surviving` 里，不能双份）；
     *   · 剩下的轮折成 `user` + `assistant` 文本块（`synthesizeTurnOps`），逐条校 ref：
     *     悬空即在该轮 turn 块上标 `degraded.refDangling`（UI 行内写「原始记录已清理」）；
     *   · 存活段（断代 / 清空之后新跑的轮）照旧用真实 op 拼在**后面**（它们是可用明细）；
     *   · 返回 `degraded` 标记给 UI 挂横幅 —— **不许静默空白**。
     */
    private degradedHistory(taskUri: string): { ops: Op[]; degraded: DegradedHistory } | null {
        const fp = streamPath(taskUri);
        // sync-io-ok: 「在不在」与「多大」要分开答（missing 与 empty 是两种降级原因），
        // 且本方法是**同步读口**（history/historyWindow 都是同步 API）—— 一次 exists + 一次 stat
        const present = existsSync(fp); // sync-io-ok: 同上一行（降级路径专用，正常路径零额外读）
        const size = fileSize(fp);
        // 廉价判据：文件在且非空、且账本不说断代 ⇒ 不是降级场景（正常路径零额外读）
        const replay = resolveOpsReplay(taskUri);
        let cause: DegradedCause | null = null;
        let note = "";
        if (!present) {
            cause = "missing";
            note = "会话 ops 日志不存在（被清理 / 换了数据根 / 从未写出）";
        } else if (size <= 0) {
            cause = "empty";
            note = "会话 ops 日志为空";
        } else if (replay.kind === "schema-break") {
            cause = "schema-break";
            note = replay.note ?? "ops 格式断代";
        } else if (replay.kind === "truncated") {
            cause = "truncated";
            note = replay.note ?? "ops 被截断 / 换了一份";
        }
        if (cause === null) return null;

        // ── 三档事实（##444）：**判据全在盘上**，文案只是它的投影 ─────────────
        // 旧实现把三种不同的事写成同一句「不存在（被清理 / 换了数据根 / 从未写出）」——
        // 用户看到无法判断自己是不是丢了历史（##410 实测：那是「还没跑过轮次」，不是丢了）。
        //   ① 无任何会话痕迹且 turns 为空 ⇒ 还没跑过轮次（说「还没有」，不说「不可用」）；
        //   ② 有 turns 但 ops 不在 ⇒ 结论在、明细原文不在（给 turns 路径供回取）；
        //   ③ 其余 ⇒ 真降级（空 / 断代 / 被截断；旧落位有 ops 却解析不到也落在这一档 = 真 bug）。
        const records = readTurnRecords(taskUri);
        const tier: DegradedTier =
            cause === "missing" && records.length === 0 && !hasAnySessionData(taskUri)
                ? "never-ran"
                : cause === "missing" && records.length > 0
                  ? "conclusion-only"
                  : "degraded";
        if (tier === "never-ran") {
            note = ""; // 档 1 的句子在 shared（`degradedBannerText`），此处不带「不存在」
        } else if (tier === "conclusion-only") {
            note = `轮次结论还在，明细原文已不在（turns: ${turnsFileRel(taskUri)}）`;
        }
        const surviving = present ? readOpsFrom(fp, replay.from) : [];
        const aliveTurns = new Set<string>();
        for (const op of surviving) if (op.op === "start" && op.kind === "turn") aliveTurns.add(op.id);
        const ops: Op[] = [];
        let turns = 0;
        let dangling = 0;
        for (const rec of records) {
            if (aliveTurns.has(rec.turnId)) continue; // 真实 op 还在 ⇒ 不拿文本记录顶掉它
            const check = checkOpsRef(taskUri, rec.ref.ops);
            if (!check.ok) dangling++;
            ops.push(...(synthesizeTurnOps(rec, !check.ok) as unknown as Op[]));
            turns++;
        }
        if (surviving.length > 0) {
            // 与 `history()` 同口径：存活段也走一次 fold + compact（回包体积从 raw 降到段大小）
            const store = new BlockStore();
            for (const op of surviving) store.apply(op);
            ops.push(...compactOps(store));
        }
        if (ops.length === 0 && present && size > 0) {
            // 文件在、有内容，但降级链重建为空（断代 + 没有 turns.jsonl）：
            // 旧 ops 段对本 UI 仍是**可展示**的历史 —— 交回正常路径整份重放
            // （`uiReplayStart` 对 schema-break 退 0），宁可慢也不能把聊天记录静默变成空白（##92 口径）。
            // `missing` / `empty` 不走这条：那两种确实没有可重放的内容，degraded 标记必须留着。
            return null;
        }
        return { ops, degraded: { cause, tier, note, turns, dangling } };
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
     * 插话队列项 → **它被哪一轮消化了**（`steer/N` → `turnId`，##377 第 29 刀）。
     *
     * 用途（body 真缺陷第 1 条）：忙时插话的回复属于**正在跑的那一轮** ⇒ room 里只有 `say`、
     * 没有 `reply`。有了这个 turnId，房间页 / 任务页就能把那条 say 指到"回复在你上面那一轮"，
     * 用户不会以为这句话没回。
     *
     * 判据：还在队列里 / 被取消 / 从没落位 ⇒ `null`（如实说"还没进任何一轮"，不猜）。
     * `taskUri` 必须与该队列项落进的会话一致（队列是按 task 隔离的，调用方拿投递状态里的 taskUri）。
     */
    steerTurnId(taskUri: string, steerId: string): string | null {
        let ops: Op[];
        try {
            ops = this.history(taskUri);
        } catch {
            return null; // 会话不可读不是本读口的错（与 currentAction 同一条口径）
        }
        let idx = this.steerTurns.get(taskUri);
        if (!idx || idx.scanned > ops.length) {
            idx = { scanned: 0, pending: new Map(), map: new Map() };
            this.steerTurns.set(taskUri, idx);
        }
        // ⚠️ `history()` 给的是**折叠后重新 emit** 的 op 流（`compactOps`），形状与原始日志不同：
        //   · `start.meta` 的键被**平铺**进块字段（`BlockStore.apply`），compact 时进 `patch.fields`；
        //   · 所以这里读 `patch.fields.steerId`，而不是 `start.meta.steerId`。
        // 第一版按原始形态读 ⇒ 永远空，真链路用例（⑥）当场抓出。
        for (let i = idx.scanned; i < ops.length; i++) {
            const op = ops[i]!;
            if (op.op === "start") {
                if (op.kind === "text" && typeof op.parent === "string") idx.pending.set(op.id, op.parent);
                continue;
            }
            if (op.op !== "patch") continue;
            const parent = idx.pending.get(op.id);
            if (!parent) continue;
            const sid = op.fields["steerId"];
            if (typeof sid === "string") idx.map.set(sid, parent);
        }
        idx.scanned = ops.length;
        return idx.map.get(steerId) ?? null;
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
        return this.foldedEntry(taskUri, fp, start).compact ?? [];
    }

    /**
     * `foldedOps` 的**缓存条目本体**（##92）：UI 要折叠流（`compact`），投递预览要块树
     * （`store`）—— 同一段字节只该 fold 一次，所以拆出入口，两条路径共用一份缓存。
     *
     * ⚠️ 返回的 `store` 是**共享对象**：调用方只读，不许 `apply` / 改块字段（改了就污染
     * 别人的缓存）。
     */
    private foldedEntry(taskUri: string, fp: string, start: number): FoldCacheEntry {
        const size = fileSize(fp);
        const prefix = readPrefix(fp);
        const key = `${taskUri}#${start}`;
        const cached = this.historyCache.get(key);
        const c: FoldCacheEntry =
            cached && cached.start === start && !(cached.consumed > size || (size > 0 && cached.prefix !== prefix))
                ? cached
                : {
                      start,
                      consumed: start,
                      prefix: "",
                      store: new BlockStore(),
                      compact: null,
                      compactConsumed: -1,
                      loggedIssues: 0,
                  };
        if (size > c.consumed) {
            const { ops, consumed } = readOpsRange(fp, c.consumed, size);
            for (const op of ops) c.store.apply(op);
            c.consumed = consumed;
            c.compact = null; // 块树变了 ⇒ 折叠流必须重算（见下）
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
        // **诊断信息**，不该在压缩里静默蒸发（任务 290 review B4）。
        //
        // ⚠️ **只在新 issue 出现时出声**（##92）：旧实现每次取历史（含缓存命中）都按个数重打一遍，
        // 而 roster 每秒会调 `currentAction` ⇒ 266 会话实测 1.6 次/秒、4 分钟 1400 条同文 ——
        // 日志噪声反过来把“真在干什么”埋了。同一批 issue 对排查只有一个价值（第一次）。
        if (c.store.issues.length > c.loggedIssues) {
            const fresh = c.store.issues
                .slice(c.loggedIssues, c.loggedIssues + 3)
                .map((i) => i.reason)
                .join(" | ");
            console.warn(
                `[local-agent] 会话 ${taskUri} 折叠前 fold 出 ${c.store.issues.length} 条 issue` +
                    (c.loggedIssues > 0 ? `（新增 ${c.store.issues.length - c.loggedIssues}）` : "") +
                    `：${fresh}`,
            );
            c.loggedIssues = c.store.issues.length;
        }
        // 折叠流缓存（##92）：`compactOps` 是 O(块数)，142 MB 会话折完仍 ~80ms / 每次取都新造一份
        // 几十 MB 的 op 流 = 每秒度的 GC 抖动。块树未变（`consumed` 未推进）就复用同一份 ——
        // 调用方只读、不修改返回的数组（拿走后只序列化 / 喂给新 store）。
        if (!c.compact || c.compactConsumed !== c.consumed) {
            c.compact = compactOps(c.store);
            c.compactConsumed = c.consumed;
        }
        return c;
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
        // 降级在前：游标口径对「ops 已不存在/断代」无意义（解码出来的起点不一定是轮首）
        const deg = this.degradedHistory(taskUri);
        if (deg) {
            const dfp = streamPath(taskUri);
            // 带了游标却解不出 / 起点不再是轮首 ⇒ 同样报 stale（渲染端必须重置）——
            // 降级本就是一次「整树换源」，不承认它会让旧窗口的新内容与文本记录缝在一起。
            const at = opts.cursor ? decodeCursor(opts.cursor, dfp) : null;
            const stale = opts.cursor !== undefined && (at === null || !isTurnStartAt(dfp, at));
            return {
                ops: deg.ops,
                cursor: encodeCursor(dfp, 0),
                hasMore: false,
                stale,
                degraded: deg.degraded,
            };
        }
        const fp = streamPath(taskUri);
        const at = opts.cursor ? decodeCursor(opts.cursor, fp) : null;
        // 带了游标却失效（清空 / 覆盖写 / 换了文件）⇒ 退全量：**绝不把两段历史缝在一起**，
        // 与折叠缓存的判据同一取向（宁可重放整份，也不给出错位的窗口）。
        if (opts.cursor && (at === null || !isTurnStartAt(fp, at)))
            return this.segmentOf(taskUri, fp, 0, undefined, true);
        if (at !== null) {
            // 段长封顶（见 WINDOW_CAP_BYTES）：超了就从尾部重 seek，而不是把整段几十 MB 再折一遍。
            let size = 0;
            try {
                size = statSync(fp).size;
            } catch {
                size = 0;
            }
            if (size - at > WINDOW_CAP_BYTES) {
                return this.segmentOf(taskUri, fp, seekWindowStart(fp, opts.budgetBytes ?? WINDOW_SEEK_DEFAULT_BYTES));
            }
        }
        return this.segmentOf(taskUri, fp, at ?? seekWindowStart(fp, opts.budgetBytes ?? 0));
    }

    /**
     * **更早的一段**（上滚取）：`cursor` 所在段起点之前的 `budgetBytes` 字节，
     * 同样向上取一个轮首作为新段起点（floor，永不落空）。
     *
     * 已到文件头（`at === 0`）⇒ 空段 + `hasMore: false`（渲染端据此收工，不再请求）。
     */
    historyOlder(taskUri: string, opts: { cursor: string; budgetBytes?: number }): HistoryWindow {
        // 降级态没有「更早的段」：ops 明细已经不可信，文本历史一次给完（hasMore 恒 false）
        const deg = this.degradedHistory(taskUri);
        if (deg) return { ops: [], cursor: opts.cursor, hasMore: false, stale: false, degraded: deg.degraded };
        const fp = streamPath(taskUri);
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
    historyAt(taskUri: string, opts: { at: number; budgetBytes?: number }): HistoryWindow & { hasNewer: boolean } {
        // 降级态下 ops 偏移不再是定位依据（文件已断代/缺失）⇒ 如实回空 + degraded，不报 stale
        const deg = this.degradedHistory(taskUri);
        if (deg) {
            return {
                ops: [],
                cursor: encodeCursor(streamPath(taskUri), 0),
                hasMore: false,
                stale: false,
                hasNewer: false,
                degraded: deg.degraded,
            };
        }
        const fp = streamPath(taskUri);
        const fallback = { ...this.segmentOf(taskUri, fp, 0, undefined, true), hasNewer: false };
        if (!isTurnStartAt(fp, opts.at)) return fallback;
        let size = 0;
        try {
            size = statSync(fp).size; // sync-io-ok: 压缩账本尾部定位/读取（O(1)~几 MB），与 readOpsRange 同一同步 fold 窗口；改异步会把整条 replay 链染成 async
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
        const fp = streamPath(taskUri);
        let compactedBefore: number | null = null;
        let compactedFromTurnId: string | null = null;
        // ##431：账本降为审计日志 ⇒ 限读尾部（整份读 = 266 会话 274 MB 秒级卡主线程）。
        // 尾部窗口都没扫到 compact ⇒ 当作「从未压缩」（多标几句「未压缩」，不影响搜索本身）。
        const tail = readCompactLogTail(taskUri);
        let latest: CompactEventRecord | null = null;
        for (const e of tail.events) if (e.kind === "compact") latest = e;
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
     *
     * ##431：**限读尾部**（缺省 200 条 / 256 KB）。`truncated` 由调用方（界面）显式标出来，
     * 不许静默截断 —— 账本是审计日志，更早的记录可以没有，但不能“假装全在”。
     */
    compactEvents(taskUri: string): CompactEventsResult {
        return readCompactLogTail(taskUri);
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
    private planCompact(
        taskUri: string,
        policyInput: unknown,
        opts: { force?: boolean; triggered?: boolean; usedTokens?: number | null; fixedTokens?: number } = {},
    ): CompactPlan {
        const policy = normalizePolicy(policyInput);
        // 旧账本字段（级列表与 plan 版本链已删）：读旧事件仍要能解析，所以保留一个最小快照
        // 装配计划已删（##432）；这里只剩一个来源标记，恒为 default（历史口径）。
        const planSource: "config" | "default" = "default";
        const planSnapshot: CompactPlanSnapshot = { source: planSource };
        const scan = scanOpsFile(taskUri);
        const turnIds = listTurnIds(scan.ops);
        const store = new BlockStore();
        for (const op of scan.ops) store.apply(op);
        // 保留 = 预算选择（实时算）。keptRuns = 预算的**过滤器表达**（存进事件，供历史回溯还原 diff）
        const all = projectAll(store);
        // ##432 review C：预览 / 记账也读**同一条已落盘边界**（不写账本：预览不改盘）
        // 预览/记账与真发同一条边界；`write: false` = 只算不落盘。
        const recordsRange = this.appliedHistoryRange(taskUri, all, 0, {
            write: false,
            force: opts.force,
            triggered: opts.triggered,
            usedTokens: opts.usedTokens,
            fixedTokens: opts.fixedTokens,
        });
        const sel = recordsRange
            ? selectHistoryByCut(all, recordsRange, optsFor(policy, taskUri))
            : selectHistoryByCut(all, { cut: all.length, headEnd: all.length });
        const keptRuns = sel.keptRuns;
        const keptSet = new Set(sel.kept.map((i) => all[i]!.turn).filter((t): t is string => !!t));
        const keptTurns = keptSet.size;
        const keptFromTurnId: string | null = sel.kept.length > 0 ? (all[sel.kept[0]!]!.turn ?? null) : null;
        const droppedIds = turnIds.filter((id) => !keptSet.has(id));

        // 机械锚点：保留起点轮的 op 下标；全清（keptTurns=0）→ 压缩时刻的 op 总数
        const keepFromOpIndex =
            keptFromTurnId !== null ? (scan.turnOpIndex.get(keptFromTurnId) ?? -1) : scan.ops.length;

        const clipped: ClippedToolDetail[] = [];
        // before/after 必须走**同一条投递选择**（historyCut），否则 after.turns 会和 keptTurns 打架
        const fullRange = { cut: all.length, headEnd: all.length };
        const before = sizeOfStore(store, { historyCut: fullRange });
        const after = sizeOfStore(store, {
            ...optsFor(policy, taskUri, clipped),
            historyCut: recordsRange ?? fullRange,
        });

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
        const stats = usageStats(readStepUsagesTail(taskUri), after.estTokens, rateSnap);
        return {
            policy,
            keptTurns,
            keptFromTurnId,
            keepFromOpIndex,
            droppedIds,
            keptRuns,
            scan,
            store,
            before,
            after,
            droppedDetail,
            clipped,
            rateSnap,
            stats,
            planSnapshot,
        };
    }

    /**
     * 构造「一次请求的实际投递内容」（展示用）。
     * **与真发同一条链**：assembleGlobals → buildDelivery → blocksToMessages（+ 工具输出裁剪）。
     * 预览的全部价值就是"看到的就是会发出去的"，所以这里不许另算一份。
     */
    private async buildRequestView(
        taskUri: string,
        policy: CompactPolicy | null,
        keptFromTurnId: string | null | undefined,
        summaryOverride?: string,
        /** 调用方**手里已有同一份会话折好的块树**时传入（`compactPreview` 一次算 base/mod 两份视图）：
         *  省掉两遍「整读 + 解析 + 折叠」—— 这是「一份 78MB 文件被读三遍」的那两遍（##321）。
         *  只读复用：`buildHistory` 只投影（`blocksToMessages` / `projectAll` 均不回写块树）。 */
        storeInput?: BlockStore,
    ): Promise<RequestView> {
        const home = diyHome();
        // 同上：预览与真发同一份装配（房间取本任务自己的房间）
        const roomCtx = (await roomRuntimeFact({ roomId: taskUri, taskUri }))?.value ?? null;
        const globals = assembleGlobals(home, projectFromUri(taskUri), {
            taskUri,
            room: roomCtx,
        }) as unknown as Record<string, unknown>;
        const liveDelivery = buildDelivery(globals);
        // 与真发同一条 system 快照（段首冻结；见 `frozenSystemTextOf`）
        const state = this.compactStateOf(taskUri);
        const frozenText = frozenSystemTextOf(liveDelivery, state.lastStep, state.boundary?.at ?? null);
        const delivery: Delivery =
            frozenText === liveDelivery.text.text
                ? liveDelivery
                : {
                      ...liveDelivery,
                      text: { ...liveDelivery.text, text: frozenText, bytes: utf8Bytes(frozenText) },
                  };
        const { cwd } = resolveCwdWithNote(home, taskUri);
        const L = this.getLimits();
        const tools = buildTools(cwd, L, taskUri);
        // ##420：没传块树时只 replay 保留段（传了 = 调用方手里已是同一次加载的树，如 compactPreview）
        const replayPlan = storeInput ? { from: 0, lineBase: 0 } : resolveOpsReplay(taskUri);
        const store = storeInput ?? replay(readOpsFrom(streamPath(taskUri), replayPlan.from));
        // 与真发**同一条链**（含压缩注记）：面板里的"压缩后预览"就是这一份
        const histView = this.deliveryHistoryForView(store, policy, taskUri, storeInput ? 0 : replayPlan.lineBase);
        const summaryText = summaryOverride !== undefined ? summaryOverride : this.effectiveSummary(taskUri);
        const mode = normalizeHistoryLimit(loadAutoCompact(home).history?.limit).summary.mode;
        const notice = compactNoticeItem(taskUri, mode, summaryText, this.compactStateOf(taskUri).boundary);
        // 压缩通知并进第一条保留 user（不单发，避免连续两条 user）；没有边界 ⇒ 逐字不变。
        const messages = normalizeUserRuns(withHeadNotice(histView.messages, notice));
        return {
            model: personaForTask(home, taskUri).model,
            system: delivery.text.text,
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
        return this.effectiveCompactRecord(taskUri)?.details?.summary?.text ?? "";
    }

    /**
     * 当前生效的那条 compact 账（带摘要等 details）。
     * 取法：快照给 `compactId`，账本**限读尾部**里找同 id 的行（摘要在 details 里，不在快照里）。
     * 尾部窗口里找不到（很老的压缩）⇒ undefined + 一句 warn —— 不整份读，也不静默装作“没摘要”。
     */
    private effectiveCompactRecord(taskUri: string): CompactEventRecord | undefined {
        const b = latestBoundary(taskUri);
        if (!b) return undefined;
        const tail = readCompactLogTail(taskUri);
        const hit = tail.events.find((e) => e.kind === "compact" && e.id === b.compactId) as
            | CompactEventRecord
            | undefined;
        if (!hit && tail.truncated) {
            console.warn(`[local-agent] 生效压缩 ${b.compactId} 不在账本尾部窗口内（更早的记录未加载）—— 摘要按空处理`);
        }
        return hit;
    }

    /** 当前生效摘要的结构化数据（预览占位与再生成用） */
    currentSummaryData(taskUri: string): SummaryData {
        return this.effectiveCompactRecord(taskUri)?.details?.summary?.data ?? emptySummary();
    }

    /**
     * 对**将被丢弃的轮**生成结构化摘要（一次模型调用；花钱，故由 UI 显式触发）。
     * 返回渲染好的文本（走 summary.md 模版）+ 结构化数据 + 金额。
     */
    async summarize(taskUri: string): Promise<{ text: string; data: SummaryData; cost: number | null }> {
        // 摘要针对**当前配置下会被丢弃的轮**（与 compact 同一份预算），不再用旧的 keepTurns 旋钮。
        const p = this.planCompact(taskUri, loadAutoCompact(diyHome()).policy, { force: true });
        if (p.droppedIds.length === 0) return { text: "", data: emptySummary(), cost: null };
        const model = personaForTask(diyHome(), taskUri).model;
        const { rm, key } = this.resolveModel(model);
        const dropped = droppedTextOf(p.store, p.droppedIds);
        this.noteTraffic(taskUri, "summary", rm, 2);
        // 场景 = `summary`（##429 要求 ③）：摘要只要一段短 JSON，缺省 2000 不变（回归口径），
        // 但**走同一个解析器**：任务/人物/全局若写得更小，摘要也一样不许越过去（宁可截断重试）。
        const budget = await this.outputBudgetOf(model, taskUri, "summary");
        const res = await generateText({
            model: this.modelFor(rm, key),
            prompt: summaryExtractionPrompt(dropped, p.droppedIds.length),
            headers: headersFor(resolveBaseUrl(rm), { sessionId: sessionIdOf(taskUri) }),
            maxOutputTokens: budget.tokens,
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
    async requestView(taskUri: string): Promise<RequestView> {
        // 与真发同源：读**当前配置**（不是压缩账里的旧 policy；配置 / 历史分离）
        return await this.buildRequestView(taskUri, loadAutoCompact(diyHome()).policy, undefined);
    }

    /** 压缩预览（只算不写）：面板左侧参数 + 右侧请求 YAML diff + 事实表的数据源 */
    async compactPreview(taskUri: string, policyInput: unknown, summaryText?: string): Promise<CompactPreview> {
        const p = this.planCompact(taskUri, policyInput);
        // 一次算两份视图（base/mod）→ 复用 planCompact 刚折好的块树：整读 + 解析 + 折叠只做一次。
        // 同步链路内文件不会变，且投影只读（不回写块树），故两份视图看到的是**同一份**历史。
        const store = p.store;
        // base = **未压缩**的投递（全量历史、无注记）—— 配置 / 历史分离后，"当前配置"就是 mod，
        // 拿它当 base 会得出"无差异"。预览的价值是看"这次压缩**去掉/改了什么**"，故 base 取全量。
        const base = await this.buildRequestView(taskUri, null, undefined, undefined, store);
        // 勾选摘要但尚未生成 → 用占位骨架（让用户先看见"会得到什么"，且不花一分钱）
        const sum = p.policy.summary
            ? summaryText !== undefined
                ? summaryText
                : this.effectiveSummary(taskUri) || summaryPlaceholder(emptySummary(p.droppedIds.length))
            : "";
        const mod = await this.buildRequestView(taskUri, p.policy, p.keptFromTurnId, sum, store);
        const inputRate = costOf(base.model, p.after.estTokens)?.input ?? 0;
        return {
            policy: p.policy,
            keptTurns: p.keptTurns,
            droppedTurns: p.droppedIds.length,
            keptFromTurnId: p.keptFromTurnId,
            before: p.before,
            after: p.after,
            droppedDetail: p.droppedDetail,
            clipped: p.clipped.map((c) => ({
                ...c,
                tool: p.store.blocks.get(c.id)?.tool ? String(p.store.blocks.get(c.id)!.tool) : c.tool,
            })),
            modRequest: mod,
            baseRequest: base,
            facts: layerFacts(base, mod, inputRate),
        };
    }

    /** 固定开支：system 全文（信封 help + vars）+ 工具定义。压缩事件低频，现算即可。 */
    fixedTokensOf(taskUri: string): number {
        try {
            const globals = assembleGlobals(diyHome(), projectFromUri(taskUri), {
                taskUri,
                room: null,
            }) as unknown as Record<string, unknown>;
            const delivery = buildDelivery(globals);
            const { cwd } = resolveCwdWithNote(diyHome(), taskUri);
            const tools = buildTools(cwd, this.getLimits(), taskUri);
            return estimateTokensOf(delivery.text.text) + estimateTokensOf(JSON.stringify(tools));
        } catch {
            return 0;
        }
    }

    /**
     * 手动把压缩位置拖到「保留最近 ≈ 这么多 token」（##519，UI 的手动压缩条）。
     *
     * 与 `compact()` 的关系：那条是「按配置的管道压一次」，这条只干一件事 —— **按人给的预算重划边界**。
     * 为什么预算而不是「步数」：步数不是等价的 token（实测一部会话 p10=370 / p99=5,878），
     * 保留 N 步在界面上只是**显示**，落到边界一律换算成 token（换算在 `compact-manual.ts`，用实测增量）。
     *
     * 为什么切点仍走 user + 轮首：`resolveOpsReplay` 的 seek 锚点是轮首（`keptFromOpsOffset`
     * 取那条轮记录的 ref.ops）。按步切会连带 UI 重放退化 —— 那是另一件事，不与这条 UI 绑在一起。
     */
    /**
     * 按「保留最近 N 轮」直接写边界（##519）。
     *
     * 为什么不再用 token 预算倒推：预算 → 消息级估算 → 切点这条链上两套估算口径会差出数量级，
     * 结果常常是 `r.cut <= 已有 cut` ⇒ **什么都不写**，而界面照样报「已压」。用户实测的现象
     * 就是这个：压前 35 轮，压后重开面板还是 35 轮。这里改成先按 turnId 定位投递里的第一条
     * 消息，再用**同一套估算**把保留量算出来交给同一条判据，切点必然落在那一轮的开头。
     *
     * `keepRounds = 0` 合法 = **压缩到头**：历史全丢，只留当前这一轮（它本来就要发）。
     */
    compactToKeepRounds(
        taskUri: string,
        keepRounds: number,
    ): { cut: number; dropped: number; keptMessages: number; totalMessages: number; keptRounds: number } | null {
        const replay = resolveOpsReplay(taskUri);
        const store = replayOpsInto(new BlockStore(), streamPath(taskUri), replay.from);
        const all = projectAll(store);
        if (all.length === 0) return null;
        const turnIds: string[] = [];
        for (const m of all) {
            const t = (m as { turn?: string }).turn;
            if (t !== undefined && t !== "" && !turnIds.includes(t)) turnIds.push(t);
        }
        const rounds = turnIds.length;
        const keep = Math.max(0, Math.min(rounds, Math.round(keepRounds)));
        // 保留起点：keep=0 ⇒ 最后一轮（只留当前轮）；否则倒数第 keep 轮
        const idx = rounds === 0 ? -1 : Math.max(0, Math.min(rounds - 1, rounds - keep));
        const cutTurn = idx < 0 ? undefined : turnIds[idx];
        // 保留量 = 从那条消息起到末尾的**估算** token（与判据内部同一个估算器）
        let retain = 0;
        let from = 0;
        if (cutTurn !== undefined) {
            from = all.findIndex((m) => (m as { turn?: string }).turn === cutTurn);
            if (from < 0) from = 0;
            for (let i = from; i < all.length; i++) retain += estimateTokensOf(JSON.stringify(all[i]?.content ?? ""));
        } else {
            retain = all.reduce((n, m) => n + estimateTokensOf(JSON.stringify(m.content ?? "")), 0);
        }
        const r = this.appliedHistoryRange(taskUri, all, replay.lineBase, {
            write: true,
            force: true, // 手动：人说了算，不看触发线
            triggered: false,
            retainTokensOverride: Math.max(1, retain),
        });
        if (!r) return null;
        return {
            cut: r.cut,
            dropped: r.cut,
            keptMessages: all.length - r.cut,
            totalMessages: all.length,
            keptRounds: rounds - Math.max(0, idx),
        };
    }

    compactToRetainTokens(
        taskUri: string,
        retainTokens: number,
    ): { cut: number; retainedTokens: number; dropped: number; keptMessages: number; totalMessages: number } | null {
        const replay = resolveOpsReplay(taskUri);
        const store = replayOpsInto(new BlockStore(), streamPath(taskUri), replay.from);
        const all = projectAll(store);
        const r = this.appliedHistoryRange(taskUri, all, replay.lineBase, {
            write: true,
            force: true, // 手动：不受触发线约束，人说了算
            triggered: false,
            retainTokensOverride: retainTokens,
        });
        if (!r) return null;
        let retained = 0;
        for (let i = r.cut; i < all.length; i++) {
            retained += estimateTokensOf(JSON.stringify(all[i]?.content ?? ""));
        }
        return {
            cut: r.cut,
            retainedTokens: retained,
            dropped: r.cut,
            keptMessages: all.length - r.cut,
            totalMessages: all.length,
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
        /** 手动压缩：无视「内容太小 / 压完仍超触发线」两条不压判据，至少丢一步（##442 用户 2026-10-27） */
        force = false,
    ): CompactEventRecord {
        // 【用户 2026-10-07】允许**轮次中**压缩（长任务不能等一轮结束）。压缩只写快照 + 落盘被裁原文，
        // 不改 ops、不重置会话（投递按当前配置实时算），故对正在跑的轮次无副作用。
        // 压缩请求 = 允许新建边界（是否真新建仍由 usedTokens 触发线把关；force 跳过）。
        const lastUsage = readLastStepUsage(taskUri);
        const usedTokens = lastUsage ? bucketsOf(lastUsage.usage as UsageLike).total : null;
        const fixedTokens = this.fixedTokensOf(taskUri);
        const p = this.planCompact(taskUri, policyInput, { force, triggered: true, usedTokens, fixedTokens });
        // 真压缩 = 边界必须落盘；否则下一次投递还会按旧边界（手动小会话尤其明显）。
        let wroteBoundary = false;
        if (p.droppedIds.length > 0) {
            const applied = this.appliedHistoryRange(taskUri, projectAll(p.store), 0, {
                write: true,
                force,
                triggered: true,
                usedTokens,
                fixedTokens,
            });
            wroteBoundary = applied?.wrote === true;
        }
        // 空操作：**边界没真的前进** + 无工具被裁 + 投递字节不缩 ⇒ 不写账。
        // 不能用 droppedIds 判：压过一次后旧轮永远在 droppedIds 里，会写假审计（##442 step 6）。
        const noop = !wroteBoundary && p.clipped.length === 0 && p.after.bytes >= p.before.bytes;

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

        const ts = localISOString();
        // ##420：保留起点在 **llm.jsonl 里的行号**（1-based）= 该轮第一条消息在 `projectAll` 里的下标 + 1。
        // 读取侧靠它把「跳过的消息条数」换算回来（注记行号 / llm 对账都按行号对齐）。
        // 同轮内首条被保留的消息之前可能还有被丢的消息，但重放是从**轮首**开始的，
        // 故这里取的是**该轮第一条消息**，不是 `sel.kept[0]`。
        const firstKeptLlmLine =
            p.keptFromTurnId !== null ? projectAll(p.store).findIndex((m) => m.turn === p.keptFromTurnId) : -1;
        const rec: CompactEventRecord = {
            kind: "compact",
            // ##431：v5 = 明细瘦身（不再写 dropped 全文 / clipped 明细）。读侧仍收 v1~v4 老行。
            v: 5,
            id: ts,
            ts,
            // ##420：账本格式代号（升级 = 一次压缩，旧 ops 段退化为纯审计，永不再 replay）
            schema: OPS_SCHEMA_CURRENT,
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
                ...(firstKeptLlmLine >= 0 ? { keptFromLlmLine: firstKeptLlmLine + 1 } : {}),
                // ##420 起点自证：压缩那一刻 ops.jsonl 的**完整行字节数**（与 `opsBytesOf` 同一口径）
                opsBytes: p.scan.totalBytes,
            },
            // 结果数字（keptTurns/droppedTurns 归这里 —— 它们是结果，不是锚点）
            size: {
                before: p.before,
                after: p.after,
                keptTurns: p.keptTurns,
                droppedTurns: p.droppedIds.length,
            },
            cost: { ...(p.rateSnap ? { rates: p.rateSnap } : {}), ...p.stats },
            // ##431：单条账曾达 20~29 KB（dropped 每轮明细 + clipped 每项六个数字），而账本是**审计日志**。
            // 现在只留计数与 id 清单：`kept`（过滤器表达，几条区间）保留 —— 它是历史回溯 diff 的"保留侧"。
            details: {
                droppedCount: p.droppedIds.length,
                clippedIds: { ids: p.clipped.map((c) => c.id), count: p.clipped.length },
                ...(p.keptRuns ? { kept: p.keptRuns } : {}),
                summary: { text: summary?.text ?? null, data: summary?.data ?? null, cost: summary?.cost ?? null },
            },
            ...(noop ? { noop: true } : {}),
        };
        // 空操作不写账（见上）；非空操作才 append。
        if (!noop) {
            // 旧账本里的 `planVersion` 指针不再写入：plan 版本链已删（##432 清理）。
            // ##431：`opIds` 要在 append **之前**取（旧快照的 opIds 才是历史累积的；append 之后
            // ensure 会先扫到新行、把边界换成新的 —— 值虽不错，但多扫一次且语义不清）。
            const prev = ensureCompactState(taskUri);
            const at = appendCompactEvent(taskUri, rec);
            const cst = this.compactStates.get(taskUri);
            if (cst) {
                try {
                    cst.ledgerMtimeMs = statSync(compactFile(taskUri)).mtimeMs; // sync-io-ok: 审计写完后刷新，避免缓存立刻失效
                } catch {
                    /* 下次 mtime 校验会重载 */
                }
            }
            // 同步刷新**当前值快照**（投递侧下一步就读它，不必再扫账本）。
            // `opIds` 合并：老工作集引用过的工具原文 id 仍可能被 `clear()` / 迁移用到，只增不减。
            const opIds = new Set<string>(prev?.opIds ?? []);
            for (const id of clippedIdsOfEvent(rec)) opIds.add(id);
            writeCompactState(taskUri, {
                v: 1,
                boundary: compactPointOf(rec, at),
                opIds: [...opIds],
                // measure 属于旧边界：换边界后清掉（新边界还没实测）
            });
        }
        return rec;
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
    steerAdd(taskUri: string, mode: SteerMode, text: string, author?: string, notify?: NotifyItem): SteerItem[] {
        const r = this.queue.add(taskUri, mode, text, undefined, author, notify);
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
            ...(it.notify ? { notify: it.notify } : {}),
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
            const lastStep = this.compactStateOf(taskUri).lastStep;
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
        this.invalidateCompactState(taskUri);
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
        // 工具原文 id 必须在**删日志之前**取：删掉 compact.jsonl 之后就再也推不出来了
        // （旧实现在删除循环**之后**读账本 —— 实际读到的是已删的空文件，原文一直没被清）。
        // ##431：优先读当前值快照（O(1)），再并上账本尾部窗口里的 id。
        const toolOutIds = new Set<string>(ensureCompactState(taskUri)?.opIds ?? []);
        for (const e of readCompactLogTail(taskUri).events) {
            if (e.kind === "compact") for (const id of clippedIdsOfEvent(e)) toolOutIds.add(id);
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
        for (const id of toolOutIds) {
            try {
                // sync-io-ok: clear 是同步清理入口（与上方 sessionFilesToClear 的删除同一窗口）
                for (const f of toolOutFileCandidates(taskUri, id)) rmSync(f, { force: true });
            } catch (err) {
                console.error(`[local-agent] 删除工具原文失败 ${id}:`, err);
                ok = false;
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
        // ── 开轮准入（##400）────────────────────────────────────────────
        // 位置就是契约：**在 resolveModel / 自动压缩之前** —— 拒绝时连一次模型解析、一次
        // 压缩检测（读盘）都不做；不建 TurnRun、不动水位、不落盘（这条 error 块只经流，
        // 不进 ops.jsonl —— 它不是这个会话发生的事，而是一次"没发生"）。
        const gate: TurnGateDecision | null = this.turnGate
            ? this.turnGate({ sessionUri: taskUri, kind: seed && seed.length > 0 ? "queued" : "chat" })
            : null;
        if (gate && !gate.allow) {
            yield* rejectionOps(gate);
            return;
        }
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
                    // 装配期就失败（模型 id 不在清单里 / 人物没配模型）⇒ 拿不到 provider
                    provider: "",
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
        // ##442 刀 1：**删除 mode 三态** —— 到点就压，不再有 off/notify 的「只提示不执行」。
        try {
            const st = await this.autoCompactStatus(taskUri);
            if (st.triggers.length > 0) {
                const rec = this.compact(taskUri, autoCompactPolicyInput(st.config), "auto", undefined, st.triggers[0]);
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
        const driving = this.driveTurn(
            run,
            sess,
            message,
            model,
            reasoningEffort,
            key,
            rm,
            persona.id,
            seed,
            origin,
        ).catch((e) => {
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
            // 日志也不丢尾、别的窗口也照样看得见（唯一落盘点，见 opSink 头注）
            const sink = this.opSink(sess, taskUri);
            // ── 先收敛上一轮遗留：tool 的业务终态 + 结构开口（写进 ops，而不是投影时现造）──
            // 不收敛的后果：每次重建历史都现场合成一句「未完成→请重试」，agent 重载会话后
            // 会把被截断的命令再跑一次（任务 92 的「一对话就自杀」）。落盘后它变成已结束的
            // 历史事实，投影与 UI 都只是翻译它。
            // 结构开口（danglingStopPatches）也在这里补，不只在加载时补：自愈原先只挂
            // getSession（每进程一次），于是"上一轮没闭合"能一直挂到主进程重启（生产实测：
            // 开口 turn 跨越 9 轮、挂了 6 天）。此刻 sess.running 已由上方互斥守卫保证为空 ——
            // 上一轮真在跑的话新消息连这个函数都进不来 —— 所以未 stop 的块必是残留
            // （崩溃 / 被杀 / 轮次被中途 abort）。
            for (const op of this.healResidualOps(taskUri, sess)) {
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
            // 看哪间房（判据唯一：`origin.sourceRoomId`，**不落盘**）：自起 = 本任务自己的房间；
            // **投递 = 来源房间** —— 那才是"刚才谁跟我说了什么"发生的地方。
            // ⚠ 不能只看 `origin.room`（review1 R1）：投给主人格 + 发起者是页面操作者本人时，
            //   `opsOriginFor` 按 §44.2 A 把 `room` / `author` 整条掐掉（`meta.room` 不落盘），
            //   而那**仍然是投递**（侧边栏 room 里 @ 某个任务的主人格就是这条路）—— 只看 `room`
            //   会退回本任务自己的房间、看到无关内容。`sourceRoomId` 恒带，专门解决这件事。
            //
            // 水位：自起轮**成轮之后**前移到流尾（宁可重复不可漏，见 `commitSelfStartContext`）；
            // 投递轮**不在这里前移**（归 `room-service`，它按 `sayId` 前移）—— 两边都动会把水位往回拨。
            let ctxCommit: (() => void) | null = null;
            let roomValue: RoomRuntimeValue | null = null;
            try {
                // 排除的那条 say 同样取不落盘的那份（`sourceSayId`）：投给主人格时 `room` 整条不落，
                // 只看 `room.sayId` 会让 `recent` 里出现**自己这条投递**（正文已有一份 ⇒ 同一句话两遍）。
                const sayId = origin?.sourceSayId ?? origin?.room?.sayId;
                const fact = await roomRuntimeFact({
                    roomId: origin?.sourceRoomId ?? origin?.room?.roomId ?? taskUri,
                    taskUri,
                    ...(sayId ? { sayId } : {}),
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
                        ...(it.notify ? { notify: it.notify } : {}),
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
        // ── L3 结论账（##424 刀 1）：本轮事实的**采集位** ──
        // · `turnOpsOffset` 在**写侧**取（本轮第一条 op 落盘之前的 fileSize）—— 不去改
        //   `readOpsRange` 的解析循环算偏移（那是冷加载热路径，body 刀 1 §3）；
        // · `turnOpsSeq` 在 turn start 落盘后取（= 该行行号，与 opsFeed / UI 水位同口径）；
        // · `assistantTexts` 收本轮**全部** assistant 正文（过程句也留；工具正文归 ops）；
        // · 整段旁路：写失败只 warn（`appendTurnRecord` / 本函数双重 try/catch）。
        let turnStartRef: OpsRef | null = null;
        const assistantTexts = new Map<string, { seq: number; text: string }>();
        let turnRecorded = false;
        /** 轮末落一条 turns 记录（幂等；不抛）；`refFirstOp` 由会话流写入器给出（##432 刀 1） */
        const recordTurn = (reason: TurnEndReason): void => {
            if (turnRecorded) return;
            turnRecorded = true;
            try {
                const textOf = (raw: string): { text: string; truncated?: true; bytes?: number } => clipTurnText(raw);
                const user = textOf(input.map((i) => i.text).join("\n"));
                appendTurnRecord(taskUri, {
                    turnId,
                    at: localISOString(),
                    state: turnStateOf(reason),
                    user: user.text,
                    ...(user.truncated ? { userTruncated: true as const } : {}),
                    ...(user.bytes !== undefined ? { userBytes: user.bytes } : {}),
                    texts: [...assistantTexts.values()]
                        .filter((t) => t.text.length > 0)
                        .map((t) => {
                            const c = textOf(t.text);
                            return {
                                seq: t.seq,
                                text: c.text,
                                ...(c.truncated ? { truncated: true as const, bytes: c.bytes } : {}),
                            };
                        }),
                    // 该轮第一条 op 的字节锚点（写侧产出）：拿不到就退 0 —— 降级链会据此判「悬空」
                    refFirstOp: turnStartRef ?? { offset: 0, len: 0, seq: 0 },
                });
            } catch (e) {
                // 采集/截断本身出错也不许冒到轮末收口（旁路铁律）
                console.warn(`[local-agent] turns 记录构造失败（不影响轮末收口）${taskUri}#${turnId}:`, e);
            }
        };
        // 轮次事实的**唯一**登记点（##240 review1 P2-3：runtime-context 的 activeTurns 已收敛为
        // 本注册表的投影，故此处不再另调它 —— 两份由同一批调用点驱动 = 迟早漂移）。
        sessionRegistry.noteTurnStart(taskUri, { turnId, model, cwd: cwd0 });
        appendAudit(diyHome(), {
            phase: "turn-start",
            taskUri,
            model: model,
            cwd: cwd0,
            command: input
                .map((i) => i.text)
                .join("\n")
                .slice(0, 300),
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
        // 块 id → 起始时刻（**只**给 think/tool 记耗时，##399 活动框右侧角标）：think 在
        // reasoning-start 记、在 reasoning-end 结算；tool 在 tool-call（参数已齐、真要动手）
        // 记、在 tool-result 结算 —— 刻意**不含**吐参数那段，那是模型的账、不是工具的账。
        const blockT0 = new Map<string, number>();
        let stepId = turnId;
        let stepN = 0;
        /**
         * 冷缓存提示（##477）：首步的 gap，等这一步的 usage 到手再回填成败。
         * 用 holder 而不是裸 `let`：赋值发生在 prepareStep 回调里，TS 的控制流分析看不到它，
         * 裸变量在 finish-step 那侧会被收窄成 never（编译报 Property 'channel' does not exist）。
         */
        const cacheGap: { current: { channel: string; gapMs: number | null; hinted: boolean } | null } = {
            current: null,
        };
        let rN = 0;
        let aN = 0;
        let uN = 0;
        // turn 级 usage 账本（口径与来源全在 services/turn-usage.ts，那里也解释了
        // 为什么 cached 必须单独记：它是"缓存有没有真的生效"的唯一硬指标，##140 的验收标准）
        const acc = newUsageAcc();
        // 本轮四桶累计（页脚「总输入(非缓存+读+写) / 总输出(文本+思考)」）+ 最后一步快照
        // （窗口占用 = **最后一步** 的总输入+总输出，不是累加 —— 口径三分见 ##211 §三）
        // 与累计金额（每步按各自生效单价算好再加，tier 每一步都可能不同）。
        let turnBuckets: UsageBuckets = {
            noCache: 0,
            cacheRead: 0,
            cacheWrite: null,
            text: 0,
            reasoning: 0,
            outputTotal: 0,
            inputTotal: 0,
            total: 0,
        };
        let lastStepBuckets: UsageBuckets | null = null;
        // 冷缓存等待（##486）的记账位：
        //   · `stepWarmWaitMs` = 本步真发前等掉的毫秒（prepareStep 写、finish-step 落账后清零）
        //   · `warmWaitedStep` = 已经等过的步号（SDK 重试会再次进 prepareStep，同一步只等一次）
        let stepWarmWaitMs = 0;
        let warmWaitedStep = -1;
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
        /**
         * 发言者（##422）：成员 id → `{ id, name? }`，落进 user 块的 `meta.speaker` —— 投影时
         * 变成历史消息的 `from:` 段（模型才知道「这句话是谁说的」）。
         *
         * 名字取自**房间成员表**（`identity.room.members.list`，本轮已算了的那一份，零额外 IO）；
         * 对不上就不写 `name`（判据：**不猜**，宁可只给 id）。空签名 ⇒ 不落键
         * （任务页本人发言）—— 那正是存量行为，投影走裸文本。
         */
        const speakerOf = (author: string | undefined): Record<string, JSONVal> | undefined => {
            if (!author) return undefined;
            const name = identity.room?.members.list.find((m) => m.id === author)?.name;
            return name ? { id: author, name } : { id: author };
        };
        /** 插话的 user 块（三个 op）；parent 一律 = turn —— 该块在文档序上就是"某步之后、下一步之前" */
        const steerBlockOps = (item: SteerItem): Op[] => {
            // 块 id 沿用 turn 内局部序号风格（`<turnId>_suN`），另在 meta 里记 steerId 指回
            // 队列项（`steer/N`）：排障时能对上"日志里这条块是哪次插话投的"
            const id = `${turnId}_su${++uN}`;
            const sp = speakerOf(item.author);
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
                        ...(sp ? { speaker: sp } : {}),
                        // 结构化机器事件（job 结束等）：投影时走 notify，不走 chat（##442 2026-10-27）
                        ...(item.notify ? { notify: item.notify } : {}),
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
            const reason: TurnEndReason =
                endReason ??
                (streamDone ? { type: "completed", data: {} } : { type: "aborted", data: { source: "detached" } });
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
            // 系统侧客观事件（##404 待办 3）：**只记「模型没机会说出口」的那几类收尾**。
            // 判据不是严重程度、而是**可复述性**：`max-steps` / `error` 时模型还活着、自己会在对话里
            // 交代；而崩溃 / 进程重启 / 生成器被 return 展开这几种，本轮**根本没有收尾那句话** ——
            // 事后查「这轮为什么没结果」只有系统说得出来（`agent` 条目在此全缺）。
            // `external-recognized` 的额度 / 窗越线同样不写：它们是常态噪音，全局审计
            // `log/agent-bash.jsonl` 已逐轮兜底，journal 再来一份就是双写流水、反把真事埋掉。
            // 写失败只记 console：日志是副作用，不能带走轮次收尾（这一步必须同步且不抛）。
            if (endTriage.code !== null && TURN_SILENT_END_CODES.has(endTriage.code)) {
                try {
                    addSystemEvent(taskUri, {
                        code: endTriage.code,
                        title: `本轮没有收尾（${endTriage.code}）· steps=${steps}`,
                        body: `${endTriage.reason}\n\n- endReason: \`${reason.type}\`\n- steps: ${steps}\n- usage: ${acc.in} in / ${acc.out} out（cached ${acc.cached}）\n- 全量流水：\`log/agent-bash.jsonl\`（本任务全部轮次）`,
                    });
                } catch (e) {
                    console.error(`[local-agent] 系统日志写入失败（不影响轮次收尾）${taskUri}:`, e);
                }
            }
            // L3 结论账（##424 刀 1）：一轮一条，必须在 turn 的 stop **落盘之后**量 len
            // （上面那段 sink 已写完收尾 op）。旁路：不 await、不 yield、不抛。
            recordTurn(reason);
            // ② 尽力投递：消费端还在就让它看到 stop；已断开则在此停住 —— 状态早已一致（①已完成）
            for (const op of ops) yield op;
        };

        // 轮次事实：模型 + 思考级别（渲染时读它署名/展示档位，不读当前配置 —— 任务 196 的教训）
        yield* emit({ op: "start", id: turnId, kind: "turn", meta: { model: model, reasoningEffort } });
        // turn start 已落盘 + 已 publish ⇒ 写入器刚记的就是这一行的字节锚点（turns.ref 的来源）
        turnStartRef = sess.stream.lastRef();

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
        // 自量（##404 / ##9 提案）：轮首这一份用的是**上一次真发那一步**的账（本进程内存里）。
        // 本步还没发，`turn.steps` = 0 ⇒ 只有 `window` / `last`，这恰好是"发出去之前该知道的"。
        const selfValue = (): ReturnType<typeof selfOf> =>
            selfOf(taskUri, {
                contextLimit: identity.contextLimit,
                steps: stepN,
                cost: turnCost,
                unpriced: turnUnpriced,
            });
        const globals = assembleGlobals(diyHome(), projectFromUri(taskUri), {
            taskUri,
            room: identity.room ?? null,
            self: selfValue(),
        }) as unknown as Record<string, unknown>;
        // 变量树 = 一份全量（信封 help + vars，##520）；与上下文树页同一条构造链。
        const liveDelivery = buildDelivery(globals);
        // 段首 system 快照（##442 用户 2026-10-27）：变量树全在 system，压缩点前不重建。
        // 跨轮变化走 user 控制增量（`sentOf` 里按上一次真发的树算），不砸这条 system 的前缀缓存。
        const frozenState = this.compactStateOf(taskUri);
        const frozenSnap = frozenSystemSnapshotOf(
            liveDelivery,
            frozenState.lastStep,
            frozenState.boundary?.at ?? null,
        );
        const frozenSystemText = frozenSnap.text;
        // 重建 = 本轮它的全部历史按全价重算。这四种原因里只有前两种是正常的，另两种必须留痕
        // （否则“某天账单贵了”又只能靠 flow 猜——##487 就是这么查了半个钟头）。
        if (frozenSnap.reason === "segment-changed") {
            console.log(`[local-agent] 段首 system 随压缩重建 ${taskUri}`);
        } else if (frozenSnap.reason === "legacy-format") {
            console.warn(`[local-agent] 段首 system 快照是老格式（升级前落的），本轮重建一次：${taskUri}`);
        }
        const delivery: Delivery =
            frozenSystemText === liveDelivery.text.text
                ? liveDelivery
                : {
                      ...liveDelivery,
                      text: { ...liveDelivery.text, text: frozenSystemText, bytes: utf8Bytes(frozenSystemText) },
                  };
        /** true = 本轮 system 是现算的（首轮 / 重建）；false = 用的是段首快照，跨轮变化要补 user 增量 */
        const systemIsFresh = delivery.text.text === liveDelivery.text.text;

        // ── 每步重算上下文（##310）──────────────────────────────────
        // 轮首这份 delivery 原本整轮复用 → 长轮次里变量变了模型仍按旧值干活（几小时的 tool 循环
        // 全建在过期数据上）。prepareStep 每步重算一次，**变了才注入**（没变不动 ⇒ 前缀缓存只在
        // 真变那步失效）。变化只走 user 增量（见 prepareStep）。
        const rebuildDelivery = (): Delivery => {
            const g = assembleGlobals(diyHome(), projectFromUri(taskUri), {
                taskUri,
                room: identity.room ?? null,
                // 每步重算 ⇒ 这里是「上一步的账 + 本轮累计」的最新值（`self` 是最高频单元，见 delivery.ts）
                self: selfValue(),
            }) as unknown as Record<string, unknown>;
            return buildDelivery(g);
        };

        // 变更历史（##310 二版）：每步**有变才写**；一段会话的起点 = 一条 baseline（整棵树）。
        // 变更单位 = 原子单元（`chain` 整体一条，不下钻数组 —— 原子字段要变一起变）。
        const ctxUnits = atomicUnitPaths();
        // 变更历史用的口径（去掉"每步必变"的仪表盘单元，见 `changelogUnitPaths`）
        const ctxLogUnits = changelogUnitPaths();
        let ctxSeq = lastCtxLogSeq(taskUri);
        // 该不该写起点：还没有二版记录（新任务 / 从没写过的新格式），或有人显式要求重新起算
        // （会话清零、`diy context rebaseline`）。**每轮只在轮首判一次**：轮中途置的标记下一轮生效。
        let ctxBaselineWritten = hasV2CtxLog(taskUri) && !this.rebaselinePending.has(taskUri);
        // 变更比较的基准 = **上一次真发**的值（跨轮游标；缺省才退回本轮的轮首值）。
        // 用轮首值当基准就只能看见"轮内变化"，跨轮变化（改完正文再来问）会永远漏掉 —— 见字段注释。
        // 内存里没有（进程刚起）= 尝试从盘上**播种**上一次真发的值；播不出来才退回本轮的轮首值。
        let ctxPrevSnap: CtxSnapshot = this.ctxSnap.get(taskUri) ??
            this.seedCtxSnap(taskUri) ?? {
                tree: delivery.tree,
                valueHashes: delivery.valueHashes,
            };
        // **增量游标** = 上一次「已经给模型看过」的树（轮首 `sentOf` 与轮内 `prepareStep` 共用）。
        // 不能默认用本轮轮首值：system 是段首快照，跨轮变化恰恰发生在轮首之前 —— 用轮首值就永远
        // 看不见「改完正文再来问」这类最常见的变化（##310 五轮的老 bug）。
        // 系统刚重建（首轮 / 老格式升级）时 = 当前值（新 system 已经带了，不再补）。
        let prevDeltaSnap: CtxSnapshot = systemIsFresh
            ? { tree: delivery.tree, valueHashes: delivery.valueHashes }
            : ctxPrevSnap;
        // 预算判据与模版线**共用同一个函数**（services/prompt-registry 的 systemOverBudget）：
        // 曾经这里是内联的 `bytes > budget`，逻辑等价但两处各写一遍 —— 日后任何一侧改口径
        // （比如"等于预算算不算超"）都会悄悄分叉，而单测只覆盖得到被调用的那一侧（209 第 3 轮 R-1）。
        const over = systemOverBudget(delivery.text.bytes, contextLimitOf(model));
        if (over) {
            const kb = (n: number) => (n / 1024).toFixed(1);
            const budgetMsg =
                `系统上下文超出预算（${kb(over.used)} KB > ${kb(over.budget)} KB），本轮未发送。` +
                `请精简项目 AGENTS.md / 任务正文 / 技能清单（变量树全在 system 里）。`;
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
            const sp = speakerOf(item.author);
            yield* seal([
                {
                    op: "start",
                    id: uid,
                    kind: "text",
                    parent: turnId,
                    meta: {
                        role: "user",
                        ...(item.kind === "user"
                            ? {}
                            : { steer: item.kind, ...(item.steerId ? { steerId: item.steerId } : {}) }),
                        // 署名（##166 §40 A）：有则落，无则**不落键**（省略 = 本任务本人，
                        // 老数据 / 任务页正常发言都不带，读侧据此区分左右气泡）
                        ...(item.author ? { author: item.author } : {}),
                        // 房间来源（##377 第 23 刀）：`{ roomId, sayId }` —— 收件方据此知道这句话
                        // **是别的房间投过来的**（不是本任务的人在说话）。同样有则落、无则不落键。
                        ...(item.room ? { room: item.room } : {}),
                        // 发言者之于**模型**（##422）：投影成 `from:` 段（带显示名）。
                        // 与 `author` 同写入点、同一来源，但读侧各管一边（UI / LLM）。
                        ...(sp ? { speaker: sp } : {}),
                        // 结构化机器事件（job 结束等）：投影时走 notify，不走 chat（##442 2026-10-27）
                        ...(item.notify ? { notify: item.notify } : {}),
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
        // 输出预算（##429）：软硬分离，真发值 = min(软上限, 模型硬上限)。
        // **整轮只算一次**（与 L 同口径：本轮不中途换挡 —— 否则同轮前后步的 maxTokens 不一致）。
        const budget = await this.outputBudgetOf(model, taskUri, "chat");
        const modelMax = budget.tokens;
        // 成本告警（要求 ⑤）：每轮一份状态（同类只报一次，见 shared/cost-alarm.ts）
        const costCfg = this.costAlarmCfgOf(L);
        let costState = newCostAlarmState();
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
            // 变量增量作为**尾部 user 消息**插在本轮输入之前：它不进块树（llm.jsonl 是块树的转储），
            // 所以下一轮重建历史时不会带上它 —— 每轮只发当前这一份，不会累积。
            // 真发 tools 只构建一次（raw dump / 构成字节 / streamText 共用）；
            // 构成字节 = 环形构成卡与构成报表的数据源（system 容器精确字节 + tools JSON 字节，
            // 消息段由账本每步 prompt 减法导出 —— 见 shared/usage StepUsageRecord.contextParts）。
            const tools = buildTools(cwd, L, taskUri, { turnId, stepId: () => stepId });
            let hist = this.deliveryHistory(taskUri, sess.store, undefined, undefined, sess.llmBase);
            // ── thinking 回放归一（##398）──
            // 上游（DeepSeek thinking 模式 / luminal 严判端点）要求**每条回放的 assistant**都带
            // `reasoning_content`；而生成侧不一定每步都有推理（实测 31% 的 assistant 无 think 块，
            // ##266 会话），SDK 的 assistant 分支见"没有 reasoning part"就**连字段都不输出** ⇒ 整轮 400。
            // 归一 = 给缺推理的 assistant 挂 `providerOptions.openaiCompatible.reasoning_content=""`
            // （消息级 providerOptions 被 @ai-sdk/openai-compatible 整对象透传到 wire）。
            // ⚠️ 只加 providerOptions：**不加 part、不加消息** —— 条数/下标仍 = llm.jsonl 行号（##371 铁律）。
            // 顺序：归一在 rawSink **之前** ⇒ research raw dump（kind:"request"）记的就是**最终 wire 形状**
            // （含这个补丁字段）；UI 预览 / llm.jsonl 仍看不到它 —— 那是块树投影（落盘真源），归一只属于投递侧。
            // 归一判据算**一次**：首步与 prepareStep 的每步都用同一份（两处判据分叉必出「首步补了、
            // 后续步没补」的假修复 —— 正是 ##405 第 85 步 400 的形态）。
            const replayOpts = reasoningReplayOptsOf(rm, reasoningEffort);
            // 一份 `hist` → 最终 wire 形状（历史前注记 + 尾部变量增量 + 摘要 + 推理回放归一）。
            // 抽成闭包：预检「再压一次」要按同一套拼装重算一遍 —— 两处各抄一遍必分叉（##227 老教训）。
            // 摘要段**算一次**：它既进 `sent`，也要原样进投递快照（##5 第 16 轮）。
            // 两处各调一次 `effectiveSummary` 是纯读、值相同，但"恰好相同"不该是快照正确的依据。
            const summaryMode = normalizeHistoryLimit(loadAutoCompact(diyHome()).history?.limit).summary.mode;
            /**
             * 段首 system 是快照（见 `frozenSystemTextOf`），所以**跨轮变化必须落在 user 侧**：
             * 拿「上一次给模型看过的树」（`prevDeltaSnap`）和本轮实时树比，只追加变化的原子单元。
             *
             * 与当轮输入合成**同一份**信封（控制段在前、chat 在后）—— 两条相邻 user 既没必要，
             * 也会让模型把「变量更新」和「用户刚说的话」读成两件事。
             * 系统刚重建（首轮 / 老格式升级）⇒ 基线就是当前值，不再补增量。
             */
            const sentOf = (h: typeof hist): ModelMessage[] => {
                const notice = compactNoticeItem(
                    taskUri,
                    summaryMode,
                    this.effectiveSummary(taskUri),
                    this.compactStateOf(taskUri).boundary,
                );
                const messages = normalizeUserRuns(withHeadNotice(h.messages, notice));
                // 跨轮控制增量：`prevDeltaSnap` 是「上一次给模型看过的树」；本轮轮首 system 已冻结，
                // 变化只补 user。**不在这里前移游标** —— 预检可能重算一次（`sentOf` 会再跑），
                // 前移后第二次就少一段增量，预览/真发会对不上。
                // 只列变化的原子单元、按本步划分分流（口径见 `shared/context/step-delta.ts`）。
                const delta = stepDeltaOf(prevDeltaSnap, delivery, ctxUnits);
                if (delta.text) {
                    const last = messages[messages.length - 1];
                    if (last?.role === "user" && typeof last.content === "string" && isEnvelopeText(last.content)) {
                        messages[messages.length - 1] = { ...last, content: `${delta.text}\n${last.content}` };
                    } else {
                        messages.push({ role: "user", content: delta.text });
                    }
                }
                return ensureReasoningReplay(messages, replayOpts);
            };
            let sent: ModelMessage[] = sentOf(hist);
            // 构成字节（##9 追加的历史段）：system / tools / **历史** 三段，才答得了
            // 「历史占了窗口多少、该不该压」。`historyBytes` 量的是**真发消息段**
            // （含尾部变量增量 + 摘要 + 注记，即 wire 上的 messages 全量），不是块树字节 ——
            // 后者少三条注入（差异见 `sentOf`）。选在 `sent` 之后算，就是为了量"真发"。
            //
            // ⚠️ 三段字节一律走 `utf8Bytes`，**不用 `JSON.stringify(x).length`**：后者是 UTF-16 码元数，
            // 中文 / emoji 会低估 —— 而下游（预检的占比、记账的构成报表）拿它跟字节域的数相加，
            // 口径不一致就会出现「报表说没超、预检说超了」。序列化也**只做一次**（1.3 MB × 多次是白烧 CPU）。
            const toolsJson = JSON.stringify(tools);
            const toolsBytes = utf8Bytes(toolsJson);
            const sentJson = JSON.stringify(sent);
            const sentBytes = utf8Bytes(sentJson);
            const ctxParts = {
                systemBytes: delivery.text.bytes,
                toolsBytes,
                historyBytes: sentBytes,
            };

            // ── 发请求**前**的 token 预检（##406 刀 2 后半）────────────────────────
            // 病灶（##401）：请求 4.95 MB 发出去才知道超了窗口，之后每次「？」都重发同一个 400，
            // 会话被锁死。这里在**发之前**量一次：越 80% 线就按剩余额度重装一次（能压就压），
            // 压不动才拒发并说清「啥到上限了」（`external-recognized`，见 shared/error-triage）。
            // 窗口未知 ⇒ 跳过（没有判据就不报警；装配层的 1 MiB 硬上限照旧生效）。
            const cfgWindow = normalizeHistoryLimit(loadAutoCompact(diyHome()).history?.limit).windowTokens;
            const ctxLimitTokens = cfgWindow ?? contextLimitOf(model) ?? null;
            let historyCapOverride: number | undefined;
            let preflightNotice: string | undefined;
            {
                const systemTokens = estimateTokensOf(delivery.text.text);
                const toolsTokens = estimateTokensOf(toolsJson);
                const messagesTokens = estimateTokensOf(sentJson);
                const totalBytes = delivery.text.bytes + toolsBytes + sentBytes;
                const totalTokens = systemTokens + toolsTokens + messagesTokens;
                const bytesPerToken = totalTokens > 0 ? totalBytes / totalTokens : 4;
                const est0 = estimateRequest({
                    systemBytes: delivery.text.bytes,
                    toolsBytes,
                    messagesBytes: sentBytes,
                    systemTokens,
                    toolsTokens,
                    messagesTokens,
                    contextLimitTokens: ctxLimitTokens,
                });
                if (est0.over && ctxLimitTokens !== null) {
                    // 预检也是压缩事件：先按正常目标（retain）写边界，下一轮才会从新边界开始，
                    // 而不是每轮 cap 一次、首条保留消息每轮往前滑（##442 step 6 P0-1）。
                    const fixedTokens = systemTokens + toolsTokens;
                    const capRange = this.appliedHistoryRange(taskUri, projectAll(sess.store), sess.llmBase, {
                        write: true,
                        triggered: true,
                        usedTokens: est0.estTokens,
                        fixedTokens,
                        triggerAt: est0.thresholdTokens ?? undefined,
                    });
                    // `tighterHistoryCapBytes` 返回 0 = 「system + tools 已顶满，历史一分不留」。
                    // 但装配层的约定是 `capBytes <= 0` ⇒ **不设上限**（老调用点兼容），所以这里钳到 1 字节
                    // —— 语义上等价于「历史全丢」，同时保住「必须降级」这条判据。
                    const tightCap = Math.max(
                        1,
                        tighterHistoryCapBytes({
                            contextLimitTokens: ctxLimitTokens,
                            systemBytes: delivery.text.bytes,
                            toolsBytes,
                            bytesPerToken,
                        }),
                    );
                    const histBase = capRange?.wrote
                        ? this.deliveryHistory(taskUri, sess.store, undefined, undefined, sess.llmBase)
                        : hist;
                    const hist2 = this.deliveryHistory(taskUri, sess.store, undefined, tightCap, sess.llmBase);
                    // 只把「cap 在边界之外又丢的」通知给模型；边界本身由 head compact 通知覆盖
                    const capDropped = Math.max(0, histBase.messages.length - hist2.messages.length);
                    const sent2 = addCapNotify(sentOf(hist2), taskUri, capDropped);
                    const sent2Json = JSON.stringify(sent2);
                    const est2 = estimateRequest({
                        systemBytes: delivery.text.bytes,
                        toolsBytes,
                        messagesBytes: utf8Bytes(sent2Json),
                        systemTokens,
                        toolsTokens,
                        messagesTokens: estimateTokensOf(sent2Json),
                        contextLimitTokens: ctxLimitTokens,
                    });
                    if (est2.estTokens < est0.estTokens) {
                        // 压得动 ⇒ 直接换掉这份投递，并**告知**（轮尾 notice，不冒充错误）
                        hist = hist2;
                        sent = sent2;
                        // 压缩换掉了消息段 ⇒ 构成字节跟着换（否则报表会把"压之前"的字节当"发出去的"）
                        ctxParts.historyBytes = utf8Bytes(sent2Json);
                        historyCapOverride = tightCap;
                        preflightNotice =
                            `上下文接近窗口上限（${est0.estTokens} tokens > 窗口 ${ctxLimitTokens} 的 80%），` +
                            `已自动压缩到 ${est2.estTokens} tokens 后发送`;
                        console.warn(
                            `[local-agent] token 预检已自动压缩 ${taskUri}：${est0.estTokens} → ${est2.estTokens} tokens`,
                        );
                    }
                    if (est2.estTokens > (est0.thresholdTokens ?? Number.MAX_SAFE_INTEGER)) {
                        // 压不动（system + tools 本身就顶满 / 历史已到不可再收）⇒ **不静默 400**
                        const msg =
                            `本轮请求约 ${est2.estTokens} tokens，超过模型 ${model} 窗口 ${ctxLimitTokens} 的 80%` +
                            `（阈值 ${est0.thresholdTokens} tokens），压到极限仍超 ⇒ 本轮未发送。` +
                            `处置：压缩/清理本会话历史，或换上下文窗口更大的模型。`;
                        setEndReason({ type: "error", data: { source: "context-window", message: msg } });
                        yield* errorBlock("context-window", msg);
                        failed = true;
                        return { failed, turnId };
                    }
                    if (preflightNotice) yield* emit({ op: "patch", id: turnId, fields: { notice: preflightNotice } });
                }
            }
            // 本轮的**投递选择事实**（配置驱动压缩）：分表用它标注「本步（轮首）投递被压过」（##272 B1）。
            // 与 compact 事件解耦 —— 事件只在触发/手动时写；这里每轮首都有（投递本就无条件按当前配置筛选）。
            // ##432 review C：这里必须与**真发**同一条口径（已落盘的压缩边界），否则面板/账本
            // 报的是旧算法的数字。`persist=false`：这一步的落盘已由 `buildHistory` 做过。
            const selPolicy = loadAutoCompact(diyHome()).policy;
            const allMsgs = projectAll(sess.store);
            const stepRange = this.appliedHistoryRange(taskUri, allMsgs, sess.llmBase, {
                write: false,
                triggered: false,
            });
            const sel = stepRange
                ? selectHistoryByCut(allMsgs, stepRange, {
                      ...optsFor(selPolicy, taskUri),
                      ...(historyCapOverride !== undefined ? { hardCapBytes: historyCapOverride } : {}),
                  })
                : selectHistoryByCut(allMsgs, { cut: allMsgs.length, headEnd: allMsgs.length });
            // 装配层硬上限降级了 ⇒ 出声（这是「压缩与实发不一致」的现场证据，必须留痕）
            if (sel.hardCap && sel.hardCap.degradations.length > 0) {
                console.warn(
                    `[local-agent] 装配后硬上限降级 ${taskUri}（cap=${sel.hardCap.capBytes}，kept=${sel.keptBytes}` +
                        `，${sel.hardCap.withinCap ? "已落进上限" : "仍未落进上限"}）：` +
                        sel.hardCap.degradations.map((d) => `${d.kind}(${d.detail})`).join("；"),
                );
            }
            const historySelection = {
                limitTokens: retainTokensOf(contextLimitOf(model) ?? 0),
                // ##423：丢 / 留都说 **token**（与上限同口径）—— 徽章不再拿字节和 token 上限比
                keptTokens: sel.kept.reduce(
                    (n, i) => n + estimateTokensOf(JSON.stringify(allMsgs[i]?.content ?? "")),
                    0,
                ),
                droppedTokens: sel.dropped.reduce(
                    (n, i) => n + estimateTokensOf(JSON.stringify(allMsgs[i]?.content ?? "")),
                    0,
                ),
                keptBytes: sel.keptBytes,
                keptRuns: sel.keptRuns.length,
                droppedMessages: sel.dropped.length,
                totalMessages: allMsgs.length,
            };
            rawSink({
                kind: "request",
                ts: localISOString(),
                model: model,
                system: delivery.text.text,
                tools: Object.keys(tools),
                settings: {
                    maxSteps: L.maxSteps,
                    maxOutputTokens: modelMax,
                    // ##429 要求 ②：**这个上限是哪一层定的**也要落 —— 光有数字回答不了“为何这次是 xxx”
                    outputBudget: {
                        soft: budget.soft,
                        layer: budget.layer,
                        modelLimit: budget.modelLimit,
                        ...(budget.clamped ? { clamped: budget.clamped } : {}),
                    },
                    maxRetries: 2,
                    reasoningEffort: reasoningEffort ?? "none",
                },
                messages: sent,
            });
            // 投递快照（每轮真发一条）：投递事实，供 UI 的 step/diff 用（与 raw 那种旁路观测不同）。
            // 落盘失败不阻断发送（它只是观测），但必须出声。
            const prevStep = this.compactStateOf(taskUri).lastStep; // 本任务的上一轮（用于算变化）
            // 会话 id 算一次就够（`sessionIdOf` 纯拼串，但快照与 header 必须逐字同一份，别各算一遍）
            const sid = sessionIdOf(taskUri);
            const step: DeliveryStepRecord = {
                ts: localISOString(),
                turnId,
                model,
                wireVersion: delivery.wireVersion,
                places: delivery.text.places,
                valueHashes: delivery.valueHashes,
                systemText: delivery.text.text,
                ...(this.compactStateOf(taskUri).boundary?.at
                    ? { compactAt: this.compactStateOf(taskUri).boundary!.at }
                    : {}),
                // `summaryText` 不再写：压缩结论现在只在 notify.kind=compact.summary（##442）。
                // 真发 tools 的字节 hash（##519）：整段前缀失配的两种自因之一（另一种是 system 重建）。
                toolsHash: sha256Hex(toolsJson),
                // 网关会话 id（只对 opencode 网关有意义）：把「cacheRead=0」拆成「换会话」与「缓存没了」。
                ...(sid ? { sessionId: sid } : {}),
            };
            // 两种**我们自己造成的**整段失配，各留一行痕 —— 没有它就只能翻 reqlog 逐字节 diff 才查得出
            // （##519 实测：一个空格改掉整段 300k 前缀，$0.045）。只出声、不阻断：改工具描述是正当开发。
            if (prevStep?.toolsHash && prevStep.toolsHash !== step.toolsHash) {
                console.log(
                    `[local-agent] 工具面变更 ⇒ 本轮首步整段失配（tools 排在 system 之前）：${taskUri} ` +
                        `${prevStep.toolsHash.slice(0, 8)} → ${step.toolsHash!.slice(0, 8)}`,
                );
            }
            // ⚠️ 正常情况下永不触发（`sessionIdOf` 由任务 uri 决定、压缩也不换，见 ##230）——
            // 留着是因为它一旦变了，失配原因就和工具面/压缩完全不同（换会话 ⇒ 跨会话不共享前缀）。
            if (prevStep?.sessionId && step.sessionId && prevStep.sessionId !== step.sessionId) {
                console.warn(
                    `[local-agent] 网关会话换了一条（跨会话不共享前缀缓存）：${taskUri} ` +
                        `${prevStep.sessionId} → ${step.sessionId}`,
                );
            }
            appendStep(stepsFile(taskUri), step);
            this.compactStateOf(taskUri).lastStep = step;
            // 变更统计（**按项目**累计；只存变化路径 → 体积小、可长期留）。
            // 用途：跑几天后回答"这个节点到底变了几次" —— 划分位置的判据（见 task 178）。
            appendContextStat(
                projectDir(projectFromUri(taskUri)),
                statFromStep(step, prevStep?.valueHashes ?? null, taskUri),
            );
            this.noteTraffic(taskUri, turnId, rm, 2);
            const result = streamText({
                model: this.modelFor(rm, key),
                system: delivery.text.text,
                messages: sent,
                tools,
                stopWhen: stepCountIs(L.maxSteps),
                abortSignal: signal,
                headers: headersFor(resolveBaseUrl(rm), { sessionId: sessionIdOf(taskUri) }),
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
                prepareStep: async ({ messages, stepNumber, steps: priorSteps }) => {
                    // 流量观测（##409）：这一步的编号先登记进 traffic，然后才发这一步的请求 ——
                    // 于是该步内的 SDK 重试（同一步的多次 HTTP 往返）在记录里带
                    // stepSeq = 步号、attemptInStep = 该步第几次往返，重试链可复盘。
                    // 编号与下面变更历史的 stepNo / stepId(`_s<N>`) 同一个（1 起）。
                    traffic.noteStep(sessionIdOf(taskUri), turnId, stepNumber + 1);
                    if (signal.aborted) return {};
                    // ── 冷缓存等待（##486）──
                    // 上一步全冷 ⇒ 本步真发前等 1s（给上游缓存落位留窗口）；**正常路径零延迟**：
                    // 判据说不等就不排定时器。轮内后续步取 SDK 给的「上一步」，轮首步取本进程内存
                    // 里的上一步（跨轮 / 跨 run，见 self-usage）；都没有（进程刚起）⇒ 不等。
                    // 重试会再次进 prepareStep（同一步号）—— 同一个步只等一次。
                    if (warmWaitedStep !== stepNumber) {
                        stepWarmWaitMs = 0; // 上一步的等待不带到这一步（重试路径靠 stepNumber 守卫）
                        const prevUsage = priorSteps.at(-1)?.usage;
                        const prev = prevUsage ? bucketsOf(prevUsage as UsageLike) : selfLastBuckets(taskUri);
                        const warm = await warmWaitIfCold(
                            prev ? { cacheRead: prev.cacheRead, inputTotal: prev.inputTotal } : null,
                            { signal },
                        );
                        if (warm.waitedMs > 0) {
                            warmWaitedStep = stepNumber;
                            stepWarmWaitMs = warm.waitedMs;
                        }
                    }
                    if (signal.aborted) return {}; // 等的那 1 秒里用户按了停止：别接着发
                    // ── 冷缓存提示（##477）：只记**首步** ──
                    // 轮内后续步挨着发（秒级 gap），记进来只会把 safePoint 的 P90 拖歪；
                    // 而"这次请求贵不贵"的判定恰好只需要每轮第一个请求的间隔。
                    if (stepNumber === 0) {
                        const r = cacheHint.noteRequest({
                            provider: rm.provider,
                            model: rm.id,
                            taskUri,
                            ...(identity.persona ? { persona: identity.persona } : {}),
                        });
                        cacheGap.current = { channel: r.channel, gapMs: r.gapMs, hinted: r.hint !== null };
                    }
                    let nextMessages: ModelMessage[] | undefined;
                    // ── 上下文及时刷新（##310）──
                    // 每步重算；**变了才注入**（没变什么都不返回 ⇒ 不砸前缀缓存）。
                    // 新形态（##442 / ##520）：变量树的任何变化都只追加**一条** `role:user` 增量
                    // （`vars:` 一段，见 `controlDeltaDelivery`）；
                    // 不再用 SDK 的 `instructions` 覆盖 system（那会把段首快照撕掉）。
                    try {
                        const fresh = rebuildDelivery();
                        // ── 本步控制增量（只列变化的原子单元）──
                        const delta = stepDeltaOf(prevDeltaSnap, fresh, ctxUnits);
                        // ── 变更历史（##310）：每步一条，**有变才写** ──
                        // 首条写 baseline（整棵树，会话起点）；之后只写真变的步 —— "什么都没变"不落盘。
                        const stepNo = stepNumber + 1;
                        const ref = { turnId, stepId: `${turnId}_s${stepNo}`, step: stepNo };
                        // 增量口径要**含 self**（它不在变更历史里，但模型必须看到最新窗口占用）；
                        // 变更历史仍用 `ctxLogUnits`（去掉每步必变的仪表盘单元）。
                        if (!ctxBaselineWritten) {
                            appendCtxLog(taskUri, {
                                seq: ++ctxSeq,
                                type: "baseline",
                                ts: localISOString(),
                                model,
                                wireVersion: fresh.wireVersion,
                                ref,
                                data: { tree: fresh.tree },
                            });
                            // 标记是一次性的：写完即销，下一步起走正常「有变才写」。
                            this.rebaselinePending.delete(taskUri);
                            ctxBaselineWritten = true;
                        } else {
                            const changes = changesOf(ctxPrevSnap, fresh, ctxLogUnits);
                            if (changes.length > 0) {
                                appendCtxLog(taskUri, {
                                    seq: ++ctxSeq,
                                    type: "changed",
                                    ts: localISOString(),
                                    model,
                                    wireVersion: fresh.wireVersion,
                                    ref,
                                    data: { changes },
                                });
                            }
                        }
                        // 变了才追加一条变量增量：只列变化的原子单元。
                        // 数组 / map 按整单元替换；整个单元消失 ⇒ `path: null`（`subsetOfDelta`）。
                        //
                        // ⚠️ 第 1 步（`stepNumber === 0`）**不注入**：跨轮变化已经由 `sentOf` 并进
                        // 本轮输入那条 user 信封；这里再发一条就是「chat + 增量」两条相邻 user。
                        // 只前移游标（否则第 2 步会把同一批变化再发一遍）。
                        if (stepNumber > 0 && delta.text) {
                            nextMessages = [...messages, { role: "user" as const, content: delta.text }];
                        }
                        prevDeltaSnap = { tree: fresh.tree, valueHashes: fresh.valueHashes };
                        ctxPrevSnap = { tree: fresh.tree, valueHashes: fresh.valueHashes };
                        this.ctxSnap.set(taskUri, ctxPrevSnap);
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
                                ...items.map((it) => ({
                                    role: "user" as const,
                                    // 结构化机器事件走 notify；普通插话走 chat（##442 2026-10-27）
                                    content: it.notify
                                        ? userEnvelope({ notify: [it.notify] })
                                        : chatEnvelope([{ from: it.author ?? HUMAN_MEMBER_ID, text: it.text }]),
                                })),
                            ];
                        }
                    }
                    // ── thinking 回放归一（##405 残留 · ##398 的一半）──
                    // 首步的 messages 是我们构造的（上面 `sent` 已归一），但 **第 2 步起** SDK 送进来的是
                    // 「原 input messages + 内部 stepMessages」—— 其中**上一步的 assistant** 是 SDK 用响应
                    // 重新拼的，**不带我们挂的 providerOptions**。上一步没吐 reasoning（实测 31%）⇒ 本步
                    // wire 上那条 assistant 连 `reasoning_content` 字段都没有 ⇒ 严判端点 400，且**整轮**死在
                    // 半路（##405 实测：同一轮第 1~84 步全 200，第 85 步 400）。
                    // ⇒ 归一必须**每一步**都跑，而不是只跑首步。
                    // `?=` 语义由函数自己保证：无需补时返回**同一个数组引用**（SDK 看到 messages 未变，
                    // 不砸前缀缓存、不重置 stepMessages）。
                    const base = nextMessages ?? messages;
                    const replayed = ensureReasoningReplay(base, replayOpts);
                    if (replayed !== base) nextMessages = replayed;
                    return nextMessages === undefined ? {} : { messages: nextMessages };
                },
            });

            try {
                for await (const part of result.fullStream) {
                    rawSink({ kind: "part", seq: ++rawSeq, ts: localISOString(), part });
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
                            blockT0.set(id, Date.now());
                            yield* emit({ op: "start", id, kind: "think", parent: stepId });
                            break;
                        }
                        case "reasoning-delta": {
                            let id = partBlock.get(part.id);
                            if (!id) {
                                id = `${turnId}_r${++rN}`;
                                partBlock.set(part.id, id);
                                blockT0.set(id, Date.now());
                                yield* ensure(id, "think", stepId);
                            }
                            yield* emit({ op: "delta", id, fields: { content: pick(part, "text", "delta") } });
                            break;
                        }
                        case "reasoning-end": {
                            const id = partBlock.get(part.id);
                            if (id) {
                                const t0 = blockT0.get(id);
                                blockT0.delete(id);
                                yield* seal([
                                    ...(t0 === undefined
                                        ? []
                                        : [{ op: "patch" as const, id, fields: { ms: Date.now() - t0 } }]),
                                    { op: "stop", id },
                                ]);
                            }
                            break;
                        }
                        case "text-start": {
                            markShape(shape, "t");
                            lastAct = "text";
                            const id = `${turnId}_a${++aN}`;
                            partBlock.set(part.id, id);
                            yield* emit({ op: "start", id, kind: "text", parent: stepId, meta: { role: "assistant" } });
                            // L3（##424）：该段正文的 start 行号 = 刚 publish 完的水位
                            assistantTexts.set(id, { seq: opsFeed.watermark(taskUri).seq, text: "" });
                            break;
                        }
                        case "text-delta": {
                            let id = partBlock.get(part.id);
                            if (!id) {
                                id = `${turnId}_a${++aN}`;
                                partBlock.set(part.id, id);
                                yield* ensure(id, "text", stepId, { role: "assistant" });
                            }
                            const chunk = pick(part, "text", "delta");
                            yield* emit({ op: "delta", id, fields: { content: chunk } });
                            // L3（##424）：收全文（**不只最后一条** —— 过程句是用户要的口径）
                            const entry = assistantTexts.get(id) ?? { seq: opsFeed.watermark(taskUri).seq, text: "" };
                            entry.text += chunk;
                            assistantTexts.set(id, entry);
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
                            yield* emit({
                                op: "start",
                                id: part.id,
                                kind: "tool",
                                parent: stepId,
                                meta: { tool: part.toolName, status: "streaming" },
                            });
                            break;
                        case "tool-input-delta": {
                            const tid =
                                (part as { id?: string; toolCallId?: string }).id ??
                                (part as { toolCallId?: string }).toolCallId ??
                                stepId;
                            yield* ensure(tid, "tool", stepId, { tool: "tool", status: "streaming" });
                            partBlock.set(tid, tid);
                            yield* emit({
                                op: "delta",
                                id: tid,
                                fields: {
                                    input: pick(part, "text", "delta", "partialText", "inputTextDelta"),
                                },
                            });
                            break;
                        }
                        case "tool-call": {
                            yield* ensure(part.toolCallId, "tool", stepId, {
                                tool: part.toolName,
                                status: "streaming",
                            });
                            blockT0.set(part.toolCallId, Date.now());
                            const input = (part as { input?: JSONVal }).input;
                            // 模型发的原文之外，再给一份**补完缺省的**实参（##408 用户 2026-10-23）：
                            // 用户看见 `{"command":…}` 会以为 background/timeout 不存在，其实它们
                            // 是代码里补的缺省值 —— 只显示原文等于让界面撒谎。
                            const effArgs = part.toolName === "bash" ? effectiveBashArgs(input) : null;
                            const title =
                                input && typeof input === "object" && !Array.isArray(input) && "command" in input
                                    ? String((input as Record<string, unknown>).command)
                                    : JSON.stringify(input ?? "").slice(0, 120);
                            yield* emit({
                                op: "patch",
                                id: part.toolCallId,
                                fields: {
                                    tool: part.toolName,
                                    input: JSON.stringify(input ?? {}),
                                    args: input ?? null,
                                    ...(effArgs
                                        ? {
                                              execArgs: effArgs.args as unknown as JSONVal,
                                              execDefaults: effArgs.defaulted,
                                          }
                                        : {}),
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
                            const execT0 = blockT0.get(part.toolCallId);
                            blockT0.delete(part.toolCallId);
                            yield* seal([
                                { op: "delta", id: part.toolCallId, fields: { output: outText(part.output) } },
                                {
                                    op: "patch",
                                    id: part.toolCallId,
                                    fields: {
                                        status: "done",
                                        ...(execT0 === undefined ? {} : { ms: Date.now() - execT0 }),
                                    },
                                },
                                { op: "stop", id: part.toolCallId },
                            ]);
                            break;
                        case "tool-error": {
                            const id = (part as { toolCallId?: string }).toolCallId ?? stepId;
                            // 三档判据（##394）：工具失败是**另一条边界**（异常在这里第一次变成"给用户看的东西"）。
                            // 只分类 + 落痕，不改文案与状态语义（文案归 shared/turn-end，铁律 5）。
                            const tv = triageOf((part as { error?: unknown }).error);
                            console.warn(
                                `[local-agent] tool-error triage=${tv.triage} code=${tv.code ?? "-"} ${tv.reason} (${taskUri})`,
                            );
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
                            // 出口落盘（##411）：error part 是上游/流失败**第一次变成给用户看的东西**；
                            // 此前这里只留一条 console.warn，stack 与 code 当场蒸发。用户面文案不变。
                            reportError(err, { where: "agent/llm-error-part", taskUri, model });
                            // 模型不可用的**主路径**（实测：`[model_coming_soon]` 从这里来，不走 catch）
                            reportModelUnavailable(err, taskUri, identity.persona, model, rm.provider);
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
                                // 冷缓存提示（##477）：首步命中率决定 safePoint / failPoint 怎么走
                                // （成功 → gap 进 P90 窗口；≈0 → failPoint 只降不升；灰区不记）
                                const pending = cacheGap.current;
                                if (stepN === 1 && pending) {
                                    cacheHint.noteFirstStepResult({
                                        channel: pending.channel,
                                        gapMs: pending.gapMs,
                                        inputTokens: b.inputTotal,
                                        cacheRead: b.cacheRead,
                                        taskUri,
                                        hinted: pending.hinted,
                                    });
                                }
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
                                // 成本告警（##429 要求 ⑤）：兜底网，**只告警不拦**。
                                // 判据是纯函数；同类每轮只触发一次（同轮第 2、3 步继续贵不再刷屏）。
                                {
                                    const ca = costAlarmsOf(
                                        costState,
                                        cost ? cost.total : null,
                                        turnCost ? turnCost.total : null,
                                        costCfg,
                                        stepN,
                                    );
                                    costState = ca.state;
                                    for (const alarm of ca.alarms) {
                                        this.noteInbox({
                                            level: "N1",
                                            kind: alarm.kind,
                                            taskUri,
                                            text: alarm.text,
                                            source: "agent 成本门槛告警（##429）",
                                            reason: `${alarm.kind === "cost-step" ? "单步" : "单轮"}金额超过阈值（${usdText(alarm.data.thresholdUsd)} USD）`,
                                            detail:
                                                "阈值来源 = limits.json / 环境变量 DIY_LOCAL_COST_WARN_STEP_USD、DIY_LOCAL_COST_WARN_TURN_USD（0 = 关闭）。" +
                                                "这是兜底网：它不拦请求，只告诉你钱花到哪一步了。实际金额与计价依据见会话页脚的用量账。",
                                            data: alarm.data,
                                        });
                                    }
                                }
                                // 自量（##404）：把这一步的桶+金额记进内存账 —— 下一步重建上下文时
                                // `runtime.self` 就有数可报（含跨轮：同一进程里下轮首步仍读得到）。
                                noteSelfStep(taskUri, b, cost);
                                sessionRegistry.noteTurnUsage(taskUri, acc.total);
                                appendUsage(taskUri, {
                                    ts: localISOString(),
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
                                    // 冷缓存等待（##486）：本步真发前等掉的毫秒。缺席 = 没等（正常路径不写 0）
                                    ...(stepWarmWaitMs > 0 ? { waitedMs: stepWarmWaitMs } : {}),
                                    // 投递选择事实**只在轮首**（stepN===1）：一轮只在轮首按当前配置重建投递，
                                    // 后续步复用同一份历史（##272 B1 / ##321）。
                                    ...(stepN === 1 ? { historySelection } : {}),
                                });
                                // 一步一份账：等待的记账只属于这一步，落了账就清零（下一步重新判）
                                stepWarmWaitMs = 0;
                                yield* emit({
                                    op: "patch",
                                    id: turnId,
                                    fields: {
                                        usage: turnUsagePatch(
                                            turnBuckets,
                                            lastStepBuckets,
                                            turnCost,
                                            identity.contextLimit,
                                            stepN,
                                            ctxParts,
                                            lastStepRate,
                                            turnRate,
                                            turnUnpriced,
                                        ),
                                    },
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
                                // ##429 要求 ④：文案要说清「是软上限截的，不是模型不够」+ 给一个不需思考的下一步，
                                // 并把「哪一层定的」写进 endReason（日志/流量页可对账）。
                                notice = `这次回复被输出上限截断（${describeOutputBudget(budget)}），说「继续」可接上`;
                                setEndReason({
                                    type: "max-tokens",
                                    data: { maxOutputTokens: modelMax, layer: budget.layer },
                                });
                                // N1：toast（renderer 订阅信箱）+ **信箱留痕**（落盘，重启后仍可回看）。
                                // 为什么要两处：toast 会消失、老 turn.notice 只在会话页脚（用户不在那页就错过）。
                                this.noteInbox({
                                    level: "N1",
                                    kind: "max-tokens",
                                    taskUri,
                                    text: notice,
                                    source: "agent 输出上限（##429）",
                                    reason: `本轮某个回答撞上了输出上限 ${modelMax}（${budget.layer === "task" ? "任务" : budget.layer === "persona" ? "人物" : budget.layer === "global" ? "全局" : "场景缺省"}定的）`,
                                    detail:
                                        "真发值 = min(软上限, 模型硬上限)：软上限决定“愿意付多少”（任务 frontmatter max_output_tokens > 人物的 maxOutputTokens > " +
                                        "limits.json / DIY_LOCAL_MAX_OUTPUT_TOKENS > 场景缺省 16384）。撞上限后模型并没有说完，发「继续」即可从断点接上。",
                                    data: { maxOutputTokens: modelMax, soft: budget.soft, layer: budget.layer },
                                });
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
                                    fields: {
                                        usage: turnUsagePatch(
                                            turnBuckets,
                                            lastStepBuckets,
                                            turnCost,
                                            identity.contextLimit,
                                            stepN,
                                            ctxParts,
                                            lastStepRate,
                                            turnRate,
                                            turnUnpriced,
                                        ),
                                    },
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
                    // 出口落盘（##411）：这里是「流抛穿」的唯一出口 —— 之前只把 message 塞进 error 块，
                    // stack / code 到此为止。用户面仍只一句话（errorBlock），stack 只进 log/error。
                    reportError(e, { where: "agent/turn-stream", taskUri, model });
                    // ── 「模型不可用」的可见性（##369 ①）──
                    // 判据是 shared/model-unavailable 的**纯函数**（表驱动单测在同名 tests/core）：
                    // 只挑四类（模型未上架 / id 不认识 / 认证失败 / 配额），**上游 5xx 与网络超时不算**
                    // —— 那两类混进来会让 bar 天天亮（告警疲劳），且动作完全不同（该等，不是该配模型）。
                    // 这里只**产生一条事实**给顶栏 bar，不阻断流程：轮次照旧收尾、会话照旧留 error 块。
                    reportModelUnavailable(e, taskUri, identity.persona, model, rm.provider);
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

/**
 * 生产装配（##400 的**唯一一处**）：内核只收一份策略，不认识任务域。
 *
 * 单测两个方向都能钉：
 *   · 直接 `new LocalAgentManager(resolver, fakeGate)` —— 假 gate 全 allow / 全 deny；
 *   · 走本工厂的**缺省参数** —— 拿到的就是生产策略，故「装配忘了注入」会红。
 * 把缺省的 `taskTurnGate` 去掉 ⇒ `turn-gate.test.ts` 里「生产装配缺省 ⇒ done 被拦」必红。
 */
export function createLocalAgent(
    opts: {
        modelResolver?: (id: string, key: string) => LanguageModel;
        turnGate?: TurnGate;
    } = {},
): LocalAgentManager {
    return new LocalAgentManager(opts.modelResolver, opts.turnGate ?? taskTurnGate);
}

/** 单例（api-impl 懒加载，同 getSessionPool 模式） */
let _manager: LocalAgentManager | null = null;
export function getLocalAgent(): LocalAgentManager {
    if (!_manager) _manager = createLocalAgent();
    return _manager;
}

// ─── 后台进程结束 → 插话唤醒（##408 刀 8）─────────────────────────
//
// 用户的原话：「可以放心的停止本轮，等待 job 对 llm 激活，激活可以用**现在显式的消息
// 通知形式插话激活**，简单点。」—— 所以这里**不新造通知通道**，就用既有的插话队列：
//   ① `steerAdd(taskUri, "next-turn", …)`：落进 `.diy/drafts.yaml` 的待投递队列（FIFO）；
//   ② 若此刻**没有轮次在跑**，立刻用队列开一轮（`chatQueued`）——这正是 `agent.local.chat`
//      在 `--mode` 分支里干的事（##303：留言的语义就是"发一句话"，空闲时它本就该马上发出）。
//      没有这一步，结束通知会永远躺在队列里，模型永远醒不过来。
//   ③ 有轮次在跑 ⇒ 什么都不做，那一轮的轮末会把队列整批带走（既有语义）。
//
// 为什么是 `next-turn` 而不是 `next-step`：进程结束时模型通常已经不在当前步了
// （它可能正写报告、也可能已结束本轮），"下一步前插一句"会把别人的步边界打乱；
// 轮是人的/模型的自然停顿点。
runRegistry.setNotifier((event) => {
    wakeTaskWithSteer(event.taskUri, event.text, event.notify);
});

function wakeTaskWithSteer(taskUri: string, text: string, notify?: NotifyItem): void {
    let agent: LocalAgentManager;
    try {
        agent = getLocalAgent();
    } catch (e) {
        console.warn(`[job] 唤醒失败（agent 未就绪）${taskUri}:`, e);
        return;
    }
    try {
        agent.steerAdd(taskUri, "next-turn", text, "job", notify);
    } catch (e) {
        console.warn(`[job] 结束通知入队失败 ${taskUri}:`, e);
        return;
    }
    if (agent.busy(taskUri)) return;
    // 无人消费也要把它跑完：ops 由会话自己落盘，这里只是驱动生成器前进。
    void (async () => {
        try {
            for await (const _op of agent.chatQueued(taskUri)) void _op;
        } catch (e) {
            console.warn(`[job] 空闲唤醒轮次失败（通知仍在队列，下一轮带走）${taskUri}:`, e);
        }
    })();
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
    /** 末条 user 消息的正文（缺省是占位文案；会被包成 `chat: [{from, text}]`） */
    lastUser?: string;
}): Promise<SimulatedRequest> {
    if (!opts.taskUri) {
        return { body: null, note: "无任务场景：仅渲染 system 文本" };
    }
    const taskUri = opts.taskUri;
    // 不传模型 = 按任务当前人物预览：这才是"下一轮真发会用的模型与上下文预算"
    const persona = personaForTask(diyHome(), taskUri);
    const model = opts.model ?? persona.model;
    const cwd = resolveCwdWithNote(diyHome(), taskUri).cwd;
    const L = getLocalAgent().getLimits();
    // 与真发**同一条预算链**（##429）—— 预览必须能看到真正会发出去的 max_tokens，
    // 否则“预览 = 真发”这条不变量就在最容易被拿来核对的那个字段上破了。
    const modelMax = (await getLocalAgent().outputBudgetOf(model, taskUri, "chat")).tokens;
    // 历史：优先用调用方传的；否则从块树现算（与真发同一条投影 —— 含压缩边界与工具裁剪）。
    // 全量下发（不再有截尾上限）：历史已被压缩边界裁过，再截尾会破坏「预览=真发」。
    const hist: HistoryDelivery = opts.messages?.length
        ? { messages: opts.messages }
        : getLocalAgent().deliveryMessages(taskUri);
    // 与真发**逐字同形**：末条 user = 本轮输入 → 外面套**尾部信封**
    // （runtime + user），再合并相邻 user。别各插一条消息 —— 那样合出来是「YAML + 裸文本」，预览会撒谎。
    // thinking 回放归一（##398）也要在预览里跑：否则预览显示「没补 reasoning_content」而真发补了
    // ⇒ 预览撒谎。档位取与真发同源（人物档位 || 模型默认档）。
    const previewRm = findModel(model);
    // 末条 user：与真发同形 —— `chat: [{from, text}]`（已是信封则原样，不嵌套）
    const previewLast = opts.lastUser ?? "[仿真占位]真实下一轮此处为用户输入";
    const lastEnvelope = isEnvelopeText(previewLast)
        ? previewLast
        : chatEnvelope([{ from: HUMAN_MEMBER_ID, text: previewLast }]);
    const messages: ModelMessage[] = ensureReasoningReplay(
        normalizeUserRuns(
            (() => {
                const notice = compactNoticeItem(
                    taskUri,
                    normalizeHistoryLimit(loadAutoCompact(diyHome()).history?.limit).summary.mode,
                    getLocalAgent().effectiveSummary(taskUri),
                );
                return withHeadNotice([...hist.messages, { role: "user" as const, content: lastEnvelope }], notice);
            })(),
        ),
        previewRm
            ? reasoningReplayOptsOf(previewRm, persona.reasoningEffort || reasoningOf(model).default)
            : { thinking: false, deepseek: false },
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
            // 预览的端点按预览模型算（预览不真发，header 只为「预览 = 真发」同形）
            headers: headersFor(previewRm ? resolveBaseUrl(previewRm) : "", { sessionId: sessionIdOf(taskUri) }),
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
