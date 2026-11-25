// log.ts —— diy2 的应用日志装配（##482：业务包只用 OTel 接口，**只有装配层** import SDK）
//
// 落地两处：
//   · `<home>/log/app/YYYY-MM-DD.log` —— jsonl，一行一条 FileLogEntry（按天切、按大小轮转，
//     可 grep、跨重启留存）
//   · 终端 —— 一行 `[source] msg k=v`（启动期人要看端口 / UI 路径；ERROR 走 stderr）
//
// 为什么还要终端 exporter 而不是继续用 `console.*`：**一处写日志、两处落地**。
// 之前 `console.error(error)` 把 SDK 的整棵 RetryError 树（errors[3] 每层都带 responseBody /
// responseHeaders / 完整 messages 与 tools）倒进终端 —— 既看不清，又没进文件（重启即失）。
// 现在错误由装配层统一渲染成一行，原始对象进 jsonl 的 `data` / `err` 字段。
//
// 来源（source）命名：`diy2:<模块>`，如 `diy2:boot` / `diy2:app` / `diy2:registry`。

import { join } from 'node:path';

import { logs, type LogRecord } from '@opentelemetry/api-logs';
import { BatchLogRecordProcessor, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
    child,
    FileLogRecordExporter,
    isLogLevel,
    severityOf,
    type ChildLogger,
    type ExportResultCallback,
    type ExportedLogRecord,
} from '@diy-agent/log';

export type { ChildLogger };

/** 终端一行：`[source] msg  key=value`；长值截断（终端不是给机器读的） */
class TerminalLogRecordExporter {
    export(records: readonly ExportedLogRecord[], resultCallback: ExportResultCallback): void {
        for (const record of records) {
            const source = record.instrumentationScope.name;
            const body = typeof record.body === 'string' ? record.body : JSON.stringify(record.body);
            const data = record.attributes ?? {};
            const pairs = Object.entries(data)
                .filter(([, value]) => value !== undefined && value !== null && value !== '')
                .map(([key, value]) => `${key}=${clip(value)}`)
                .join(' ');
            const line = `[${source}] ${body ?? ''}${pairs === '' ? '' : `  ${pairs}`}`;
            // error 走 stderr（`diy2 web` 会把子进程 stderr 标红，一眼能看见）；
            // 其余走 stdout —— 与改造前 `console.log` / `console.error` 的分工一致。
            const error = (record.severityNumber ?? 0) >= 17;
            const stream = error ? process.stderr : process.stdout;
            stream.write(`${line}\n`);
        }
        resultCallback({ code: 0 });
    }

    /** 终端是同步写，没有缓冲要冲 —— 但接口要求得有 */
    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}

function clip(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    return text.length <= 120 ? text : `${text.slice(0, 117)}…`;
}

export interface AppLog {
    /** 取一个固定来源的句柄（进程内可反复取，OTel 按 name 复用 logger） */
    open(source: string): ChildLogger;
    /** 退出前 flush（BatchLogRecordProcessor 有缓冲） */
    shutdown(): Promise<void>;
}

/**
 * 装配全局 logger。
 *
 * @param opts.home  数据根（日志落 `<home>/log/app`，与其余运行产物同根，清 home 就清干净）
 * @param opts.level 级别（`DIY_LOG_LEVEL`，缺省 info）
 */
export function installAppLog(opts: { home: string; level?: string | undefined }): AppLog {
    const level = opts.level !== undefined && isLogLevel(opts.level) ? opts.level : 'info';
    const provider = new LoggerProvider({
        processors: [
            new BatchLogRecordProcessor({
                exporter: new FileLogRecordExporter({
                    dir: join(opts.home, 'log', 'app'),
                    rotate: { maxBytes: 10 * 1024 * 1024, maxFiles: 5, maxDays: 14 },
                    // 日志自身写盘失败不许把 app 带崩，也不能递归写日志
                    onError: (error) => {
                        process.stderr.write(`[diy2] 应用日志写盘失败：${String(error)}\n`);
                    },
                }),
            }),
            new SimpleLogRecordProcessor({ exporter: new TerminalLogRecordExporter() }),
        ],
        // 级别过滤交给 SDK（Logger.enabled 按 minimumSeverity 丢记录）
        loggerConfigurator: () => ({ enabled: true, minimumSeverity: severityOf(level), traceBased: false }),
    });
    logs.setGlobalLoggerProvider(provider);
    return {
        open: (source: string) => child(`diy2:${source}`, provider),
        shutdown: () => provider.shutdown(),
    };
}

/** 未装配时（单测 / dev 直接 import app）也能拿到 noop 句柄 —— OTel 默认 provider 就是 noop */
export function openLog(source: string): ChildLogger {
    return child(`diy2:${source}`);
}

export type { LogRecord };
