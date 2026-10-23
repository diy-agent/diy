// 🎯 后台进程的**呈现口径**（纯函数，零 IO、零 Electron）—— ##408 刀 8
//
// 为什么单独一层：进程表是**易变活体**（pid / 状态 / 输出），而"人（和模型）怎么读它"
// 是稳定的判据。判据住这里，注册表只管持有与推进状态。两者分开，才能在单测里钉住
// 「死没死怎么说」「多久算多久」「tail 截在哪」而不去真起进程。
//
// 与 v1 的关系（用户 2026-10-23 订正）：
//   · **不做进程恢复**：`$DIY_HOME` 里不留审计账，重启后看见的就是"空"——这是刻意的。
//   · **不做日志管理**：输出只落该进程自己的 `out.log`（它是进程的产物，不是系统主数据）。
//   · 判据仍然只有一条：**能在任何时候回答「它是死是活」**。

/** 进程四态。**不设 `lost`**：没有恢复就没有"不知道"——重启后表是空的，不是 lost。 */
export type ProcState = "running" | "exited" | "killed" | "failed";

export const PROC_TERMINAL_STATES: readonly ProcState[] = ["exited", "killed", "failed"];

/** 终态 = 不会自己再变。`running` 之外都是终态（三态都是"结束了，只是方式不同"）。 */
export function isTerminal(state: ProcState): boolean {
    return PROC_TERMINAL_STATES.includes(state);
}

/**
 * 人话状态。`exited` 不说"成功"——退出码在 `exitText()` 里单列：
 * 「结束了」和「成功了」是两件事，混在一句里，面板就分不出 `exit 1` 与 `exit 0`。
 */
export function stateLabel(state: ProcState): string {
    switch (state) {
        case "running":
            return "运行中";
        case "exited":
            return "已结束";
        case "killed":
            return "已被杀";
        case "failed":
            return "启动失败";
    }
}

/** 时长：<1s 给毫秒，<60s 给一位小数秒，其余 `XmYYs`。传 `undefined`（还在跑且没起算点）给 `—`。 */
export function formatDuration(ms: number | undefined): string {
    if (ms === undefined || Number.isNaN(ms) || ms < 0) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

/**
 * 取了尾 N 行，且**报清楚了少多少**。
 *
 * ⚠️ 只报"截了行"不够：进程输出常常是**超长单行**（进度条、`\r` 刷屏），按行切根本切不动，
 *    所以这里同时有字节上限（`MAX_TAIL_BYTES`），两道上限都要如实回报，否则模型会把
 *    「被截断的一段」当成完整输出。
 */
export const MAX_TAIL_BYTES = 16 * 1024;

export interface TailResult {
    text: string;
    /** 实际给出的行数 */
    lines: number;
    /** 因字节上限被砍掉了后面多少字节（0 = 没有） */
    droppedBytes: number;
}

export function tailOf(raw: string, wantLines: number, maxBytes: number = MAX_TAIL_BYTES): TailResult {
    const cap = maxBytes > 0 ? maxBytes : MAX_TAIL_BYTES;
    let text = raw;
    let droppedBytes = 0;
    if (Buffer.byteLength(text, "utf8") > cap) {
        // 从尾部按字节往回取，再跳过可能落在字符中间的游离续字节（"输出里不许出现 U+FFFD"）
        const buf = Buffer.from(text, "utf8");
        const cut = buf.subarray(buf.length - cap);
        let start = 0;
        while (start < cut.length && (cut[start]! & 0xc0) === 0x80) start += 1;
        droppedBytes = buf.length - (cut.length - start);
        text = cut.subarray(start).toString("utf8");
    }
    const want = wantLines > 0 ? wantLines : 40;
    const rows = text.split("\n");
    // 末尾空串是"文本以换行结尾"的产物，不该算一行，也不该占掉一行配额
    if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    if (rows.length > want) {
        const kept = rows.slice(rows.length - want);
        return { text: kept.join("\n"), lines: kept.length, droppedBytes };
    }
    return { text: rows.join("\n"), lines: rows.length, droppedBytes };
}

/** 退出情况的**唯一**表述：`退出码 0` / `退出码 7` / `信号 SIGKILL` / `（未结束）`。 */
export function exitText(state: ProcState, exitCode?: number | null, signal?: string | null): string {
    if (state === "running") return "（未结束）";
    if (signal) return `信号 ${signal}`;
    if (exitCode === null || exitCode === undefined) return "无退出码";
    return `退出码 ${exitCode}`;
}

/** 最小活体形状（注册表的 `ProcInfo` 满足它；测试不必造整个注册表）。 */
export interface ProcLike {
    id: string;
    command: string;
    state: ProcState;
    startedAt: number;
    endedAt?: number;
    exitCode?: number | null;
    signal?: string | null;
    origin?: { taskUri: string; turnId?: string; stepId?: string; toolCallId?: string };
}

/** 一行花名册（`job list` 的每行）：状态 · id · 时长 · 命令首行 · 来源。 */
export function procLine(p: ProcLike, now: number): string {
    const dur = formatDuration((p.endedAt ?? now) - p.startedAt);
    const head = p.command.split("\n")[0] ?? "";
    const cmd = head.length > 60 ? `${head.slice(0, 57)}…` : head;
    const from = p.origin?.taskUri ? ` ← ${p.origin.taskUri}` : "";
    return `${stateLabel(p.state)} · ${p.id} · ${dur} · ${cmd}${from}`;
}

/**
 * 结束时的**唤醒文案**（投递给发起方会话，让它自己接着干）。
 *
 * 为什么不塞整段输出：这是"插话"，进的是 LLM 上下文，一条任务结束就贴几十 KB 等于
 * 拿上下文换个通知；给**结论 + 尾巴几行**，要全文它自己 `job output`。
 */
export function notifyText(p: ProcLike, tail: TailResult, maxLines = 20): string {
    const dur = formatDuration((p.endedAt ?? p.startedAt) - p.startedAt);
    const head = [
        `[后台进程结束] ${p.id} · ${stateLabel(p.state)} · ${exitText(p.state, p.exitCode, p.signal)} · ${dur}`,
        `命令：${p.command.split("\n")[0] ?? ""}`,
    ];
    if (tail.lines === 0) {
        head.push("（无输出）");
        return head.join("\n");
    }
    const rows = tail.text.split("\n");
    const shown = rows.length > maxLines ? rows.slice(rows.length - maxLines) : rows;
    head.push(
        `输出尾部${shown.length < rows.length ? `（最后 ${shown.length} 行）` : ""}${
            tail.droppedBytes > 0 ? `（前 ${tail.droppedBytes} 字节已截断）` : ""
        }：`,
        "```",
        shown.join("\n"),
        "```",
        "完整输出用 `job output " + p.id + "`。",
    );
    return head.join("\n");
}
