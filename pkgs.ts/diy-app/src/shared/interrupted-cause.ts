// src/shared/interrupted-cause.ts
// 🎯 冷读补 `interrupted` 时**按现场证据**给出可命名的原因（##416）
//
// 病根（##416）：`danglingStopPatches` 冷读补 closer 时只写 `{type:"interrupted", data:{}}`，
// 于是 `triageOfTurnEnd` 只能一律 `external-unknown`（「流中断 / 崩溃恢复」）——**大量可命名的
// 中断灌进 unknown 池**，违反 `rule.err-triage`「已识别的不许当 unknown」，用户也只看到一句
// 无信息量的文案。
//
// 铁律（与 `rule.err-triage` 同轴）：**能命名才命名，查不到就保持 unknown**。SIGKILL / 断电
// 事后说不出（进程连一行都写不了），那时必须仍返回 null —— 不许猜。
//
// 分工：本文件是**纯函数**（窗口内证据 → 原因）；读文件（`log/app-exit.jsonl` / `log/crashes/`）
// 在 `main/services/interrupted-cause.ts`（shared 层会被 renderer 打包，不许 `node:fs`）。

/** `log/app-exit.jsonl` 的一行。写入方：`main/services/crash-reporting.ts::appendExitLog`、
 *  `scripts/electron-dev.mts`（watch 重启路径 —— 它不一定能等到 Electron 自己的 handler 跑完）。 */
export interface AppExitRecord {
    /** ISO 时间戳 */
    ts: string;
    /** 退出原因：`SIGTERM` / `SIGINT` / `SIGHUP` / `uncaughtException` / `unhandledRejection` / `electron-dev-restart` … */
    kind: string;
    pid?: number;
    detail?: string;
    /** 证据文件路径（IO 侧填；纯函数不关心） */
    file?: string;
}

/** `log/crashes/**` 下的一个 minidump（原生崩溃；进程已死，只能靠文件时间落窗口） */
export interface MinidumpRecord {
    path: string;
    mtimeMs: number;
}

/** 一次冷读能拿到的全部现场证据（IO 侧一次读齐，纯函数只做窗口匹配） */
export interface CauseEvidence {
    exits: AppExitRecord[];
    dumps: MinidumpRecord[];
}

/** 可命名的中断 → 归属码（`agent/` 域，与 `rule.err-triage.code` 同形） */
export type InterruptedCode = "agent/app-restart" | "agent/app-crash";

export interface InterruptedCause {
    /** 落 `TurnEndReason.interrupted.data.why`：`app-exit:<kind>` | `crash:minidump` */
    why: string;
    code: InterruptedCode;
    /** 证据（文件路径），只进错误日志，不上用户面 */
    evidence: string;
    /** 证据时间（ms）——多份证据时用来选最新的那条 */
    at: number;
}

/**
 * 信号类退出（进程收到信号后**有序**退出）⇒ 归「进程重启」。
 * `electron-dev-restart` 是 watch 编排脚本自己写的那条（它 kill 旧实例后立刻起新的）。
 */
const RESTART_KINDS = new Set(["SIGTERM", "SIGINT", "SIGHUP", "electron-dev-restart", "electron-dev-stop"]);

/** 异常类退出（进程自己崩）⇒ 归「进程崩溃」 */
const CRASH_KINDS = new Set(["uncaughtException", "unhandledRejection"]);

/**
 * `why` → 归属码。返回 null = **认不出**（未知 kind / 老记录没 why）⇒ 上层必须回落 unknown，不许猜。
 */
export function codeOfInterruptedWhy(why: string | null | undefined): InterruptedCode | null {
    if (!why) return null;
    if (why === "crash:minidump") return "agent/app-crash";
    if (!why.startsWith("app-exit:")) return null;
    const kind = why.slice("app-exit:".length);
    if (RESTART_KINDS.has(kind)) return "agent/app-restart";
    if (CRASH_KINDS.has(kind)) return "agent/app-crash";
    return null;
}

/** 这个 `why` 是否真的能命名（文案 / 归类的统一闸门） */
export function isNamedInterruptedWhy(why: string | null | undefined): boolean {
    return codeOfInterruptedWhy(why) !== null;
}

/**
 * 轮次开始毫秒：`turnId = "t" + Date.now()`（`local-agent.ts` 的 `t${Date.now()}`，
 * 同一内嵌值也被 `durationMs` 复用，故这里是**权威**口径）。
 * 认不出的形态（老数据 / 手写 id）→ null：没有下界就**不判**（窗口无底 = 会把几天前的退出算进来）。
 */
export function turnStartedAtOf(turnId: string): number | null {
    const m = /^t(\d{12,})$/.exec(turnId);
    if (!m) return null;
    const ms = Number(m[1]);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * 在 `[since, until]` 窗口内找一条**可命名**的退出证据，取**最新**的一条。
 *
 * 为什么取最新：窗口是「本轮开始 → 冷读此刻」，中间可能重启过多次（实测一个开口轮挂了 6 天），
 * 最近那次退出才是「这轮为什么没跑完」的直接原因；更早的退出与否都应已经收过尾。
 *
 * 返回 null = 窗口内没有任何可命名证据（SIGKILL / 断电 / 什么都没留下）⇒ 调用方保持 unknown。
 */
export function classifyInterruptedCause(since: number, until: number, ev: CauseEvidence): InterruptedCause | null {
    const inWindow = (t: number): boolean => Number.isFinite(t) && t >= since && t <= until;
    let best: InterruptedCause | null = null;
    const consider = (c: InterruptedCause): void => {
        if (!best || c.at > best.at) best = c;
    };
    for (const d of ev.dumps) {
        if (!inWindow(d.mtimeMs)) continue;
        consider({ why: "crash:minidump", code: "agent/app-crash", evidence: d.path, at: d.mtimeMs });
    }
    for (const r of ev.exits) {
        const at = Date.parse(r.ts);
        if (!inWindow(at)) continue;
        const why = `app-exit:${r.kind}`;
        const code = codeOfInterruptedWhy(why);
        if (!code) continue; // 认不出的 kind ⇒ 不命名（不猜）
        consider({ why, code, evidence: r.file ?? "app-exit.jsonl", at });
    }
    return best;
}
