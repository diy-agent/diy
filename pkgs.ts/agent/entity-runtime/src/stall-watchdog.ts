// stall-watchdog.ts —— 上游流停摆的看门狗：**超时就中止，让这一轮有个明确结局**。
//
// 为什么必须有：`runAgent` 到这里是 `for await (const part of result.stream)`，而 ai-sdk 只
// 在**上游给数据**时才前进。上游发到一半静默挂住（网关 / 中间层 / TCP 半开），循环就永远
// 停在那里 —— 唯一的中止来源是 `options.signal`（用户点停止），没人点就永不收尾：
// turn 不结束、`speaking` 不清空、投递卡在 delivering（2026-11-23 实测：一个房间卡了 30 分钟，
// 界面上连停止按钮都没有）。
//
// 三个时段分开计时（判据不同，别用一个数拍平）：
//   · first —— 请求发出到**第一个数据块**（含建连 / 排队 / 上游冷启）；
//   · stream —— 两个数据块之间（正常的 token 间隔）；
//   · tool —— 工具执行期间（**缺省 30 分钟兑底**：`ask` 那种真无界的不计，见 `unboundedTools`）。
//
// 计时逻辑全在这里、定时器可注入：`agent.ts` 只负责接线（哪一刻是 first / stream / tool）。

import type { StallPhase } from '@diy-agent/protocol';

/** 当前处在哪个时段（类型定义在 protocol：`run.failed.stall` 也带它） */
export type { StallPhase };

export interface StallInfo {
    phase: StallPhase;
    /** 这一段等了多久（毫秒） */
    waitedMs: number;
    /** `phase === 'tool'` 时是哪个工具卡住（给 `stallMessage` 用：模型得知道去改哪一步） */
    toolName?: string;
}

export interface StallWatchdogOptions {
    /** 首个数据块之前允许多久；0 = 不设 */
    firstMs: number;
    /** 两个数据块之间允许多久；0 = 不设 */
    idleMs: number;
    /** 工具执行期间允许多久（毫秒）；0 = 不设。**名单内的工具不计**（见 `unboundedTools`） */
    toolMs: number;
    /** 可以等任意久的工具名（缺省 `DEFAULT_UNBOUNDED_TOOLS`）：这些不计入 `toolMs` */
    unboundedTools?: Iterable<string>;
    /** 超时了：调用方在这里 abort（看门狗自己不抛，免得把"中止"变成"异常路径"） */
    onStall: (info: StallInfo) => void;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

/** 缺省时长（毫秒）。取值的理由都在注释里 —— 改之前先想清楚误杀谁。 */
export const DEFAULT_STALL = {
    /** 3 分钟：正常建连 + 冷启远小于它；超过就该说话，而不是让用户对着转圈猜 */
    firstMs: 180_000,
    /** 2 分钟：正常 token 间隔是秒级；2 分钟没有任何数据 = 挂住了 */
    idleMs: 120_000,
    /** 30 分钟：工具**各自有截止**（bash 缺省 300s、`job wait` 10 分钟），正常远小于此；
     *  再长就不是「在跑」而是「没结局」了 —— 2026-11-24 实测 task-mwjddcy0 卡 15 分钟且无任何
     *  超时可察觉，就是这一段缺省 0（不设）造成的。真正无界的工具走 `unboundedTools` 豁免。 */
    toolMs: 1_800_000,
} as const;

/** 可以等任意久的工具：掐它们 = 把功能做废（`ask` 等用户回答，本来就没有截止） */
export const DEFAULT_UNBOUNDED_TOOLS = ['ask'] as const;

function msOf(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 从环境读时长（测试 / 运维都能改，不用改代码）。
 *
 * `DIY2_LLM_STALL_FIRST_MS` / `DIY2_LLM_STALL_IDLE_MS` / `DIY2_LLM_STALL_TOOL_MS`；
 * `0` = 关掉那一段（排障时想复现"永远挂住"就这么用）。
 */
export function stallTimeoutsFromEnv(env: NodeJS.ProcessEnv = process.env): {
    firstMs: number;
    idleMs: number;
    toolMs: number;
} {
    return {
        firstMs: msOf(env, 'DIY2_LLM_STALL_FIRST_MS', DEFAULT_STALL.firstMs),
        idleMs: msOf(env, 'DIY2_LLM_STALL_IDLE_MS', DEFAULT_STALL.idleMs),
        toolMs: msOf(env, 'DIY2_LLM_STALL_TOOL_MS', DEFAULT_STALL.toolMs),
    };
}

/**
 * 豁免名单从环境读（逗号分隔）。**未设置 = 缺省名单；显式给空串 = 没有豁免**（所有工具都计时）。
 *
 * 与 `stallTimeoutsFromEnv` 分开返回：那边的返回值有测试钉着严格相等，往里加字段会炸掉无关断言。
 */
export function unboundedToolsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
    const raw = env['DIY2_LLM_STALL_TOOL_UNBOUNDED'];
    if (raw === undefined) return new Set(DEFAULT_UNBOUNDED_TOOLS);
    return new Set(
        raw
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean),
    );
}

