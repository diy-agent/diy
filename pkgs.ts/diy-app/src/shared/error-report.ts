/**
 * error-report.ts — 异常出口的**唯一形状**（纯函数、零 IO；##411）。
 *
 * 病根（##411 实测）：业务链上一条异常从抛到用户只走 `errText()` —— `e.message` 一句话，
 * `stack` / `code` / 现场全部蒸发。`Cannot read properties of undefined` 挡路 5 小时，
 * ops.jsonl 36220 行里**零痕迹**，只能靠人复述现象。
 *
 * 分工（本文件 vs `main/services/error-report.ts`）：
 *   · 这里只做**纯计算**：`errText`（全仓唯一实现）、错误事实抽取、报告形状、限流判据。
 *   · 落盘（`log/error/<date>.jsonl`）在 main 侧 —— 共享层会被 renderer 打包，不许 `node:fs`。
 *
 * 铁律（与 `shared/error-triage` 对齐）：
 *   · `code` 从错误链里**如实读**（`err.code` 原样），拿不到就是 `null`；**不编码**。
 *   · 报告里可以有 stack，**用户面仍只一句话**（stack 外露的判据不在这里，在渲染层）。
 */

import { probeTriage } from "./error-triage";

// ═══════════════════════════════════════════════
//  错误 → 一句话（全仓唯一实现）
// ═══════════════════════════════════════════════

/**
 * 异常取人话。**这是全仓唯一实现** —— 历史上 `local-agent` / `room-service` 各抄一份，
 * 一份只认 `Error`（丢弃「类 Error 但非实例」），一份认 `message` 字段，各自演进必然分叉。
 *
 * 四档回落（覆盖模型 SDK / Node / 跨进程反序列化的混杂现实）：
 *   `Error` → `.message` · 类 Error 对象 → `.message` · 字符串原样 · 其它 `String(e)`。
 */
export function errText(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === "string") return e;
    const o = e as Record<string, unknown> | null;
    if (o && typeof o === "object" && typeof o["message"] === "string") return o["message"];
    return String(e ?? "未知错误");
}

/** 从错误链上读 `code`（Node 的 `ENOSPC` / 本仓的 `agent/invariant-step-seq`）；拿不到 = null */
export function errorCodeOf(e: unknown): string | null {
    // 复用 `error-triage` 的探测（同一份「怎么从 cause / lastError 往下找」的语义），不另写一份
    return probeTriage(e).code;
}

// ═══════════════════════════════════════════════
//  报告形状
// ═══════════════════════════════════════════════

/** 落盘上下文：`where` 必填（定位「哪个出口」），其余自由（taskUri / model / roomId…） */
export interface ErrorReportContext {
    /** 出口标识，形如 `<域>/<方面>`：`room/deliver` · `agent/turn-stream` · `rpc/port-handler` */
    where: string;
    [key: string]: unknown;
}

/** 一行 = 一条异常（`log/error/<date>.jsonl` 的元素） */
export interface ErrorReport {
    /** ISO 时间戳 */
    ts: string;
    /** 错误码（错误链原样；拿不到 = null，**不编**） */
    code: string | null;
    /** 错误类名（`TypeError` / `InvariantError` / 非 Error = `typeof`） */
    name: string;
    /** 一句话（用户面同一句；`errText` 的唯一出口） */
    message: string;
    /** 调用栈（没有 = ""；截断到 {@link MAX_STACK_CHARS}） */
    stack: string;
    /** 出口上下文（`where` 必填） */
    ctx: ErrorReportContext;
}

/** stack 截断上限：足够看出「哪一层」就够，别把整份源码当日志写 */
export const MAX_STACK_CHARS = 8000;

/**
 * 造一条报告。纯函数：`now` 可注入（单测钉时间），不做限流（那是落盘侧的事）。
 *
 * `name` 的取值顺序：`Error.name` → 对象的 `name` 字符串 → `typeof e`。
 */
export function buildErrorReport(e: unknown, ctx: ErrorReportContext, now: Date = new Date()): ErrorReport {
    const o = (typeof e === "object" && e !== null ? e : null) as Record<string, unknown> | null;
    const name =
        e instanceof Error
            ? e.name || "Error"
            : o && typeof o["name"] === "string" && o["name"]
              ? o["name"]
              : typeof e;
    const stack = (e instanceof Error ? e.stack : undefined) ?? (o && typeof o["stack"] === "string" ? o["stack"] : "");
    return {
        ts: now.toISOString(),
        code: errorCodeOf(e),
        name,
        message: errText(e),
        stack: stack.length > MAX_STACK_CHARS ? `${stack.slice(0, MAX_STACK_CHARS)}…[truncated]` : stack,
        ctx,
    };
}

/** 限流键 = `code + message`（同码同话视为同一条，**不含 stack** —— stack 每次都不同） */
export function errorReportKey(r: Pick<ErrorReport, "code" | "message">): string {
    return `${r.code ?? "-"}\u0000${r.message}`;
}

/** 本地日期 `YYYY-MM-DD`（按天切文件；与 `traffic-log.dayFile` 同一口径，但这里不许 import main） */
export function dateKey(d: Date = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

// ═══════════════════════════════════════════════
//  限流（防死循环刷盘 —— 新坑就在这里）
// ═══════════════════════════════════════════════

/** 同一 `code + message` 每分钟最多写几条（超出的只计数不落盘） */
export const DEFAULT_ERROR_LOG_LIMIT_PER_MIN = 10;

/** 键表上限：异常种类无限增长时不能让内存跟着涨（超出淘汰最旧的键） */
const MAX_TRACKED_KEYS = 512;

/**
 * 滑动窗口限流器（纯内存、纯逻辑；时钟可注入，便于单测）。
 *
 * 只回答「这条现在能不能写」；被拒的条数由调用方（main 侧）攒着，用于在恢复时补一条汇总。
 */
export class ErrorRateLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(
        private readonly limit: number = DEFAULT_ERROR_LOG_LIMIT_PER_MIN,
        private readonly windowMs: number = 60_000,
    ) {}

    /** 记一次尝试并判是否放行（放行的那次也计数） */
    allow(key: string, nowMs: number = Date.now()): boolean {
        const from = nowMs - this.windowMs;
        const arr = (this.hits.get(key) ?? []).filter((t) => t > from);
        if (arr.length >= this.limit) {
            // 仍然更新数组（丢掉过期项，避免键里的时间戳越积越多）
            this.hits.set(key, arr);
            return false;
        }
        arr.push(nowMs);
        this.hits.set(key, arr);
        if (this.hits.size > MAX_TRACKED_KEYS) {
            // 淘汰最旧的键（Map 迭代顺序 = 插入顺序；这里近似「最久没被重新插入」）
            const oldest = this.hits.keys().next();
            if (!oldest.done) this.hits.delete(oldest.value);
        }
        return true;
    }

    /** 清空（单测 / 数据根切换用） */
    reset(): void {
        this.hits.clear();
    }
}
