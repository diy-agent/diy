# @diy-agent/log

diy 的应用日志：**OTel 日志 API + 文件导出器**（jsonl / 按天切 / 按大小轮转 / trace 关联）。

## 为什么是 OTel（##482 裁决）

不自研日志 API。分层：

| 包 | 是什么 | 谁依赖 |
|---|---|---|
| `@opentelemetry/api-logs` | **接口**（类型 + noop 实现，几 KB）。`Logger` / `LoggerProvider` / `SeverityNumber` | 所有业务包 |
| `@opentelemetry/sdk-logs` | **实现**（几十 KB）。`LoggerProvider` / `BatchLogRecordProcessor` / exporter | **只有装配层**（`apps/*/main.ts`） |
| `@diy-agent/log` | **文件导出器** + `child(source)` 语法糖 | 装配层（导出器）；业务包可只用 api-logs |

判据（可 grep）：`pkgs.ts/*/src` 里不出现 OTel SDK 包名（业务包只用接口）；
本包 `src/` 里没有自研 Logger 接口，导出器按 `LogRecordExporter` 的形状结构化实现。

## 装配层（唯一 import SDK 的地方）

```ts
import { join } from 'node:path';
import { logs } from '@opentelemetry/api-logs';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { child, FileLogRecordExporter, isLogLevel, severityOf } from '@diy-agent/log';

const level = isLogLevel(process.env['DIY_LOG_LEVEL']) ? process.env['DIY_LOG_LEVEL'] : 'info';
const provider = new LoggerProvider({
    processors: [
        new BatchLogRecordProcessor({
            exporter: new FileLogRecordExporter({
                dir: join(process.env['DIY_HOME'] ?? app.getPath('userData'), 'log', 'app'),
                rotate: { maxBytes: 10 * 1024 * 1024, maxFiles: 5, maxDays: 14 },
            }),
        }),
    ],
    // 级别过滤交给 SDK（Logger.enabled 按 minimumSeverity 丢记录）
    loggerConfigurator: () => ({ enabled: true, minimumSeverity: severityOf(level), traceBased: false }),
});
logs.setGlobalLoggerProvider(provider);

const log = child('main:chat'); // 来源固定，调用点不用每次写
log.info('窗口已创建', { variant });
log.error('LLM 失败', { provider, status: 400 }, cause);

await provider.shutdown(); // 退出前 flush（BatchLogRecordProcessor 的队列 + 导出器）
```

## 业务包（只用接口）

```ts
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const log = logs.getLogger('@diy-agent/session', '0.1.0');
log.emit({ severityNumber: SeverityNumber.ERROR, body: 'invalid delta', attributes: { turnId } });
```

测试 / 独立装配可以直接构造自己的 provider，不必碰全局单例：

```ts
const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
const log = child('main:test', provider); // 第二个参数 = 注入 provider
```

## 落盘形态

```
<dir>/2026-10-31.log        当天（jsonl；一行一条 FileLogEntry）
<dir>/2026-10-31.log.1      超 maxBytes 滚出来的历史（数字越大越旧）
<dir>/2026-10-31.log.2
```

一行：

```json
{"at":"2026-10-31T02:41:33.024Z","level":"info","source":"main:chat","msg":"应用启动","data":{"variant":"lab"},"trace_id":"…","span_id":"…"}
```

- **按天**：文件名 = 记录时间的本地日期（`at` 字段仍是 ISO，给机器读）；跨天自动新建；
- **按大小**：单文件超 `maxBytes` ⇒ 当前滚到 `.1`，旧的顺延；超 `maxFiles` 删最旧一份；
- **按天清理**：超过 `maxDays` 的旧日期组（连同 `.N`）在进入新一天时删除；
- `maxFiles` 只数历史份数（**不含当前文件**）；`maxBytes: 0` / `maxFiles: 0` / `maxDays: 0` 分别关闭对应策略。

`level` 取自 OTel 的 `severityText`（`child` 写 `debug/info/warn/error`）；直接 `emit` 时按 `SeverityNumber` 归并。

## trace 关联（判据 5）

OTel SDK 在 `emit` 时自动把**当前活动 span** 的 `SpanContext` 附到记录上（`LogRecord.context` 可显式指定）。
导出器把它写成 `trace_id` / `span_id`，于是日志能和 metrics / trace 对上。没有活动 span 就不写这两个字段。

## 有界化（不写大对象）

- `data` 字符串 / 数组 / 键数 / 深度都有界；整块超 `maxDataBytes`（缺省 4 KB）⇒ `{ truncated: true, bytes }`；
- `msg` 截断到 2000 字符；`err.stack` 截断到 4000 字符；整行兜底 16 KB；
- 循环引用标 `[circular]`；`Uint8Array` 标 `[bytes:N]`；
- `Error` 由 OTel 摊成 `exception.type/message/stacktrace`，导出器还原成 `err { name, message, stack?, cause? }`；
- 写盘失败**不抛**（日志是旁路）：`onError`（缺省写 stderr）+ `resultCallback({ code: FAILED })`。

## 边界（不要拿它替代现有日志）

- `~/.diy/log/network/` —— **流量日志**（请求 / 响应体），有专门结构；
- `ops.jsonl` / `llm.jsonl` / `usage.jsonl` —— **会话数据**（属于 session，不是应用日志）；
- 本包只记**应用日志**：谁启动了什么、哪一步失败了、配置读不到；
- **绝不写用户数据**：不记消息内容、不记 key；
- 不做 OTLP 网络导出、不做日志查看器（先 grep 文件）。
