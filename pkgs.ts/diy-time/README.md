# @diy-agent/time

时间格式约定（##483）：**日志 / 事件 / 记录一律本地时区 + 偏移**。零依赖、零 IO、不取当前时间（`d` 缺省才取现在）。

## 约定

| 场景 | 写法 | 例 |
|---|---|---|
| 记录类时间戳（日志 / 事件 / 任务字段 / 消息） | `localISOString()` | `2026-10-31T11:29:25.403+0800` |
| 按天分桶 / 查节假日表 | `localDateKey()` | `2026-10-31` |
| 要比先后 | `compareInstant()` | 别用 `<` 比串 |

**例外**：必须 UTC 的字段（跨机器排序等）—— 字段名带 `utc` 后缀 + 注释写明原因：

```ts
/** utcAt: 跨机器对比用（本地时区会让同一时刻显示不同，无法排序） */
utcAt: '2026-10-31T03:29:25.403Z',
```

## 为什么

- 人读日志不用心算时区：`11:29` 就是上午 11 点；
- 偏移必须在串里：否则跨时区看不出是哪的时间，两个不同时刻还能长得一样。

## 用法

```ts
import { compareInstant, localDateKey, localISOString } from '@diy-agent/time';

record.at = localISOString();            // 缺省 = 现在
record.day = localDateKey(new Date(ms)); // 本地日期
rows.sort((a, b) => compareInstant(b.ts, a.ts)); // 时刻序（不是字典序）
```

`new Date('2026-10-31T11:29:25.403+0800')` 解析回同一 instant（V8 / Node 实测，`tests/intent.time.test.ts` 的 T2 钉住）。

## 边界

- 不做时区换算（没有 `tz` 概念，只用宿主本地时区）；
- 不做格式化展示（`MM-DD HH:MM` 这类给人看的走 `diy-app/src/shared/date-format.ts`）；
- 不改已有历史数据：老记录里的 `Z` 串照旧能解析，只是比较要用 `compareInstant`。
