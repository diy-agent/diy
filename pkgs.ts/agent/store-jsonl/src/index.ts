// @diy-agent/session-store-jsonl — 按大小切桶的 jsonl 会话存储
//
// 核心（@diy-agent/session）零 IO：要落盘就装这个适配器。目录形态：
//
//   <dir>/index.json       桶索引（勿与桶混合）
//   <dir>/0001-20261030-115000+0800.jsonl   一桶 ≤ maxBucketBytes（缺省 16 MB）
//   <dir>/0002-20261030-121530+0800.jsonl   文件名 = 序号 + 首条 entry 的 at（本地时刻 + 偏移，##464）
//
//   import { createSession } from '@diy-agent/session';
//   import { openJsonlSessionStore } from '@diy-agent/session-store-jsonl';
//
//   const store = await openJsonlSessionStore({ dir: '~/.diy/sessions/s1'.replace('~', home) });
//   const history = await store.readFrom(0);                       // 恢复：读全部
//   const session = createSession({ id: 's1', llm, store, initialMessages: history });
//   for await (const delta of session.send('在吗')) { /* ... */ }    // 自动 append，自动切桶
//   await store.readFrom(store.latestSeq() - 3);                    // 只读尾部（不扫全量）
//
// 边界（##456「存储分桶」）：seq 全局单调、跨桶连续；切桶按大小不按日期；
// 删中间桶会在 open 时报 `store/missing-bucket`，不静默丢数据。

export { StoreError } from './errors.js';
export type { StoreErrorCode } from './errors.js';

export { DEFAULT_MAX_BUCKET_BYTES } from './types.js';
export type { BucketIndex, BucketRecord, JsonlSessionStoreOptions } from './types.js';

export { openJsonlSessionStore } from './store.js';
export type { JsonlSessionStore } from './store.js';
