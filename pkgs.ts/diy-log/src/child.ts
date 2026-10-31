// child.ts — `child(source)` 语法糖：固定来源的句柄，内部就是 OTel 的 `logs.getLogger(source)`。
//
// 为什么还要这层（##482）：调用点每次写 `logs.getLogger("main:chat").emit({ severityNumber: ... })`
// 太啰嗦；但**不自研日志 API** —— 这只是四个级别的转发，`emit` 原样透传给 OTel。
// 不给全局单例：装配层建一次，把句柄传给各模块；测试也能传自己的 provider 独立验证。

import {
    logs,
    SeverityNumber,
    type AnyValue,
    type LogAttributes,
    type LogRecord,
    type LoggerProvider,
} from '@opentelemetry/api-logs';
import { LogError } from './errors.js';
import { sanitizeValue } from './sanitize.js';
import { LOG_LEVELS, type LogLevel } from './types.js';

export type LogData = Readonly<Record<string, unknown>>;

/** 级别 → OTel SeverityNumber（装配层配 minimumSeverity 时也用这把尺子） */
const SEVERITY: Record<LogLevel, SeverityNumber> = {
    debug: SeverityNumber.DEBUG,
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
};

export function isLogLevel(value: unknown): value is LogLevel {
    return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** 级别 → SeverityNumber；非法级别抛 `log/invalid-options`（装配层读环境变量时用 isLogLevel 先判） */
export function severityOf(level: LogLevel): SeverityNumber {
    if (!isLogLevel(level)) {
        throw new LogError('log/invalid-options', `level 必须是 ${LOG_LEVELS.join(' / ')}`, String(level));
    }
    return SEVERITY[level];
}

/** 句柄形状（**不是日志 API**：只是把四个级别转发给 OTel 的 Logger.emit） */
export type ChildLogger = {
    readonly source: string;
    debug(msg: string, data?: LogData, err?: unknown): void;
    info(msg: string, data?: LogData, err?: unknown): void;
    warn(msg: string, data?: LogData, err?: unknown): void;
    error(msg: string, data?: LogData, err?: unknown): void;
    /** 原样透传（更细的 SeverityNumber / 显式 context 用它） */
    emit(record: LogRecord): void;
};

/** data → OTel attributes（**整对象**走一次 sanitize：跨键的循环引用才捉得到；导出器还会再做一道） */
function toAttributes(data: LogData | undefined): LogAttributes {
    if (data === undefined) return {};
    const safe = sanitizeValue(data);
    if (typeof safe !== 'object' || safe === null || Array.isArray(safe)) {
        return { value: safe as AnyValue };
    }
    return safe as LogAttributes;
}

/** 非 Error 也收（排查时不许因为类型不对就丢）；`cause` 单独摊成属性供落盘还原 */
function asException(err: unknown): Error {
    if (err instanceof Error) return err;
    const wrapped = new Error(String(err));
    wrapped.name = 'NonError';
    return wrapped;
}

/**
 * 拿一个固定来源的句柄。
 *
 * @param source 来源标识（包名 / 页面 id / 模块，**必填**：统一流里靠它过滤）
 * @param provider 缺省 = 全局 provider（装配层 `logs.setGlobalLoggerProvider`）；测试可传自己的
 *
 * @example
 *   const log = child('main:chat');
 *   log.info('窗口已创建', { variant });
 *   log.error('LLM 失败', { provider, status: 400 }, cause);
 */
export function child(source: string, provider: LoggerProvider = logs): ChildLogger {
    if (typeof source !== 'string' || source.trim() === '') {
        throw new LogError('log/invalid-source', 'child(source) 的来源标识不能为空');
    }
    const logger = provider.getLogger(source);

    const emitAt = (level: LogLevel, msg: string, data?: LogData, err?: unknown): void => {
        const attributes = toAttributes(data);
        if (err === undefined || err === null) {
            logger.emit({ severityNumber: SEVERITY[level], severityText: level, body: msg, attributes });
            return;
        }
        const exception = asException(err);
        const cause = exception.cause;
        if (cause !== undefined && cause !== null) {
            attributes['exception.cause'] = sanitizeValue(
                cause instanceof Error ? `${cause.name}: ${cause.message}` : cause,
            ) as AnyValue;
        }
        logger.emit({
            severityNumber: SEVERITY[level],
            severityText: level,
            body: msg,
            attributes,
            exception,
        });
    };

    return {
        source,
        debug: (msg, data, err) => emitAt('debug', msg, data, err),
        info: (msg, data, err) => emitAt('info', msg, data, err),
        warn: (msg, data, err) => emitAt('warn', msg, data, err),
        error: (msg, data, err) => emitAt('error', msg, data, err),
        emit: (record) => logger.emit(record),
    };
}
