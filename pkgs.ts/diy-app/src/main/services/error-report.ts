// src/main/services/error-report.ts — 异常出口的**落盘侧**（##411）
//
// 分工：形状 / 限流判据在 `shared/error-report`（纯函数）；这里只做 IO。
//
// 落点：`<DIY_HOME>/log/error/<YYYY-MM-DD>.jsonl`（一行一条，append-only，按天切）
//   · 与 `log/network/` 同族口径（`data.log`：等同 cache，可随时清理）
//   · 字段：`{ts, code, name, message, stack, ctx}` —— 用户面仍只一句话，stack 只进这里
//
// 三条硬约束：
//   ① **永不抛**：报告异常的代码自己抛异常 = 把新坑埋进旧坑（调用点都在 catch 里）
//   ② **限流**：同一 `code + message` 每分钟最多 N 条（`DEFAULT_ERROR_LOG_LIMIT_PER_MIN`），
//      否则一次死循环能把盘写满（不是理论：投递失败重试就是循环）
//   ③ **同步写**：catch 之后进程可能立刻死（轮末 / 投递拆链），异步尾巴会丢

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../core/state";
import {
    buildErrorReport,
    ErrorRateLimiter,
    errorReportKey,
    dateKey,
    type ErrorReport,
    type ErrorReportContext,
} from "../../shared/error-report";

/** 相对 DIY_HOME 的目录 */
export const ERROR_LOG_DIR_REL = join("log", "error");

/** 当天文件（绝对路径） */
export function errorLogFile(home: string, now: Date = new Date()): string {
    return join(home, ERROR_LOG_DIR_REL, `${dateKey(now)}.jsonl`);
}

/** 进程级限流器（同进程内所有出口共享 —— 「同一错误」不因出口多而多写一份） */
const limiter = new ErrorRateLimiter();

/** 单测用：清空限流状态 */
export function resetErrorReportLimiter(): void {
    limiter.reset();
}

export interface ReportErrorResult {
    /** 是否真写了一条 */
    written: boolean;
    /** 是否被限流拒掉 */
    suppressed: boolean;
    /** 目标文件（即使没写也给出，便于排障） */
    file: string;
}

export interface ReportErrorOptions {
    /** 数据根（缺省 `diyHome()`；单测注入临时目录） */
    home?: string;
    /** 时间（单测注入） */
    now?: Date;
}

/**
 * 落一条异常报告。**永不抛**（调用点全在 catch 里）。
 *
 * 返回是否写入，便于单测断言限流；调用点通常不看返回值。
 */
export function reportError(e: unknown, ctx: ErrorReportContext, opts: ReportErrorOptions = {}): ReportErrorResult {
    const now = opts.now ?? new Date();
    let home = opts.home;
    if (!home) {
        try {
            home = diyHome();
        } catch {
            // 数据根都拿不到（启动早期）：退化成只打 console，不连累调用方
            console.warn(`[error-report] 拿不到 DIY_HOME，仅输出到 console：${ctx.where}`);
            return { written: false, suppressed: false, file: "" };
        }
    }
    const file = errorLogFile(home, now);
    let report: ErrorReport;
    try {
        report = buildErrorReport(e, ctx, now);
    } catch (buildErr) {
        console.warn(`[error-report] 报告构建失败（${ctx.where}）：${String(buildErr)}`);
        return { written: false, suppressed: false, file };
    }
    if (!limiter.allow(errorReportKey(report), now.getTime())) {
        return { written: false, suppressed: true, file };
    }
    try {
        mkdirSync(join(home, ERROR_LOG_DIR_REL), { recursive: true });
        appendFileSync(file, `${JSON.stringify(report)}\n`, "utf-8");
        return { written: true, suppressed: false, file };
    } catch (writeErr) {
        // 落盘失败（ENOSPC / 目录被删）不能反噬调用方 —— 退到 console，至少留一行
        console.warn(`[error-report] 落盘失败（${ctx.where}）：${String(writeErr)}；原错误：${report.code ?? "-"} ${report.message}`);
        return { written: false, suppressed: false, file };
    }
}
