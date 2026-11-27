// in-process.ts —— 引擎实现之一：在**当前进程**用 Node `vm` 跑模型代码。
//
// 选 `vm.Script#runInContext({ timeout })` 而不是 `eval` / `new Function` 的唯一理由：
// **只有它能杀掉同步死循环**（V8 interrupt）。`Promise.race` 对 `while(true){}` 无效 ——
// 同步代码占着主线程，race 的回调根本没机会跑。
//
// ⚠️ 已知边界（同进程的硬限制，换不了）：
//   1. `vm` 的 timeout **只覆盖 `runInContext` 的同步段**。代码进了 `await` 之后，
//      promise 恢复时已经在 microtask 里，vm 管不到 —— `await x(); while(true){}`
//      会永久卡住事件循环。要杀它只能换 worker / 子进程（`CodeRuntime` 就是为这个留的）。
//   2. 内存**无法限制**（`vm.createContext` 没有 memory limit）。只能靠输出预算 + 超时
//      间接兜住"吐爆内存"的最常见形态。
//   3. `vm` 不是安全边界（`this.constructor.constructor('return process')()` 能拿到 process）。
//      这一层按"自托管 app 不设防"的口径设计：它防误用，不防恶意。

import vm from 'node:vm';

import {
    DEFAULT_LIMITS,
    type CodeRuntime,
    type LogEntry,
    type RunLimits,
    type RunOptions,
    type RunResult,
} from './types.js';

/** 代码体包装成 async 函数：模型可以直接写 `return` / `await`，不必自己套 IIFE */
const WRAP_PREFIX = '(async () => {\n';
const WRAP_SUFFIX = '\n})()';

/** `vm` 超时抛的错码（Node 内部常量，没有公开导出） */
function isTimeoutError(error: unknown): boolean {
    return (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
    );
}

/** 把任意值投影成可序列化的形状；不可序列化的给占位串（不给它漏活对象的机会） */
function projectValue(value: unknown, maxChars: number): unknown {
    if (value === undefined) return undefined;
    const type = typeof value;
    if (type === 'function') return '[unserializable: function]';
    if (type === 'symbol') return '[unserializable: symbol]';
    if (type === 'bigint') return `${String(value)}n`;
    let json: string | undefined;
    try {
        json = JSON.stringify(value);
    } catch {
        // 循环引用 / getter 抛错 / Proxy 陷阱 —— 都归到这里，不让它炸穿引擎
        return `[unserializable: ${type}]`;
    }
    if (json === undefined) return `[unserializable: ${type}]`;
    if (json.length <= maxChars) return JSON.parse(json) as unknown;
    return `${json.slice(0, maxChars)}…[值超 ${String(maxChars)} 字符已截断]`;
}

/**
 * vm 的 context 是**独立 realm**：`setTimeout` / `queueMicrotask` 不会自动存在。
 *
 * 这三个是引擎的基础设施（模型代码天天要 `await sleep(ms)`），所以由引擎注入，
 * 调用方的 `globals` 只放业务东西。定时器一律 `unref` 并记账：模型留一个超长
 * 定时器不该把进程挂住，run 结束时统一清掉。
 */
function createTimers(): { globals: Record<string, unknown>; dispose: () => void } {
    const pending = new Set<NodeJS.Timeout>();
    return {
        globals: {
            setTimeout: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): NodeJS.Timeout => {
                const timer = setTimeout(fn, ms, ...args);
                timer.unref?.();
                pending.add(timer);
                return timer;
            },
            clearTimeout: (timer?: NodeJS.Timeout): void => {
                if (timer !== undefined) pending.delete(timer);
                clearTimeout(timer);
            },
            queueMicrotask,
        },
        dispose: () => {
            for (const timer of pending) clearTimeout(timer);
            pending.clear();
        },
    };
}

/** console 的限量收集器：超预算后**停止收集并留一条说明**（不静默丢） */
function createLogCollector(limits: RunLimits): {
    console: Record<LogEntry['level'], (...args: unknown[]) => void>;
    drain: () => LogEntry[];
    readonly truncated: boolean;
} {
    const logs: LogEntry[] = [];
    let bytes = 0;
    let truncated = false;
    const push = (level: LogEntry['level']) => {
        return (...args: unknown[]): void => {
            if (truncated) return;
            const text = args
                .map((arg) => {
                    if (typeof arg === 'string') return arg;
                    try {
                        return JSON.stringify(arg) ?? String(arg);
                    } catch {
                        return '[unserializable]';
                    }
                })
                .join(' ')
                .slice(0, limits.logChars);
            const size = Buffer.byteLength(text, 'utf8');
            if (bytes + size > limits.logBytes) {
                truncated = true;
                logs.push({ level: 'warn', text: `[输出超 ${String(limits.logBytes)} 字节预算，后续日志已丢弃]` });
                return;
            }
            bytes += size;
            logs.push({ level, text });
        };
    };
    return {
        console: {
            log: push('log'),
            info: push('info'),
            warn: push('warn'),
            error: push('error'),
            debug: push('debug'),
        },
        drain: () => logs,
        get truncated() {
            return truncated;
        },
    };
}

