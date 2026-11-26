// loop-lag.ts —— 事件循环延迟监控 + 同步重活打点。
//
// 为什么要有（2026-11-26 实测）：用户报「页面很慢，点输入框都慢、切聊天也慢」，
// 而**最轻的 `/api/info`**（读一个端口文件、零 SQL）p90 也有 2333ms、max 2780ms。
// 单进程 Node 的事件循环被同步重活卡住时，**所有**请求一起排队 —— 但进程自己毫无感觉：
// 日志里只留下一条压缩的 `durationMs=34133`，看不出那 34 秒里卡在哪、也没人知道
// 平时是不是也在卡。
//
// 两个工具，各管一半：
// · `startLoopLag` —— **自己测**：每 tick 问一次「离上次醒来过了多久」，多出来的就是卡顿。
//   它回答「**现在卡不卡**」。
// · `timed` / `timedAsync` —— 给单个同步重活计时，超过阈值才落一行日志。
//   它回答「**谁卡的**」。不采样、不刷屏：慢就是慢，慢才记。
//
// **为什么不用 Node 内置的 `monitorEventLoopDelay`**（实测 2026-11-26，别再走回头路）：
// 它每 `resolution` 才记一次，而**同步阻塞期间它自己也停摆**，阻塞结束只补记一拍，
// 于是被 `resolution` 封顶 —— 实测卡 80ms 只记到 20ms、卡 **1500ms** 记到 51ms（res=50）
// 甚至 0（res=10）。它测的是「正常运行时的微小抖动」，测不了「被卡死多久」，
// 而我们要的正是后者。自己记 tick 间隔没有这个问题：setInterval 的回调本身就得等 loop 空闲。
//
// 阈值取舍：
// · `warnMs`（lag）默认 500ms —— 100ms 人就有感觉，但那种程度还不值得报警；
//   500ms 已经是「点了没反应」，必须留痕。
// · `slowMs`（单点打点）默认 100ms —— 再低会把正常的首查（冷缓存）也记进来，
//   日志就变成噪音，真正的阻塞点反而被淹掉。

/** 一个汇总窗口内的事件循环延迟（毫秒） */
export interface LoopLagSnapshot {
    /** 窗口内最大延迟 —— 卡顿的直接证据 */
    max: number;
    p99: number;
    p50: number;
    mean: number;
    /** 汇总窗口长度（毫秒） */
    windowMs: number;
    /** 采样时刻（毫秒，Date.now()） */
    at: number;
}

export interface LoopLagOptions {
    /** 采样间隔（默认 1000ms）：每次问「离上次醒来过了多久」 */
    tickMs?: number;
    /** 多少个 tick 汇总一次（默认 10）→ 汇总窗口 = tickMs × ticksPerWindow */
    ticksPerWindow?: number;
    /** 单次卡顿超过它就打一行 WARN（默认 500ms） */
    warnMs?: number;
    /** 每个汇总窗口都回调（`/api/metrics` 读它；日志只在超阈值时打） */
    onSample?: (snapshot: LoopLagSnapshot) => void;
    /** 日志出口（可注入，测试用；默认 console.warn） */
    log?: (line: string) => void;
}

export interface LoopLagMonitor {
    /** 最近一个汇总窗口的快照（还没跑完第一窗时为 undefined） */
    snapshot(): LoopLagSnapshot | undefined;
    /** 停止采样（关进程 / 测试收尾） */
    stop(): void;
}

function summarize(samples: readonly number[], windowMs: number): LoopLagSnapshot {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    const sum = sorted.reduce((acc, n) => acc + n, 0);
    return {
        max: sorted[sorted.length - 1] ?? 0,
        p99: at(0.99),
        p50: at(0.5),
        mean: sorted.length === 0 ? 0 : sum / sorted.length,
        windowMs,
        at: Date.now(),
    };
}

/**
 * 开始监听事件循环延迟。**每进程一个**（监控的是进程，不是某个模块）。
 *
 * 返回的 `stop()` 要在关进程 / 重建时调，否则会留一个不停醒来的采样器。
 */
export function startLoopLag(options: LoopLagOptions = {}): LoopLagMonitor {
    const tickMs = options.tickMs ?? 1000;
    const ticksPerWindow = options.ticksPerWindow ?? 10;
    const warnMs = options.warnMs ?? 500;
    const log = options.log ?? ((line: string) => console.warn(line));
    const windowMs = tickMs * ticksPerWindow;

    let last = performance.now();
    let samples: number[] = [];
    let snapshot: LoopLagSnapshot | undefined;
    let stopped = false;

    const timer = setInterval(() => {
        if (stopped) return;
        const now = performance.now();
        // 实际间隔减去预期间隔 = 这一跳里事件循环被别人占住的时间（正常抖动给 0）
        const lag = Math.max(0, now - last - tickMs);
        last = now;
        samples.push(lag);
        if (lag >= warnMs) {
            log(
                `[diy2:lag] 事件循环卡了 ${Math.round(lag)}ms（tick=${tickMs}ms）` +
                    ` —— 这段时间里所有请求都在排队`,
            );
        }
        if (samples.length >= ticksPerWindow) {
            snapshot = summarize(samples, windowMs);
            samples = [];
            options.onSample?.(snapshot);
        }
    }, tickMs);
    // 采样器不该拖住关进程
    timer.unref?.();

    return {
        snapshot: () => snapshot,
        stop: () => {
            stopped = true;
            clearInterval(timer);
        },
    };
}

/**
 * 慢日志的出口（默认 `console.warn`）。
 *
 * 服务端进程里**不能直接碰 console**（`installAppLog` 之后日志一处写、两处落地，见 ./log），
 * 所以装配时会用 `configureSlowLog` 把它换成 appLog 的 sink；单测不装配，默认值就能用。
 */
let slowLog: (line: string) => void = (line) => console.warn(line);

/** 换掉慢日志出口（只在装配时调一次） */
export function configureSlowLog(sink: (line: string) => void): void {
    slowLog = sink;
}

/** 单点打点：超过 `slowMs` 才落一行（默认 100ms，见文件头的阈值取舍） */
export function timed<T>(label: string, fn: () => T, slowMs = 100): T {
    const started = performance.now();
    try {
        return fn();
    } finally {
        const ms = performance.now() - started;
        if (ms >= slowMs) slowLog(`[diy2:slow] ${label} ${Math.round(ms)}ms`);
    }
}

/** 同 `timed`，包异步函数（await 期间事件循环是空闲的，所以计的是它自己的 CPU/IO 段） */
export async function timedAsync<T>(label: string, fn: () => Promise<T>, slowMs = 100): Promise<T> {
    const started = performance.now();
    try {
        return await fn();
    } finally {
        const ms = performance.now() - started;
        if (ms >= slowMs) slowLog(`[diy2:slow] ${label} ${Math.round(ms)}ms`);
    }
}
