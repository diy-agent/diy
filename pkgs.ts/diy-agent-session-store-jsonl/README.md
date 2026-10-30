# @diy-agent/session-store-jsonl

`@diy-agent/session` 的**分桶 jsonl** 存储适配器（可选包；core 本身零 IO）。

```ts
import { createSession } from '@diy-agent/session';
import { openJsonlSessionStore } from '@diy-agent/session-store-jsonl';

const store = await openJsonlSessionStore({ dir: '/path/to/session-1' }); // 缺省桶 16 MB
const history = await store.readFrom(0);
const session = createSession({ id: 's1', llm, store, initialMessages: history });

for await (const delta of session.send('在吗')) {
    /* 消息自动 append；写满一桶自动切 */
}
```

## 目录形态

```
<dir>/index.json        桶索引（勿与桶混合）
<dir>/0001-20261030-115000+0800.jsonl    一桶 ≤ maxBucketBytes（缺省 16 MB）
<dir>/0002-20261030-121530+0800.jsonl    文件名 = 序号 + 首条 entry 的 at（本地时刻 + 偏移）
```

文件名 = `<序号>-<本地日期>-<本地时间><时区偏移>.jsonl`（如 `0001-20261030-115000+0800.jsonl`）：

- **序号在前** ⇒ 排序靠序号不靠时间（夏令时 / 换时区都不乱序）；4 位够 9999 × 16 MB ≈ 156 GB，溢出自然加宽且排序仍对
- 时间是**本地时刻**（给人读），偏移说明它在哪个时区；取的是**首条 entry 的 `at` 那一刻**的偏移，不是「现在」
  （历史数据可能在不同时区写入）；不用 `CST` 这类有歧义的缩写
- 秒精度、`-` 分隔日期与时间（`T` 是 ISO 标准但不好读）；Windows 文件名禁 `:`，所以不写 `11:50:00`

文件名**只是提示**：有些不查 `index.json` 的工具（`ls` / `grep` / 日志查看器）靠它就能看出日期。
真值以桶内首尾行为准，两者不一致时以数据为准（重建不改名、不报错）。

`index.json`：

```ts
interface BucketIndex {
    buckets: { file; bytes; fromSeq; toSeq; fromAt; toAt }[];
    totalBytes: number;
    nextSeq: number; // 全局单调，跨桶连续
}
```

## 三条关键判据

1. **按大小切桶，不按日期**：某天一次长跑照样会把单文件撑爆（实测单会话 ops.jsonl 已 181 MB）
2. **seq 全局单调、跨桶连续**：桶只是物理切分；`readFrom(seq)` 查 index 定位 `toSeq > seq` 的桶，
   只读这些文件 ⇒ 不扫全量；`readRange({from,to})` 按 `fromAt/toAt` 二分定位时间相交的桶
3. **删中间桶要报错**：`open` 抛 `store/missing-bucket`；index 坏了/丢了就扫目录重建，
   重建时发现缺号抛 `store/gap` —— 绝不静默丢数据

`append` 只写最后一桶，正常追加不动 `index.json`（bytes 在内存累计，切桶时才落 index）；
崩溃在切桶中途留下的多余桶，下次 `open` 会补登记。

## 边界情形

| 情形                          | 行为                       |
| ----------------------------- | -------------------------- |
| 崩溃在切桶中途（多出桶）      | open 时扫目录重建索引      |
| index.json 损坏 / 缺失        | 扫各桶首尾行重建           |
| 单条消息 > maxBucketBytes     | 允许独占一桶（不切、不丢） |
| append 的 seq 不连续 / 缺 seq | 整批拒绝（先校验再写）     |

需求真源：[`tests/intent.store.test.ts`](./tests/intent.store.test.ts)（T1–T9）。
