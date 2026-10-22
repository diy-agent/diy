/**
 * error-triage.ts — 「这个异常是哪一档」的**唯一判据**（##394；纯函数、零 IO）。
 *
 * ── 三档（唯一分类轴：**是不是我们已识别的缺陷**）──
 *   · `defect` —— 我方缺陷：**人为界定**的判据被打破（`invariant()` 不成立 / 死锁检测 / 协议校验）。
 *     走修复流程，附 `文件:行` + 现场；**不许吞、不许降级成 unknown**。
 *   · `external-recognized` —— 已识别的外部问题：说得出「啥到上限了」（额度 429 / 磁盘满 ENOSPC /
 *     网络层错误码）。给固定话术 + 处置建议，**不报 issue、不弹裁定**，允许再现。
 *   · `external-unknown` —— 未识别的外部：既不是 defect、也归不进任何已识别类（流中断 / detached /
 *     `error:stream`）。只生成**本地草稿**，人裁定后才升级成 defect / recognized。
 *
 * ── 为什么要这一层（不要在各调用点各判一遍）──
 *   「看着严重就标红」会让缺陷率失真、把用户训练成忽略红色；「我们没识别出来」也**不等于** bug。
 *   故判据只有这一份、边界只有一个出口（`triageOf`），UI / 日志 / issue 三处读同一个结论。
 *
 * ── code 命名约定（UI / 日志 / issue **同一个** code，才能按频次统计「哪类 unknown 最该被识别」）──
 *   `<域>/<kebab-case>`，域 ∈ `llm` / `fs` / `net` / `rpc` / `agent` / `db` / `ui`。
 *   例：`llm/rate-limited` · `fs/disk-full` · `agent/invariant-step-seq`。
 *   未知码（拿不到归一化映射）**原样带回**原始 `err.code` —— 它是事实，改写成编造的码反而丢信息。
 *
 * ── 已识别清单的入场门槛（照 `shared/env-watch.ts::classifyNetworkError` 的精神，别重新发明）──
 *   ① 说得出判据（哪个码 / 哪个 HTTP 状态）；② 说得出「啥到上限了」；③ **拿不到码 ⇒ 无法判定，不猜**。
 *   故 `NETWORK_ERROR_CODES`（连接层失败）算，**HTTP 5xx 与请求超时不算**：上游回了 HTTP 说明网络通着，
 *   那是服务端故障（##369 另一类），混进来会让告警疲劳。
 */

import type { TurnEndReason } from "../main/services/local-blocks";
import { codeOfInterruptedWhy } from "./interrupted-cause";
import { NETWORK_ERROR_CODES, type NetworkErrorCode, probeNetworkError } from "./env-watch";

// ═══════════════════════════════════════════════
//  三档 + 探测
// ═══════════════════════════════════════════════

export type Triage = "defect" | "external-recognized" | "external-unknown";

/** UI 三档的样式键（判据与样式分离：这里只给档位，颜色/图标归渲染层，铁律 5） */
export const TRIAGE_VALUES = ["defect", "external-recognized", "external-unknown"] as const;

export function isTriage(v: unknown): v is Triage {
    return typeof v === "string" && (TRIAGE_VALUES as readonly string[]).includes(v);
}

/** 从异常里能取到的**事实**（各字段可缺：错误链上的形状不止一种） */
export interface TriageProbe {
    /** 错误码（Node `err.code` / 本仓的 `<域>/<kebab>`；拿不到 = null） */
    code: string | null;
    /** 错误消息（压缩空白后截断，给人看） */
    message: string;
    /** 上游 HTTP 状态码（拿不到 = null）—— 与 `code` 是两条独立的证据 */
    httpStatus: number | null;
    /** 错误链上带的 `detail`（本仓 `InvariantError` 的现场；没有 = "") */
    detail: string;
}

/** 探测深度上限：SDK 会把底层错误包在 `cause` / `lastError` / `response` 里 */
const MAX_PROBE_DEPTH = 4;

