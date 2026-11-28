// loop-lag.ts —— 事件循环延迟监控 + 同步重活打点。
//
// 为什么要有（2026-11-26 实测）：用户报「页面很慢，点输入框都慢、切聊天也慢」，
// 而**最轻的 `/api/info`**（读一个端口文件、零 SQL）p90 也有 2333ms、max 2780ms。
// 单进程 Node 的事件循环被同步重活卡住时，**所有**请求一起排队 —— 但进程自己毫无感觉：
// 日志里只留下一条压缩的 `durationMs=34133`，看不出那 34 秒里卡在哪、也没人知道
// 平时是不是也在卡。
//
// 三个工具，各管一半：
// · `startLoopLag` —— **自己测**：每 tick 问一次「离上次醒来过了多久」，多出来的就是卡顿。
//   它回答「**现在卡不卡**」。
// · `timed` / `timedAsync` —— 给单个同步重活计时，超过阈值才落一行日志。
//   它回答「**谁卡的**」。不采样、不刷屏：慢就是慢，慢才记。
// · 卡顿那一跳同时记 `cpuRatio` / `load1`（2026-11-28）：**同一句「卡了 78s」可能是两件事** ——
//   进程自己吃满 CPU（热栈在跑），或 8 核机器 load 42 把本进程饿死（自己什么都没干）。
//   判据：`cpuRatio` = 这一 tick 里 CPU 时间 / 墙钟时间；≥0.5 是自己算，≈0 是没抢到调度。
//   自己算的那一类交给 `./profile-watch` 落 CPU profile，否则日志只会说「所有请求在排队」。
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

import { cpus, loadavg } from 'node:os';

import { recordDuration } from './metrics-registry';

/** 采样时刻的机器状态（回答「是不是本进程的锅」） */
export interface SystemSnapshot {
    load1: number;
    load5: number;
    load15: number;
    /** 逻辑核数（load1 要除以它才有意义） */
    cpus: number;
    /** 进程 RSS（MB） */
    rssMb: number;
}

/** 一个汇总窗口内的事件循环延迟（毫秒） */
export interface LoopLagSnapshot {
    /** 窗口内最大延迟 —— 卡顿的直接证据 */
    max: number;
    p99: number;
    p50: number;
    mean: number;
    /** 窗口内平均 CPU 占比（0~1）：接近 1 = 本进程在算；接近 0 = 被系统饿死 / 在等 IO */
    cpuRatio: number;
    /** 汇总窗口长度（毫秒） */
    windowMs: number;
    /** 采样时刻（毫秒，Date.now()） */
    at: number;
    /** 采样时刻的机器状态 */
    system: SystemSnapshot;
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
    /** 每次超阈值卡顿都回调（装配层用它喂 CPU profiler，见 ./profile-watch） */
    onLag?: (lagMs: number, meta: { cpuRatio: number; load1: number; cpus: number; at: number }) => void;
    /** 日志出口（可注入，测试用；默认 console.warn） */
    log?: (line: string) => void;
}

/** 进程启动以来的累计值（Prometheus counter 用；窗口快照会重置，这两个不会） */
export interface LoopLagCounters {
    /** 累计“卡住”的秒数，按性质分 */
    readonly blockedSeconds: { readonly self: number; readonly starved: number };
    /** 累计卡顿次数（只算超过 warnMs 的） */
    readonly stalls: { readonly self: number; readonly starved: number };
}

export interface LoopLagMonitor {
    /** 最近一个汇总窗口的快照（还没跑完第一窗时为 undefined） */
    snapshot(): LoopLagSnapshot | undefined;
    /** 进程启动以来的累计计数（只增不减，直接给 Prometheus counter） */
    counters(): LoopLagCounters;
    /** 停止采样（关进程 / 测试收尾） */
    stop(): void;
}

function systemSnapshot(): SystemSnapshot {
    const [load1, load5, load15] = loadavg();
    return {
        load1: load1 ?? 0,
        load5: load5 ?? 0,
        load15: load15 ?? 0,
        cpus: ncpu(),
        rssMb: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10,
    };
}

function summarize(
    samples: readonly number[],
    cpuRatios: readonly number[],
    windowMs: number,
    system: SystemSnapshot,
): LoopLagSnapshot {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    const sum = sorted.reduce((acc, n) => acc + n, 0);
    const cpuSum = cpuRatios.reduce((acc, n) => acc + n, 0);
    return {
        max: sorted[sorted.length - 1] ?? 0,
        p99: at(0.99),
        p50: at(0.5),
        mean: sorted.length === 0 ? 0 : sum / sorted.length,
        cpuRatio: cpuRatios.length === 0 ? 0 : cpuSum / cpuRatios.length,
        windowMs,
        at: Date.now(),
        system,
    };
}

