// types.ts — @diy-agent/log 的公共形状（记录 / 选项 / 句柄）。
//
// 设计动机（##482）：全 app **一份日志流**，靠 `source` 分辨来源 —— 排查时最痛的是
// 「不知道去哪个文件找」，而不是「日志不够多」。所以：
//   · 不分插件、不分模块各写各的文件；
//   · source 必填（包名 / 页面 id / 模块），子句柄用 child(source) 固定；
//   · data 只放机器可读的短字段，err 只放错误对象（有栈）。

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** 运行期判据（读环境变量 / 外部输入时用；别用 as LogLevel 糊过去） */
export function isLogLevel(value: unknown): value is LogLevel {
    return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export interface LogErrorInfo {
    readonly name: string;
    readonly message: string;
    /** 栈（截断到 4000 字符） */
    readonly stack?: string;
    /** 错误链的下一环（`Error.cause`），压成一行 */
    readonly cause?: string;
}

/** 一行 jsonl = 一条记录（字段名即对外契约，改字段 = 破坏 grep / 查看器） */
export interface LogRecord {
    /** ISO 时间（`Date.toISOString()`） */
    readonly at: string;
    readonly level: LogLevel;
    /** 来源标识：包名 / 页面 id / 模块（必填，用于过滤） */
    readonly source: string;
    /** 一行摘要（人读；截断到 2000 字符） */
    readonly msg: string;
    /** 结构化附加（机器读）；超 `maxDataBytes` 截成 `{ truncated: true, bytes }` */
    readonly data?: Readonly<Record<string, unknown>>;
    /** 错误对象（有则带栈；非 Error 也收，name=NonError） */
    readonly err?: LogErrorInfo;
    /** 关联 id（把同一请求的多条日志串起来） */
    readonly traceId?: string;
}

export interface RotateOptions {
    /** 单文件上限（字节）；超了就滚到 `.1` `.2` …（0 = 不按大小轮转） */
    readonly maxBytes?: number;
    /** 保留的历史份数（`.1` … `.maxFiles`，**不含当前文件**；0 = 不留历史） */
    readonly maxFiles?: number;
    /** 保留最近几天的日志组（含今天；0 = 不按天清理） */
    readonly maxDays?: number;
}

export interface LoggerOptions {
    /** 日志目录（缺省落位约定：`$DIY_HOME/log/app`，由装配层注入） */
    readonly dir: string;
    /** 根句柄的 source（缺省 `app`；子句柄用 `child(source)` 固定自己的来源） */
    readonly source?: string;
    /** 最低级别（缺省 `info`） */
    readonly level?: LogLevel;
    /** 轮转（缺省 10 MB / 保留 5 份 / 保留 14 天） */
    readonly rotate?: RotateOptions;
    /** data 的字节上限（缺省 4096），超了截断 —— 永不把整个大对象写进日志 */
    readonly maxDataBytes?: number;
    /** 注入时钟（测试用；缺省 `() => new Date()`） */
    readonly now?: () => Date;
    /** 写盘失败的出口（缺省写 stderr）；日志自身失败不许把 app 带崩 */
    readonly onError?: (error: unknown) => void;
}

export type LogData = Readonly<Record<string, unknown>>;

/**
 * 日志句柄。**没有全局单例**：装配层 createLogger 一次，各包拿 child(source) 的句柄传下去。
 * 这样测试可以各自建到临时目录，互不污染。
 */
export interface Logger {
    readonly source: string;
    readonly traceId?: string;
    /** 派生一个固定来源的句柄（traceId 缺省继承父句柄） */
    child(source: string, traceId?: string): Logger;
    /** 派生一个固定 traceId 的句柄（同一请求的多条日志用它串起来） */
    withTrace(traceId: string): Logger;
    debug(msg: string, data?: LogData, err?: unknown): void;
    info(msg: string, data?: LogData, err?: unknown): void;
    warn(msg: string, data?: LogData, err?: unknown): void;
    error(msg: string, data?: LogData, err?: unknown): void;
    /** 等已入队的记录都落盘（测试 / 关停前用） */
    flush(): Promise<void>;
    /** flush + 之后不再写（app 退出前调用；同一 core 的所有子句柄一起关） */
    close(): Promise<void>;
}
