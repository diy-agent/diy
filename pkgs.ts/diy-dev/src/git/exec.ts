// src/git/exec.ts — git 子进程执行器（流式 / 缓冲两态）
//
// 黑盒根因（190 第六节）：旧 run() 用 spawnSync，命令跑完才一次性吐输出，clone 期间全程黑屏。
// 本文件分两态：
//   - runStreaming：clone / fetch / pull 等长命令。spawn + StringDecoder 增量回调，
//     收到即回调不等命令结束；可选心跳——距「任何输出活动」静默 ≥ heartbeatMs 通知调用方
//     （190 修正 2：判据是输出活动，不是 bytes 增量）。
//     默认不设硬超时（190 第四节：5caf645 加过 clone 180s、8b2ae9e 故意删除，
//     硬超时会误杀大仓库正常 clone）；短网络命令由调用方按需传 timeoutMs。
//   - runBuffered：ls-remote / checkout 等短命令，spawnSync + 可选 timeoutMs。
// 两态统一注入 GIT_TERMINAL_PROMPT=0：stdin 已是 ignore，但 credential helper 仍可能交互挂起。

import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface ExecResult {
    /** 退出码 0 且未超时 */
    ok: boolean;
    /** 退出码；被信号杀死时 null */
    code: number | null;
    stdout: string;
    stderr: string;
    /** 因 timeoutMs 到点被杀 */
    timedOut: boolean;
    /** spawn 级错误（如 ENOENT），无则缺省 */
    error?: string;
}

export interface StreamOpts {
    cwd?: string;
    /** stderr 增量回调（git 进度都在 stderr；chunk 经 StringDecoder 解码、保留原始 \r） */
    onData?: (chunk: string) => void;
    /**
     * 心跳回调：距「任何输出（stdout/stderr）」静默 ≥ heartbeatMs 时触发一次，
     * 之后保持每 heartbeatMs 复查（持续静默则持续触发）。只提示，不杀进程。
     */
    onIdle?: (silentMs: number) => void;
    /** 心跳阈值，缺省 5000ms */
    heartbeatMs?: number;
    /** 硬超时；缺省不设（clone 严禁加，短命令如 fetch 60s 由调用方给） */
    timeoutMs?: number;
    /** 并入子进程环境（可覆盖 PATH 等；GIT_TERMINAL_PROMPT 恒为 0） */
    env?: Record<string, string>;
}

export interface BufferedOpts {
    cwd?: string;
    /** 硬超时（spawnSync timeout，到点 SIGTERM）；缺省不设 */
    timeoutMs?: number;
    env?: Record<string, string>;
}

/** 子进程统一环境：关掉凭证交互（防 credential helper 无声挂起）。 */
export function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    return { ...process.env, ...extra, GIT_TERMINAL_PROMPT: "0" };
}

/**
 * 流式跑一条 git 命令：spawn + StringDecoder，stderr 增量回调 onData（不等命令结束），
 * stdout/stderr 同时全量收集供错误拼装。stdout 活动同样刷新心跳基准（任何输出活动）。
 */
export function runStreaming(args: string[], opts: StreamOpts = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
        const child = spawn("git", args, {
            cwd: opts.cwd,
            env: gitEnv(opts.env),
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let lastActivity = Date.now();
        const decOut = new StringDecoder("utf-8");
        const decErr = new StringDecoder("utf-8");

        // 心跳定时器：按 heartbeatMs 节拍检查静默时长（判据是「任何输出活动」）
        const heartbeatMs = opts.heartbeatMs ?? 5000;
        const hbTimer =
            opts.onIdle && heartbeatMs > 0
                ? setInterval(() => {
                      const silentMs = Date.now() - lastActivity;
                      if (silentMs >= heartbeatMs) opts.onIdle!(silentMs);
                  }, heartbeatMs)
                : null;

        // 硬超时：到点 SIGTERM，3s 宽限后 SIGKILL（默认无超时——clone 严禁加）
        let killTimer: ReturnType<typeof setTimeout> | null = null;
        if (opts.timeoutMs != null && opts.timeoutMs > 0) {
            killTimer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                const force = setTimeout(() => child.kill("SIGKILL"), 3000);
                force.unref();
            }, opts.timeoutMs);
        }

        child.stdout!.on("data", (d: Buffer) => {
            lastActivity = Date.now();
            stdout += decOut.write(d);
        });
        child.stderr!.on("data", (d: Buffer) => {
            lastActivity = Date.now();
            const s = decErr.write(d);
            if (s) {
                stderr += s;
                opts.onData?.(s);
            }
        });

        const settle = (code: number | null): void => {
            if (settled) return;
            settled = true;
            if (hbTimer) clearInterval(hbTimer);
            if (killTimer) clearTimeout(killTimer);
            const tailOut = decOut.end();
            if (tailOut) stdout += tailOut;
            const tailErr = decErr.end();
            if (tailErr) {
                stderr += tailErr;
                opts.onData?.(tailErr);
            }
            resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
        };

        child.on("error", (e) => {
            stderr = stderr ? `${stderr}\n${e.message}` : e.message;
            settle(null);
        });
        child.on("close", (code) => settle(code));
    });
}

/** 缓冲跑一条短命令（spawnSync）：结束后一次性返回，可选 timeoutMs（如 ls-remote 15s）。 */
export function runBuffered(args: string[], opts: BufferedOpts = {}): ExecResult {
    const r = spawnSync("git", args, {
        cwd: opts.cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnv(opts.env),
        timeout: opts.timeoutMs,
    });
    const timedOut =
        r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
        ok: r.status === 0 && !timedOut,
        code: r.status,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        timedOut,
        ...(r.error ? { error: (r.error as Error).message } : {}),
    };
}