/** 逻辑核数（取一次就够；容器里 cpus() 偶尔为空，兜底 1） */
let cachedNcpu: number | undefined;
function ncpu(): number {
    cachedNcpu ??= Math.max(1, cpus().length);
    return cachedNcpu;
}

/** 卡顿那一行的后半句：机器可读属性 + 人可读判词（两条路都留，grep 与肉眼都好使） */
function lagLine(lagMs: number, tickMs: number, cpuRatio: number, system: SystemSnapshot): string {
    const head = `[diy2:lag] 事件循环卡了 ${Math.round(lagMs)}ms（tick=${tickMs}ms）`;
    const facts =
        ` lagMs=${Math.round(lagMs)}` +
        ` cpuRatio=${(cpuRatio * 100).toFixed(0)}%` +
        ` load1=${system.load1.toFixed(1)}` +
        ` ncpu=${system.cpus}` +
        ` rssMb=${system.rssMb}`;
    const verdict =
        cpuRatio >= 0.5
            ? ' —— 本进程在吃 CPU，卡点看 profile / 慢点日志'
            : ' —— 本进程没抢到 CPU：机器负载 / IO 饥饿，不是单点代码卡住';
    return `${head}${facts}${verdict}`;
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
    let lastCpu = process.cpuUsage();
    let lastCpuAt = last;
    let samples: number[] = [];
    let cpuRatios: number[] = [];
    let snapshot: LoopLagSnapshot | undefined;
    let stopped = false;
    const blocked = { self: 0, starved: 0 };
    const stalls = { self: 0, starved: 0 };

    const timer = setInterval(() => {
        if (stopped) return;
        const now = performance.now();
        // 这一 tick 的 CPU 占比：CPU 时间（微秒）/ 墙钟时间（微秒）。
        // 被系统饿死时两者会明显分离（进程整段时间只跑了很少一点），这正是「卡了 78 秒
        // 但代码没有一行是重活」的指纹；自己算满时接近 1。多线程（GC worker）可能 >1，夹到 1。
        const cpu = process.cpuUsage();
        const cpuDeltaUs = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
        const wallUs = Math.max(1, (now - lastCpuAt) * 1000);
        const cpuRatio = Math.min(1, Math.max(0, cpuDeltaUs / wallUs));
        lastCpu = cpu;
        lastCpuAt = now;

        // 实际间隔减去预期间隔 = 这一跳里事件循环被别人占住的时间（正常抖动给 0）
        const lag = Math.max(0, now - last - tickMs);
        last = now;
        const system = systemSnapshot();
        samples.push(lag);
        cpuRatios.push(cpuRatio);
        if (lag >= warnMs) {
            const verdict = cpuRatio >= 0.5 ? 'self' : 'starved';
            blocked[verdict] += lag / 1000;
            stalls[verdict] += 1;
            log(lagLine(lag, tickMs, cpuRatio, system));
            options.onLag?.(lag, {
                cpuRatio,
                load1: system.load1,
                cpus: system.cpus,
                at: Date.now(),
            });
        }
        if (samples.length >= ticksPerWindow) {
            snapshot = summarize(samples, cpuRatios, windowMs, system);
            samples = [];
            cpuRatios = [];
            options.onSample?.(snapshot);
        }
    }, tickMs);
    // 采样器不该拖住关进程
    timer.unref?.();

    return {
        snapshot: () => snapshot,
        counters: () => ({
            blockedSeconds: { self: blocked.self, starved: blocked.starved },
            stalls: { self: stalls.self, starved: stalls.starved },
        }),
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

/**
 * 单点打点：超过 `slowMs` 才落一行慢日志（默认 100ms，见文件头的阈值取舍）。
 * 但**全量**记进 op histogram —— 直方图要全样本才能算 p50/p99，慢日志只负责「哪一次、多慢」。
 * 两者互补（规格见 observability 计划 §4.5）。
 */
export function timed<T>(label: string, fn: () => T, slowMs = 100): T {
    const started = performance.now();
    try {
        return fn();
    } finally {
        const ms = performance.now() - started;
        recordDuration('diy2_op_duration_seconds', [label], ms / 1000);
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
        recordDuration('diy2_op_duration_seconds', [label], ms / 1000);
        if (ms >= slowMs) slowLog(`[diy2:slow] ${label} ${Math.round(ms)}ms`);
    }
}
