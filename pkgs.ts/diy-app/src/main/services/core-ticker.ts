// src/main/services/core-ticker.ts
// 🎯 **唯一**的一拍源（##408 v2）：60s 一个 tick，watch / 巡检都挂它。
//
// 判据全在 `shared/tick.ts`（纯函数 + 表驱动单测）；本文件只做四件事：
//   ① 持有 `setInterval`（全仓 job 域唯一一处新增的 interval）
//   ② 订阅表：`subscribe(name, fn)`，首个订阅者到来才 start、最后一个走就 stop
//      （没人订就**一个 timer 都不存在** —— 空转的定时器是纯电费）
//   ③ 单飞：`TickGate` 说这拍 busy 就直接丢，不排队
//   ④ 错误隔离：一个订阅者炸了，其余照跑；错误计进它自己的 `failures`
//
// 为什么不复用 `env-watch` 的 poller：那个是「磁盘水位专用、条件持续存在」的模型，
// 且早于本文件（30s）。job 域要的是「多住户共享一个相位」，语义不同，合并会让
// 两个东西互相等（见 `shared/tick.ts` 头注）。
//
// 定时器 `unref()`：后台一拍不该成为「进程退不掉」的理由。

import { TICK_MS, TickGate } from "../../shared/tick";
import type { TickDecision, TickStats } from "../../shared/tick";

/** 一拍里给订阅者的上下文。`seq` 从 1 起，跳过拍不占号。 */
export interface TickContext {
    readonly seq: number;
    readonly at: number;
}

export type TickHandler = (ctx: TickContext) => void | Promise<void>;

/** 订阅者的可观测面（排查「定时器到底跑没跑」）。 */
export interface TickHandlerStats {
    readonly name: string;
    /** 跑过几拍 */
    readonly runs: number;
    /** 因为它自己上一拍没完而跳过的拍数 */
    readonly skipped: number;
    /** 抛过错几次（`lastError` 是最近一条） */
    readonly failures: number;
    readonly lastError: string | null;
    readonly lastRunAt: number | null;
}

interface Entry {
    readonly fn: TickHandler;
    readonly name: string;
    busy: boolean;
    runs: number;
    skipped: number;
    failures: number;
    lastError: string | null;
    lastRunAt: number | null;
}

export interface CoreTickerOptions {
    now?: () => number;
    intervalMs?: number;
    setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
    clearTimer?: (t: NodeJS.Timeout) => void;
}

/** 一次 `tick()` 的结论（给测试与 `diy job metrics` 用）。 */
export interface TickReport extends TickStats {
    readonly ran: boolean;
    readonly at: number;
    readonly handlers: number;
}

export class CoreTicker {
    private readonly now: () => number;
    private readonly intervalMs: number;
    private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
    private readonly clearTimer: (t: NodeJS.Timeout) => void;

    private readonly gate = new TickGate();
    private readonly entries = new Map<string, Entry>();
    private timer: NodeJS.Timeout | null = null;

    constructor(opts: CoreTickerOptions = {}) {
        this.now = opts.now ?? (() => Date.now());
        this.intervalMs = opts.intervalMs ?? TICK_MS;
        this.setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
        this.clearTimer = opts.clearTimer ?? ((t) => clearInterval(t));
    }

    /**
     * 挂一个住户。同名重复订阅 = 替换（不是两条 —— 两条会让同一件事一拍跑两遍）。
     * 返回退订函数（幂等）。
     */
    subscribe(name: string, fn: TickHandler): () => void {
        this.entries.set(name, {
            fn,
            name,
            busy: false,
            runs: 0,
            skipped: 0,
            failures: 0,
            lastError: null,
            lastRunAt: null,
        });
        this.start();
        let off = false;
        return () => {
            if (off) return;
            off = true;
            this.entries.delete(name);
            if (this.entries.size === 0) this.stop();
        };
    }

    /** 起表（幂等）。订阅已自动调它；手动调只为「先起再订」的接缝。 */
    start(): void {
        if (this.timer) return;
        this.timer = this.setTimer(() => void this.tick(), this.intervalMs);
        // 后台定时器不该吊住进程退出（Electron 主进程里其实无所谓，测试里很关键）
        this.timer.unref?.();
    }

    /** 停表（幂等）。**不**清订阅：下次 start 会继续用。 */
    stop(): void {
        if (this.timer) this.clearTimer(this.timer);
        this.timer = null;
    }

    isRunning(): boolean {
        return this.timer !== null;
    }

    /**
     * 跑一拍。可被测试直接调（不真等 60s）。
     *
     * 单飞的粒度是**整拍**：任一订阅者没跑完，这一拍整体跳过（`gate` 在
     * 订阅者全部 settle 之后才 `end()`）。理由：拍的语义是「同一时刻看同一眼世界」，
     * 让快住户跑去赶下一拍、慢住户还在上一拍，等于相位又散了。
     */
    async tick(at: number = this.now()): Promise<TickReport> {
        const decision: TickDecision = this.gate.begin(at);
        if (!decision.ran) {
            return {
                ran: false,
                at,
                handlers: this.entries.size,
                ...this.gate.stats(),
            };
        }

        const ctx: TickContext = { seq: decision.seq, at };
        const pending: Promise<void>[] = [];
        try {
            for (const entry of this.entries.values()) {
                // 住户自己的上一拍还没完：丢它这一拍，不排队（与整拍单飞同一原则）
                if (entry.busy) {
                    entry.skipped += 1;
                    continue;
                }
                entry.busy = true;
                pending.push(this.runEntry(entry, ctx));
            }
            await Promise.all(pending);
        } finally {
            this.gate.end();
        }

        return {
            ran: true,
            at,
            handlers: this.entries.size,
            ...this.gate.stats(),
        };
    }

    private async runEntry(entry: Entry, ctx: TickContext): Promise<void> {
        try {
            await entry.fn(ctx);
            entry.runs += 1;
            entry.lastRunAt = ctx.at;
        } catch (e) {
            entry.failures += 1;
            entry.lastError = e instanceof Error ? e.message : String(e);
            // 只记一句：定时器里每个失败都打栈会把日志淹掉，真相在 `lastError`
            console.warn(`[core-ticker] 订阅者 ${entry.name} 失败:`, entry.lastError);
        } finally {
            entry.busy = false;
        }
    }

    stats(): { tick: TickStats; handlers: TickHandlerStats[]; running: boolean } {
        return {
            tick: this.gate.stats(),
            running: this.isRunning(),
            handlers: [...this.entries.values()].map((e) => ({
                name: e.name,
                runs: e.runs,
                skipped: e.skipped,
                failures: e.failures,
                lastError: e.lastError,
                lastRunAt: e.lastRunAt,
            })),
        };
    }

    /** 测试专用：清订阅 + 停表 + 清零计数。 */
    reset(): void {
        this.stop();
        this.entries.clear();
        this.gate.reset();
    }
}

/**
 * 进程级单例。**不要 new 第二个** —— 两个 ticker = 两条相位，正是本文件要消灭的东西。
 */
export const coreTicker = new CoreTicker();
