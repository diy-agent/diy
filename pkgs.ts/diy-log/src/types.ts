// types.ts — @diy-agent/log 的公共形状（**不自研日志 API**：接口来自 @opentelemetry/api-logs）
//
// ##482 裁决（2026-10-30）：日志 API 直接用 OTel —— 业务包 import api-logs（接口，几 KB），
// 只有装配层 import OTel 的 SDK 包（实现）。本包自研部分收缩成两件事：
//   1. FileLogRecordExporter —— 把 OTel LogRecord 写成 jsonl（按天切 + 按大小轮转）；
//   2. child(source) —— 拿句柄的语法糖（内部 logs.getLogger(source)）。
//
// 判据（用户给的 grep）：本包 src/ 里不出现自研 Logger 接口，也不出现 OTel SDK 包名
// —— 导出器按 OTel 的 LogRecordExporter 形状**结构化实现**，类型由装配层校验。

import type { SeverityNumber } from '@opentelemetry/api-logs';

/** 句柄暴露的四个级别（映射到 SeverityNumber；更细的级别用 `emit` 直传） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export interface FileLogError {
    readonly name: string;
    readonly message: string;
    /** 栈（截断到 4000 字符） */
    readonly stack?: string;
    /** 错误链的下一环（`Error.cause`），压成一行 */
    readonly cause?: string;
}

/** 落盘的一行（jsonl）—— 字段名即 grep 契约，改字段 = 破坏查看习惯 */
export interface FileLogEntry {
    /** 本地时区 ISO 串（`@diy-agent/time` 的 `localISOString`，如 `2026-10-31T11:29:25.403+0800`；##483） */
    readonly at: string;
    readonly level: string;
    /** 来源标识：包名 / 页面 id / 模块（OTel 的 instrumentationScope.name） */
    readonly source: string;
    readonly msg: string;
    /** 结构化附加（机器读）；超 maxDataBytes 截成 `{truncated, bytes}` */
    readonly data?: Readonly<Record<string, unknown>>;
    /** 错误对象（OTel exception.* 属性还原；有则带栈） */
    readonly err?: FileLogError;
    /** 活动 span 的 trace id（有活动 span 时由 OTel SDK 附到记录上） */
    readonly trace_id?: string;
    readonly span_id?: string;
}

/**
 * 导出器看到的最小 LogRecord 形状：结构化兼容 OTel 的 `ReadableLogRecord`，
 * 但**不 import OTel SDK 包的类型**（判据 2 的 grep）。装配层把本类传给
 * `new BatchLogRecordProcessor({ exporter })` 时由 TS 做兼容性校验。
 */
export interface ExportedLogRecord {
    readonly hrTime: readonly [number, number];
    readonly severityNumber?: SeverityNumber;
    readonly severityText?: string;
    readonly body?: unknown;
    /** 宽松取 OTel `Attributes` 的公共形状（不 import SDK 包的类型） */
    readonly attributes?: Readonly<Record<string, unknown>>;
    readonly instrumentationScope: { readonly name: string; readonly version?: string };
    readonly spanContext?: { readonly traceId: string; readonly spanId: string };
}

/** OTel `ExportResult` 的结构兼容形状（code: 0 = SUCCESS / 1 = FAILED） */
export interface ExportResultLike {
    readonly code: 0 | 1;
    readonly error?: Error;
}

export type ExportResultCallback = (result: ExportResultLike) => void;

export interface RotateOptions {
    /** 单文件上限（字节）；超了就滚到 `.1` `.2` …（0 = 不按大小轮转） */
    readonly maxBytes?: number;
    /** 保留的历史份数（`.1` … `.maxFiles`，**不含当前文件**；0 = 不留历史） */
    readonly maxFiles?: number;
    /** 保留最近几天的日志组（含今天；0 = 不按天清理） */
    readonly maxDays?: number;
}

export interface FileExporterOptions {
    /** 日志目录（缺省落位约定：`$DIY_HOME/log/app`，由装配层注入） */
    readonly dir: string;
    /** 轮转（缺省 10 MB / 保留 5 份 / 保留 14 天） */
    readonly rotate?: RotateOptions;
    /** `data` 的字节上限（缺省 4096）—— 永不把整个大对象写进日志 */
    readonly maxDataBytes?: number;
    /** 写盘失败的出口（缺省写 stderr）；日志自身失败不许把 app 带崩 */
    readonly onError?: (error: unknown) => void;
}
