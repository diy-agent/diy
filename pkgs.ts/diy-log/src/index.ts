// @diy-agent/log — diy 的应用日志能力：**OTel 日志 API + 文件导出器**
//
// ##482（2026-10-30 用户裁决）：不自研日志 API，直接采纳 OpenTelemetry。
//   · 业务包：`import { logs, SeverityNumber } from '@opentelemetry/api-logs'`（接口，几 KB，默认 noop）
//   · 装配层：import OTel 的 SDK 包（实现，包名见 README）
//   · 本包：只做 `FileLogRecordExporter`（写 jsonl + 按天切 + 按大小轮转）+ `child(source)` 语法糖
//
// 落位约定（装配层注入，缺省建议 `$DIY_HOME/log/app`）：
//
//   <dir>/2026-10-31.log       当天（jsonl：一行一条 FileLogEntry）
//   <dir>/2026-10-31.log.1     超 maxBytes 滚出来的历史（数字越大越旧）
//   <dir>/2026-10-31.log.2
//
//   // apps/*/main.ts（唯一 import OTel SDK 包的地方；完整 import 见 README）
//   import { logs } from '@opentelemetry/api-logs';
//   import { child, FileLogRecordExporter } from '@diy-agent/log';
//
//   const provider = new LoggerProvider({
//       processors: [new BatchLogRecordProcessor({ exporter: new FileLogRecordExporter({ dir }) })],
//   });
//   logs.setGlobalLoggerProvider(provider);
//   const log = child('main:chat');
//   log.info('窗口已创建', { variant });
//   log.error('LLM 失败', { provider, status: 400 }, cause);
//   await provider.shutdown();      // 退出前 flush
//
// 边界（不要拿它替代现有三类日志）：
//   · `~/.diy/log/network/` —— 流量日志（请求 / 响应体），有专门结构
//   · `ops.jsonl` —— 会话操作流水（属于 session，不是应用日志）
//   · 不写用户数据：不记消息内容、不记 key

export { LogError } from './errors.js';
export type { LogErrorCode } from './errors.js';

export { FileLogRecordExporter } from './file-exporter.js';
export { child, severityOf, isLogLevel } from './child.js';
export type { ChildLogger, LogData } from './child.js';

export { LOG_LEVELS } from './types.js';
export type {
    ExportedLogRecord,
    ExportResultCallback,
    ExportResultLike,
    FileExporterOptions,
    FileLogEntry,
    FileLogError,
    LogLevel,
    RotateOptions,
} from './types.js';
