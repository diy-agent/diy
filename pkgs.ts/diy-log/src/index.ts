// @diy-agent/log — 统一应用日志（结构化 + 来源标识 + 按天/按大小轮转）
//
// ##482：全 app **一份日志流**，靠 `source` 分辨来源（不分插件 / 模块各写各的文件 ——
// 排查时最痛的是「不知道去哪个文件找」）。落位约定由装配层注入，缺省建议 `$DIY_HOME/log/app`：
//
//   <dir>/2026-10-31.log       当天（jsonl：一行一条 LogRecord）
//   <dir>/2026-10-31.log.1     超 maxBytes 滚出来的历史（越旧数字越大）
//   <dir>/2026-10-31.log.2
//
//   import { createLogger } from '@diy-agent/log';
//   const logger = createLogger({ dir: join(home, 'log', 'app') });
//   const log = logger.child('main:chat');       // 来源固定，调用点不用每次写
//   log.info('窗口已创建', { variant });
//   log.error('LLM 失败', { provider, status: 400 }, cause);
//   await logger.close();                        // 退出前 flush
//
// 边界（不要拿它替代现有三类日志）：
//   · `~/.diy/log/network/` —— 流量日志（请求 / 响应体），有专门结构
//   · `ops.jsonl` —— 会话操作流水（属于 session，不是应用日志）
//   · 不写用户数据：不记消息内容、不记 key（应用日志只记「谁启动了什么、哪步失败了」）

export { LogError } from './errors.js';
export type { LogErrorCode } from './errors.js';

export { LOG_LEVELS, isLogLevel } from './types.js';
export type { LogData, LogErrorInfo, LogLevel, LogRecord, Logger, LoggerOptions, RotateOptions } from './types.js';

export { createLogger } from './logger.js';
