// fanout.ts — 多目标扇出：**逐项结果** + **执行回执**。这里不出“部分成功”这种判定。
//
// 两条轴（见 docs/02-wire.md）：
//   - 执行轴：哪个 target 答了 / 没答（`FanoutReceipt`）→ 进帧的 `meta.fanout`，给重试与可观测性；
//   - 业务轴：答了的那台机器/那个成员是什么状态（`data.items[i].state`）→ 由 kind 的 `aggregate` 自己写。
//
// runtime **不判**“算不算部分失败” —— 它不知道“一项”是什么。它只保证两件事：
//   1. 每个 target 都有回执（成功有值，失败有 code）；
//   2. 全部失败 = 一条答案都没拿到 = `err`（帧上不会出现“部分”这种 tag）。
//
// `mapEach` 强制两个分支都写：拿到值的走 onAnswered，没拿到的走 onUnanswered。
// 想「读不到就当没有」在这一层写不出来 —— 这是 docs/07-naming-ledger.md A2 那个 bug 的长效防护。

import type { ActorCode } from './errors.js';
import type { FanoutReceipt, Target } from './wire.js';

/** 一个 target 的结果：要么有值，要么有“为什么没有” */
export type PerTarget<T = unknown> =
    | { readonly target: Target; readonly answered: true; readonly value: T }
    | { readonly target: Target; readonly answered: false; readonly code: ActorCode; readonly message: string };

/**
 * 扇出端口：runtime 只认这个接口，不认识任何传输。
 * 进程内实现直接调本地 actor；跨节点由调用方接 ws/http（**不依赖 @diy-agent/rpc**）。
 */
export interface FanoutPort {
    query(args: {
        target: string;
        name: string;
        data: unknown;
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<unknown>;
}

export interface RunFanoutArgs {
    targets: readonly Target[];
    /** 在 target 上执行的方法名（target 侧必须声明了同名 query） */
    name: string;
    data: unknown;
    port: FanoutPort;
    timeoutMs?: number;
    signal?: AbortSignal;
    now?: () => number;
}

export interface RunFanoutResult {
    results: PerTarget[];
    receipts: FanoutReceipt[];
}

/**
 * 并发问 N 个 target。**永不抛**：单个 target 的任何失败都变成一条 `answered: false`。
 * 是否升级为整体失败由 runtime 判（全败 → `err E_UNAVAILABLE`）。
 */
export async function runFanout(args: RunFanoutArgs): Promise<RunFanoutResult> {
    const now = args.now ?? (() => Date.now());
    const settled = await Promise.all(
        args.targets.map(async (target) => {
            const started = now();
            try {
                const value = await withTimeout(
                    Promise.resolve(
                        args.port.query({
                            target: target.target,
                            name: args.name,
                            data: args.data,
                            timeoutMs: args.timeoutMs,
                            signal: args.signal,
                        }),
                    ),
                    args.timeoutMs,
                );
                return {
                    result: { target, answered: true, value } as PerTarget,
                    receipt: { target: target.target, ok: true, ms: Math.max(0, now() - started) } as FanoutReceipt,
                };
            } catch (err) {
                const { code, message } = classify(err);
                return {
                    result: { target, answered: false, code, message } as PerTarget,
                    receipt: {
                        target: target.target,
                        ok: false,
                        code,
                        ms: Math.max(0, now() - started),
                    } as FanoutReceipt,
                };
            }
        }),
    );
    return { results: settled.map((s) => s.result), receipts: settled.map((s) => s.receipt) };
}

/**
 * 逐项映射：**两个分支都必须给**。返回数组与 results 等长同序，
 * 所以「某个 target 读不到」在业务数据里一定有它自己的一项，不可能静默丢。
 */
export function mapEach<T, R>(
    results: readonly PerTarget<T>[],
    onAnswered: (value: T, target: Target) => R,
    onUnanswered: (code: ActorCode, message: string, target: Target) => R,
): R[] {
    return results.map((r) => (r.answered ? onAnswered(r.value, r.target) : onUnanswered(r.code, r.message, r.target)));
}

/** 全败 = 一条答案都没拿到。runtime 用它决定「`ok` 还是 `err`」 */
export function allFailed(results: readonly PerTarget[]): boolean {
    return results.length > 0 && results.every((r) => !r.answered);
}

/** 把任意异常归一成执行轴 code（扇出里没有“业务异常”，只有“没拿到”） */
function classify(err: unknown): { code: ActorCode; message: string } {
    const withCode = err as { code?: unknown; message?: unknown };
    const code =
        typeof withCode?.code === 'string' && withCode.code.startsWith('E_')
            ? (withCode.code as ActorCode)
            : 'E_UNAVAILABLE';
    const message = typeof withCode?.message === 'string' ? withCode.message : String(err);
    return { code, message };
}

/** 超时只在“没拿到答案”这一侧加限制，不取消别的 target */
function withTimeout<T>(p: Promise<T>, timeoutMs?: number): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(Object.assign(new Error(`target 超时 ${timeoutMs}ms`), { code: 'E_TIMEOUT' })),
            timeoutMs,
        );
    });
    return Promise.race([p, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}