/**
 * 停摆计时器。用法：`start()` → 每个数据块 `touch()` → 工具开始时 `toolStart()` →
 * 收尾 `stop()`（一定要 stop：忘了它，定时器会在下一轮里把别人 abort 掉）。
 */
export class StallWatchdog {
    private handle: unknown;
    private stopped = false;
    private phase: StallPhase = 'first';
    private since = 0;
    private readonly now: () => number;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    /** 可以等任意久的工具（`phase === 'tool'` 时才读） */
    private readonly unbounded: Set<string>;
    /** 当前这一步在跑的工具名（只在 tool 时段有意义） */
    private runningTool: string | undefined;

    constructor(private readonly options: StallWatchdogOptions) {
        this.now = options.now ?? (() => Date.now());
        this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
        this.unbounded = new Set(options.unboundedTools ?? unboundedToolsFromEnv());
    }

    /** 开跑：开始算「首个数据块」 */
    start(): void {
        this.stopped = false;
        this.arm('first', this.options.firstMs);
    }

    /**
     * 任何数据块到达（文本 / 推理 / 工具结果 / 步骤边界）：重新起算。
     * 从 first 或 tool 回到 stream —— 有数据来就说明上游还在（工具结果也算）。
     */
    touch(): void {
        if (this.stopped) return;
        this.arm('stream', this.options.idleMs);
    }

    /**
     * 工具开始执行：之后的等待是**工具**在跑，不是上游在挂。
     *
     * `toolName` 决定这一段**设不设上限**：名单内（`ask` 等无界的）不计；其余用 `toolMs` 兑底 ——
     * 以前这一段缺省不设，于是工具自己永不返回时整轮就没有任何结局（##560 实测卡 15 分钟）。
     */
    toolStart(toolName?: string): void {
        if (this.stopped) return;
        this.runningTool = toolName;
        this.arm('tool', this.unbounded.has(toolName ?? '') ? 0 : this.options.toolMs);
    }

    stop(): void {
        this.stopped = true;
        this.disarm();
    }

    private arm(phase: StallPhase, ms: number): void {
        this.disarm();
        this.phase = phase;
        this.since = this.now();
        if (ms <= 0) return; // 0 = 这段不设上限
        this.handle = this.setTimer(() => {
            if (this.stopped) return;
            this.options.onStall({
                phase,
                waitedMs: this.now() - this.since,
                ...(phase === 'tool' && this.runningTool !== undefined ? { toolName: this.runningTool } : {}),
            });
        }, ms);
    }

    private disarm(): void {
        if (this.handle !== undefined) this.clearTimer(this.handle);
        this.handle = undefined;
    }
}

/** 停摆的人话（进 `run.failed` 的 message：模型和界面都读它） */
export function stallMessage(info: StallInfo): string {
    const phase =
        info.phase === 'first'
            ? '请求发出后一直没有收到任何数据'
            : info.phase === 'tool'
              ? `工具 ${info.toolName ?? '（未知）'} 执行一直没有结束`
              : '上一个数据块之后一直没有新的数据';
    const human =
        info.waitedMs >= 1000 ? `${Math.round(info.waitedMs / 1000)}s` : `${info.waitedMs}ms`;
    return `上游停摆：${phase}（已等 ${human}），本轮已中止 —— 这是超时判定，不是你的操作问题；重发一次即可，反复出现请换模型或检查网关。`;
}
