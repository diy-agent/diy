// @diy-agent/session-store-memory — 纯内存会话存储（进程退出即消失）
//
//   import { createSession } from '@diy-agent/session';
//   import { openMemorySessionStore } from '@diy-agent/session-store-memory';
//
//   const store = openMemorySessionStore({ maxEntries: 200 });
//   const session = createSession({ id: 'try-1', llm, store });
//   for await (const delta of session.send('试试看')) { /* ... */ }
//   // 说完就丢：没有任何文件被写，会话也不出现在任何列表里（##474 判据 4）
//
// 为什么要独立包（而不是 `openJsonlSessionStore({ inMemory: true })`）：
// 存储实现归存储包，一个包里塞两种持久化语义会让「会不会落盘」变成运行期才知道的选项；
// 独立包 = 依赖图里就没有 node:fs，看得见。

export { MemoryStoreError } from './errors.js';
export type { MemoryStoreErrorCode } from './errors.js';

export { DEFAULT_MAX_ENTRIES, openMemorySessionStore } from './store.js';
export type { MemorySessionStore, MemorySessionStoreOptions } from './store.js';
