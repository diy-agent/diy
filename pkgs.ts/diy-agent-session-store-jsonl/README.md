# @diy-agent/session-store-jsonl

`@diy-agent/session` 的**分桶 jsonl** 存储适配器（可选包；core 本身零 IO）。

```ts
import { createSession } from '@diy-agent/session';
import { openJsonlSessionStore } from '@diy-agent/session-store-jsonl';

const store = await openJsonlSessionStore({ dir: '/path/to/session-1' }); // 缺省桶 8 MB
const history = await store.readFrom(0);
const session = createSession({ id: 's1', llm, store, initialMessages: history });

for await (const delta of session.send('在吗')) {
    /* 消息自动 append；写满一桶自动切 */
}
```

## 目录形态

```
<dir>/index.json        桶索引（勿与桶混合）
<dir>/log-0001.jsonl    一桶 ≤ maxBucketBytes（缺省 8 MB）
<dir>/log-0002.jsonl
```

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

需求真源：[`tests/intent.store.test.ts`](./tests/intent.store.test.ts)（T1–T7）。