/**
 * 进程内 `vm` 引擎。
 *
 * 快（无进程/线程启动成本）、能直传活对象（typed RPC client 的 Proxy 可以直接注入）；
 * 代价是**杀不掉 `await` 之后的死循环**、限不了内存 —— 见文件头的已知边界。
 */
export class InProcessVmRuntime implements CodeRuntime {
    readonly name = 'in-process-vm';

    constructor(private readonly limits: RunLimits = DEFAULT_LIMITS) {}

    async run(code: string, opts: RunOptions): Promise<RunResult> {
        const started = performance.now();
        const elapsed = (): number => Math.round(performance.now() - started);
        const collector = createLogCollector(this.limits);
        const timers = createTimers();
        /** 所有出口都过这里：清定时器 + 保证 `durationMs` 是收尾那一刻的值 */
        const finish = (result: Omit<RunResult, 'durationMs'>): RunResult => {
            timers.dispose();
            return { ...result, durationMs: elapsed() };
        };
        // 定时器由引擎注入；`console` 由引擎**覆盖**（调用方传的同名键不算数）
        const sandbox: Record<string, unknown> = { ...timers.globals, ...opts.globals, console: collector.console };
        const context = vm.createContext(sandbox);
        const script = new vm.Script(WRAP_PREFIX + code + WRAP_SUFFIX, { filename: 'run_code.js' });

        if (opts.signal?.aborted === true) {
            return finish({ value: undefined, logs: [], truncated: false, outcome: 'aborted' });
        }

        // ── 同步段：vm 的 timeout 在这里有效（能杀 while(true)）──
        let promise: Promise<unknown>;
        try {
            // 0 = 不设超时（调度方显式要求）；vm 只吃正数，传 0 会被当成"立刻超时"
            promise = (
                opts.timeoutMs > 0
                    ? script.runInContext(context, { timeout: opts.timeoutMs })
                    : script.runInContext(context)
            ) as Promise<unknown>;
        } catch (error) {
            const timedOut = isTimeoutError(error);
            return finish({
                value: timedOut ? undefined : `[引擎错误] ${describeError(error)}`,
                logs: collector.drain(),
                truncated: collector.truncated,
                outcome: timedOut ? 'timeout' : 'error',
            });
        }

        // ── 异步段：race 只能放弃等待，**杀不掉**还在跑的代码（见文件头边界 1）──
        const outcome = await raceWithTimeout(promise, opts.timeoutMs, opts.signal);
        if (outcome.kind === 'timeout') {
            return finish({
                value: undefined,
                logs: collector.drain(),
                truncated: collector.truncated,
                outcome: 'timeout',
            });
        }
        if (outcome.kind === 'aborted') {
            return finish({
                value: undefined,
                logs: collector.drain(),
                truncated: collector.truncated,
                outcome: 'aborted',
            });
        }
        if (outcome.kind === 'error') {
            return finish({
                value: `[引擎错误] ${describeError(outcome.error)}`,
                logs: collector.drain(),
                truncated: collector.truncated,
                outcome: 'error',
            });
        }
        return finish({
            value: projectValue(outcome.value, this.limits.valueChars),
            logs: collector.drain(),
            truncated: collector.truncated,
            outcome: 'ok',
        });
    }
}

type RaceOutcome =
    | { kind: 'ok'; value: unknown }
    | { kind: 'timeout' }
    | { kind: 'aborted' }
    | { kind: 'error'; error: unknown };

function raceWithTimeout(
    promise: Promise<unknown>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
): Promise<RaceOutcome> {
    return new Promise<RaceOutcome>((resolve) => {
        let settled = false;
        const done = (result: RaceOutcome): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const onAbort = (): void => done({ kind: 'aborted' });
        const timer = timeoutMs > 0 ? setTimeout(() => done({ kind: 'timeout' }), timeoutMs) : undefined;
        if (timer !== undefined) timer.unref?.();
        signal?.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => done({ kind: 'ok', value }),
            (error: unknown) => done({ kind: 'error', error }),
        );
    });
}

function describeError(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
}