function asRecord(v: unknown): Record<string, unknown> | null {
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** 从错误对象上读 HTTP 状态码（各 SDK 的键名不统一，三种都认） */
function httpStatusOf(o: Record<string, unknown>): number | null {
    const ok = (v: unknown): v is number => typeof v === "number" && v >= 100 && v <= 599;
    for (const k of ["status", "statusCode", "httpStatus"]) {
        const v = o[k];
        if (ok(v)) return v;
    }
    const resp = asRecord(o["response"]);
    const s = resp?.["status"];
    return ok(s) ? s : null;
}

/**
 * 从任意抛出的值里抽出 {@link TriageProbe}：按名字读 `code` / `message` / `detail` / 状态码，
 * 顺着 `cause` / `lastError` 往下一层找（结构化读取，不依赖具体错误类）。
 *
 * `code` / `message` 复用 `env-watch` 的探测（同一份「怎么从错误链里取事实」的语义），
 * 这里只多读两样：HTTP 状态码与本仓 `InvariantError` 的 `detail`。
 */
export function probeTriage(e: unknown): TriageProbe {
    const net = probeNetworkError(e);
    let httpStatus: number | null = null;
    let detail = "";
    let cur: unknown = e;
    for (let depth = 0; depth < MAX_PROBE_DEPTH && cur != null; depth += 1) {
        const o = asRecord(cur);
        if (!o) break;
        if (httpStatus === null) httpStatus = httpStatusOf(o);
        if (!detail && typeof o["detail"] === "string" && o["detail"]) detail = o["detail"];
        cur = o["cause"] ?? o["lastError"] ?? null;
    }
    return { code: net.code, message: net.message, httpStatus, detail };
}

// ═══════════════════════════════════════════════
//  defect：人为界定的判据（唯一承载物 = invariant）
// ═══════════════════════════════════════════════

/** code 形状：`<域>/<kebab-case>`（域清单见文件头注） */
const CODE_RE = /^(llm|fs|net|rpc|agent|db|ui)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** code 是否符合命名约定（`invariant` 的第一道防线：写错码是编程错误，当场抛） */
export function isErrorCode(code: string): boolean {
    return CODE_RE.test(code);
}

/**
 * 「不变量被打破」—— **唯一**的 defect 承载物（铁律 1：bug 只能由判据认领）。
 *
 * 与 `assert()` 的区别：它的存在本身就是「这是我方缺陷」的声明，`triageOf` 必判 `defect`，
 * 不可能被下游误判成 unknown（那正是「看着严重就标红」的反面：标注了就必须是红的）。
 */
export class InvariantError extends Error {
    /** 归一化 code（`agent/invariant-step-seq` 这类） */
    readonly code: string;
    /** 现场（值 / 步序 / 期望 → 实际），进日志与 issue 草稿 */
    readonly detail: string;
    /** 自带结论：判据随对象走，`triageOf` 不必再猜 */
    readonly triage = "defect" as const;

    constructor(code: string, detail = "") {
        super(detail ? `${code}: ${detail}` : code);
        this.name = "InvariantError";
        this.code = code;
        this.detail = detail;
    }
}

export function isInvariantError(e: unknown): e is InvariantError {
    return e instanceof InvariantError;
}

/**
 * `invariant(cond, code, detail?)` —— cond 不成立就抛 {@link InvariantError}。
 *
 * 只用来表达**人为界定的判据**（协议校验 / 单调性 / 状态机不允许的转移）。
 * **别拿它当参数校验**：用户输入不合法是 `external-*`（预期内的世界），不是我方缺陷。
 */
export function invariant(cond: unknown, code: string, detail?: string): asserts cond {
    if (cond) return;
    if (!isErrorCode(code)) {
        // 写错 code 本身是编程错误：此时再抛 InvariantError 会把「错了的码」也判成 defect，故抛裸错
        throw new Error(`[invariant] 非法 code "${code}"：须形如 <域>/<kebab-case>（域 = llm|fs|net|rpc|agent|db|ui）`);
    }
    throw new InvariantError(code, detail ?? "");
}

// ═══════════════════════════════════════════════
//  external-recognized：已识别清单（v0 只收能说出判据的）
// ═══════════════════════════════════════════════

export interface TriageRule {
    /** 命中后归一化的 code（`<域>/<kebab-case>`） */
    code: string;
    /** 人读理由（**恒非空**：说不清为什么算的，就不该进这张表） */
    reason: string;
    test: (p: TriageProbe) => boolean;
}

/**
 * 网络层错误码 → 归一化 code + 理由。
 *
 * 用 `Record<NetworkErrorCode, …>` 而不是散装字符串：`env-watch` 将来加一个码，
 * 这里**编译期**就会漏（tsc 报缺键），不会静默落进 unknown。
 */
const NETWORK_CODE_LABELS: Record<NetworkErrorCode, { code: string; reason: string }> = {
    ENOTFOUND: { code: "net/dns-not-found", reason: "DNS 解析不到（断网 / DNS 黑洞）" },
    EAI_AGAIN: { code: "net/dns-temporary-failure", reason: "DNS 临时失败（可重试）" },
    ECONNREFUSED: { code: "net/connection-refused", reason: "连接被拒（上游没起 / 端口错）" },
    ENETUNREACH: { code: "net/network-unreachable", reason: "网络不可达（本机到上游的路由断了）" },
    ETIMEDOUT: { code: "net/connect-timeout", reason: "连接超时（对端没在时限内应答）" },
    ECONNRESET: { code: "net/connection-reset", reason: "连接被重置（对端或中间设备掐断）" },
};

/**
 * **已识别的外部问题**表（v0）。顺序即优先级，第一条命中即返回。
 *
 * 入场门槛见文件头注 ①②③ —— **HTTP 5xx / 请求超时不在表里**（上游有响应 ⇒ 网络通着，
 * 那是服务端故障 ##369；混进来会让告警疲劳）。
 */
export const KNOWN_EXTERNAL: readonly TriageRule[] = [
    ...NETWORK_ERROR_CODES.map((c): TriageRule => ({
        code: NETWORK_CODE_LABELS[c].code,
        reason: `${NETWORK_CODE_LABELS[c].reason}（${c}）`,
        test: (p) => p.code === c,
    })),
    {
        code: "fs/disk-full",
        reason: "磁盘满（ENOSPC）：写入方没有空间了，腾空间即可（##384 已单独顶栏告警）",
        test: (p) => p.code === "ENOSPC",
    },
    {
        code: "fs/quota-exceeded",
        reason: "磁盘配额用尽（EDQUOT）：用户/组配额到上限",
        test: (p) => p.code === "EDQUOT",
    },
    {
        code: "llm/rate-limited",
        reason: "上游限流（HTTP 429）：额度/速率到上限，等一会儿或换更便宜的模型",
        test: (p) => p.httpStatus === 429,
    },
    {
        code: "llm/unauthorized",
        reason: "认证失败（HTTP 401）：API key 无效/过期，去模型配置里换",
        test: (p) => p.httpStatus === 401,
    },
    {
        code: "llm/forbidden",
        reason: "无权限（HTTP 403）：key 有效但没这个模型/接口的权限",
        test: (p) => p.httpStatus === 403,
    },
];

// ═══════════════════════════════════════════════
//  triageOf：边界兜底（唯一出口）
// ═══════════════════════════════════════════════

export interface TriageVerdict {
    triage: Triage;
    /** 归一化 code；unknown 且无码 = null（**不编码**：编出来的码会污染频次统计） */
    code: string | null;
    /** 人读理由（**恒非空**，三种情况都说得出为什么） */
    reason: string;
}

/**
 * 判一个异常属于哪一档。**纯函数**：拿得到判据就给结论，拿不到就老实说「无法判定」。
 *
 * 判定顺序（先强证据后弱证据）：
 *   ① {@link InvariantError} ⇒ `defect`（人为界定的判据破了，自带 code）
 *   ② {@link KNOWN_EXTERNAL} 命中 ⇒ `external-recognized`
 *   ③ 既无码也无 HTTP 状态 ⇒ `external-unknown`（**不猜**，理由如实写）
 *   ④ 有码/状态但不在清单里 ⇒ `external-unknown`（原样带回原始码，供统计「哪类最该被识别」）
 */
export function triageOf(err: unknown): TriageVerdict {
    if (isInvariantError(err)) {
        return {
            triage: "defect",
            code: err.code,
            reason: err.detail ? `不变量被打破：${err.code}（${err.detail}）` : `不变量被打破：${err.code}`,
        };
    }
    const probe = probeTriage(err);
    for (const rule of KNOWN_EXTERNAL) {
        if (rule.test(probe)) return { triage: "external-recognized", code: rule.code, reason: rule.reason };
    }
    if (!probe.code && probe.httpStatus === null) {
        return {
            triage: "external-unknown",
            code: null,
            reason: `没有错误码也没有 HTTP 状态：无法判定，归入未识别的外部${probe.message ? `（${probe.message}）` : ""}`,
        };
    }
    const seen = probe.code ?? `HTTP ${probe.httpStatus}`;
    return {
        triage: "external-unknown",
        code: probe.code,
        reason: `${seen} 不在已识别清单里：未识别的外部问题（裁定后可升级为 defect / recognized）`,
    };
}

// ═══════════════════════════════════════════════
//  另一条轴的映射：TurnEndReason → Triage（只映射，不动值域）
// ═══════════════════════════════════════════════

/** 轮末结论：`triage = null` = **预期内**（既不是缺陷也不是外部问题，如正常说完 / 用户点停止） */
export interface TurnEndTriage {
    triage: Triage | null;
    code: string | null;
    reason: string;
}

/**
 * 把既有的 {@link TurnEndReason} 翻成三档（##394 的示范落点之一：**只加映射，不动值域**）。
 *
 * 与 ##393 的 `Blame` 轴的分工：`Blame` 说「谁导致这轮结束」（含 `user` / `none`），
 * `Triage` 只说「要不要当缺陷/外部问题处理」。映射表见任务 body。
 *
 * 判据：
 *   · `max-steps` / `max-tokens` / `error:budget` —— 说得出「啥到上限了」⇒ recognized（限制类）
 *   · `completed` / `aborted:user` / `aborted:abort`(legacy 的用户停止) —— 预期内 ⇒ null
 *     （**不是** external-unknown；判成可疑会把历史「用户点停止」整批灌进裁定池）
 *   · `aborted` 其余来源 / `interrupted` / `error:llm` / `error:stream` —— unknown（不猜是 bug）
 */
export function triageOfTurnEnd(r: TurnEndReason): TurnEndTriage {
    switch (r.type) {
        case "completed":
            return { triage: null, code: null, reason: "模型自然说完：预期收尾" };
        case "max-steps":
            return { triage: "external-recognized", code: "llm/step-limit", reason: `步数到上限（${r.data.limit}）被强制收尾` };
        case "max-tokens":
            return {
                triage: "external-recognized",
                code: "llm/token-limit",
                reason: `输出到上限（${r.data.maxOutputTokens}）被截断`,
            };
        case "aborted": {
            // 「用户点了停止」= 预期收尾，**不是**可疑事件（铁律 2）。两个来源都归这里：
            //   · "user"  —— 现版本 `cancel()` 显式 `abort({source:"user"})`
            //   · "abort" —— legacy：旧版停止按钮**没带 reason**（`shared/turn-end.ts:15-19` 头注原文
            //               「旧记录里用户停止也是 "abort"（当时没带 reason）」），历史数据里是停止的大头。
            //               判成 unknown 会把「正常收尾」整批灌进裁定池 —— 那正是本规范要防的错判。
            // 注意与 `turn-end.ts::abortText` 的**故意不同**：文案对 legacy 只说「被中断（未跑完）」
            // （不冒充用户停止，那时确实分不出）；三档只回答「要不要当事处理」，同样分不出的
            // 情况下前者宁可少断言、后者宁可少报警，两处口径各自成立。
            if (r.data.source === "user" || r.data.source === "abort") {
                return {
                    triage: null,
                    code: null,
                    reason:
                        r.data.source === "user"
                            ? "用户主动停止：预期收尾"
                            : "用户主动停止（legacy 记录：旧版停止按钮未带 reason）：预期收尾",
                };
            }
            const code = r.data.source === "detached" ? "agent/aborted-detached" : "agent/aborted";
            return { triage: "external-unknown", code, reason: `被中断（source=${r.data.source}）：来源无法判定` };
        }
        case "interrupted": {
            // ##416：冷读补 closer 时若现场证据能命名（`why`），就不再灌进 unknown 池 ——
            // 「已识别的不许当 unknown」是 rule.err-triage 的硬口径。**认不出就回落**（SIGKILL / 断电说不出口）。
            const code = codeOfInterruptedWhy(r.data.why);
            if (code === "agent/app-restart") {
                return {
                    triage: "external-recognized",
                    code,
                    reason: `进程收到退出信号后退出/重启（${r.data.why}）：本轮随之中断`,
                };
            }
            if (code === "agent/app-crash") {
                return {
                    triage: "external-recognized",
                    code,
                    reason: `进程异常退出（${r.data.why}）：本轮随之中断`,
                };
            }
            return { triage: "external-unknown", code: "agent/interrupted", reason: "流中断 / 崩溃恢复：未跑完的兜底" };
        }
        case "error": {
            if (r.data.source === "budget") {
                return { triage: "external-recognized", code: "llm/budget-exceeded", reason: "本轮金额/用量预算到上限" };
            }
            // 上下文窗口越线（##406 刀 2）：**已识别** —— 说得出「啥到上限了」（窗口 token / 阈值 / 本轮估算）。
            // 这不是我方缺陷，也不是未知外部：处置话术由调用点给（`local-agent` 的预检分支），
            // 本函数只回答「要不要当事」（##394 判据：说得出上限 ⇒ recognized）。
            if (r.data.source === "context-window") {
                return {
                    triage: "external-recognized",
                    code: "llm/context-window",
                    reason: "上下文超出模型窗口（发请求前预检拦下，未发出）",
                };
            }
            const code = r.data.source === "stream" ? "llm/stream-error" : "llm/error";
            return { triage: "external-unknown", code, reason: `上游/流报错（source=${r.data.source}）：未识别的外部` };
        }
    }
}
