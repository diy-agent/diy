// @diy-agent/session-store-memory — 纯内存会话存储（进程退出即消失）
//
// ⚠️ ##480 之后本包只是**兼容入口**：实现已移进 `@diy-agent/session` 的缺省存储
// （`createSession({})` 不传 store 用的就是它）。原因（用户裁决）：session 是「一次对话」，
// 默认活在内存里；要不要持久化由**装配器**决定 —— 装配器传实例，不传枚举。
//
// 仍然从这里 import 的老调用方（##474 的 bot 配置页测试对话）行为完全不变：
//
//   import { openMemorySessionStore } from '@diy-agent/session-store-memory';
//   const session = createSession({ id: 'try-1', llm, store: openMemorySessionStore({ maxEntries: 200 }) });
//
// 新代码建议直接从 `@diy-agent/session` 取（`createSession({})` 已经是内存语义）。

export {
    DEFAULT_MAX_ENTRIES,
    openMemorySessionStore,
    // 错误类与 session 共用同一实现 / 同一套 code（store/invalid-options、store/gap…）
    SessionError as MemoryStoreError,
} from '@diy-agent/session';
export type {
    MemorySessionStore,
    MemorySessionStoreOptions,
    SessionErrorCode as MemoryStoreErrorCode,
} from '@diy-agent/session';
