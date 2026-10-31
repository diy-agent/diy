# @diy-agent/log

统一应用日志：**全 app 一份 jsonl 流**，靠 `source` 字段分辨来源；按天 + 按大小轮转。

## 为什么（##482）

排查时最痛的是「不知道去哪个文件找」，不是「日志不够多」。所以不分插件、不分模块各写各的文件：

- **统一流**：所有来源写进同一天的同一个文件；
- **结构化**：一行一条 `LogRecord`（`at` / `level` / `source` / `msg` / `data` / `err` / `traceId`）；
- **来源标识**：`source` 必填（包名 / 页面 id / 模块），`logger.child(source)` 在装配层固定；
- **不给全局单例**：`createLogger` 建一次，把 `child` 句柄传下去 —— 测试各自建临时目录，互不污染。

## 用法

```ts
import { join } from 'node:path';
import { createLogger } from '@diy-agent/log';

const logger = createLogger({
    dir: join(home, 'log', 'app'), // 缺省落位约定：$DIY_HOME/log/app
    level: 'info',
    rotate: { maxBytes: 10 * 1024 * 1024, maxFiles: 5, maxDays: 14 },
});

const log = logger.child('main:chat'); // 来源固定，调用点不用每次写
log.info('窗口已创建', { variant: 'lab' });
log.error('LLM 失败', { provider, status: 400 }, cause);

await logger.close(); // app 退出前 flush（之后不再写）
```

同一请求的多条日志用 `withTrace(traceId)` 串起来（`child` 缺省继承父句柄的 traceId）：

```ts
const requestLog = logger.child('llm:request').withTrace(turnId);
requestLog.info('开始请求', { model });
requestLog.warn('重试', { attempt: 2 });
```

## 落盘形态

```
<dir>/2026-10-31.log        当天（jsonl；一行一条 LogRecord）
<dir>/2026-10-31.log.1      超 maxBytes 滚出来的历史（数字越大越旧）
<dir>/2026-10-31.log.2
```

- **按天**：文件名 = 本地日期（`at` 字段仍是 ISO，给机器读）；跨天自动新建；
- **按大小**：单文件超 `maxBytes` ⇒ 当前滚到 `.1`，旧的顺延；超 `maxFiles` 删最旧一份；
- **按天清理**：超过 `maxDays` 的旧日期组（连同 `.N`）在跨天进入新一天时删除；
- `maxFiles` 只数历史份数（**不含当前文件**）；`maxFiles: 0` / `maxBytes: 0` / `maxDays: 0` 分别关闭对应策略。

## 有界化（不写大对象）

- `data` 字符串 / 数组 / 键数 / 深度都有界；整块超 `maxDataBytes`（缺省 4 KB）⇒ 换成 `{ truncated: true, bytes }`；
- `msg` 截断到 2000 字符；`err.stack` 截断到 4000 字符；整行兜底 16 KB；
- 循环引用标 `[circular]`，不会让日志调用抛异常；
- 写盘失败**不抛**（日志是旁路），走 `onError`（缺省写 stderr）。

## 边界（不要拿它替代现有日志）

- `~/.diy/log/network/` —— **流量日志**（请求 / 响应体），有专门结构；
- `ops.jsonl` / `llm.jsonl` / `usage.jsonl` —— **会话数据**（属于 session，不是应用日志）；
- 本包只记**应用日志**：谁启动了什么、哪一步失败了、配置读不到；
- **绝不写用户数据**：不记消息内容、不记 key。

## 接入约定

- 初始化只在装配层（app 主进程入口）做一次：`dir = join(DIY_HOME, 'log', 'app')`；
- 各模块只接收 `Logger` 句柄（或它的 `child(source)`），不自己 `import fs` 写日志文件；
- 级别用 `DIY_LOG_LEVEL` 环境变量覆盖（缺省 `info`）。
