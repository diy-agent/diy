// types.ts —— 执行引擎的**契约**（策略化的那个"不变面"）。
//
// 为什么要这一层：引擎今天跑在 main 进程（`vm`），明天可能要换子进程 / worker
// 才能限制内存或杀掉死循环 —— 但**注入给模型的东西不能变**（`globals` 的键集合
// 与每个键的形状），否则模型写过的代码全部作废。
//
// 所以「可替换」的是 CodeRuntime 的实现，不是 globals。

/** 一条 console 输出（已按预算截断；`truncated` 标在整体结果上） */
export interface LogEntry {
    readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug';
    readonly text: string;
}

/** `run` 的结果：值 + 输出 + 计量。**都必须是可序列化的**（子进程实现要能原样传回） */
export interface RunResult {
    /** 代码的最终返回值（已投影成 JSON-able；不可序列化的给占位字符串） */
    readonly value: unknown;
    /** console 输出，总量受 `logBytes` 约束 */
    readonly logs: readonly LogEntry[];
    /** 输出超预算被截过 */
    readonly truncated: boolean;
    /** 墙钟耗时（毫秒） */
    readonly durationMs: number;
    /** 结束方式：正常返回 / 超时被杀 / 调用方取消 / 抛错 */
    readonly outcome: 'ok' | 'timeout' | 'aborted' | 'error';
}

/** 一次执行的入参 */
export interface RunOptions {
    /** 超时上限（毫秒）。0 = 不设（排障用，等于把"一条挂住"的坑丢给调用方） */
    readonly timeoutMs: number;
    /** 取消信号（用户点"停"） */
    readonly signal?: AbortSignal | undefined;
    /**
     * 注入给模型代码的全局。
     *
     * ⚠️ **键集合是契约**：只放「可描述的东西」（函数、RPC client、JSON-able 值）。
     * 塞一个只有本进程才有的活对象 = 明天换子进程就崩 —— 那正是"挂到子进程要大改"的经典死法。
     */
    readonly globals: Readonly<Record<string, unknown>>;
}

/**
 * 执行引擎。
 *
 * 实现方只需要保证：模型代码里的 `globals` 键都能直接用、超时能收、返回值可序列化。
 */
export interface CodeRuntime {
    /** 引擎标识（进日志与错误信息，便于分辨"这条是哪个引擎跑的"） */
    readonly name: string;
    /** 执行一段模型代码（代码体，不是表达式：可以有 `await` / `return`） */
    run(code: string, opts: RunOptions): Promise<RunResult>;
}

/** 预算：输出 / 单条长度上限。超出即截断并置 `truncated`（不静默丢） */
export interface RunLimits {
    /** console 输出总量（字节，UTF-8） */
    readonly logBytes: number;
    /** 单条日志的字符上限 */
    readonly logChars: number;
    /** 返回值投影后的 JSON 字符上限 */
    readonly valueChars: number;
}

export const DEFAULT_LIMITS: RunLimits = {
    logBytes: 64 * 1024,
    logChars: 4_000,
    valueChars: 32 * 1024,
};
