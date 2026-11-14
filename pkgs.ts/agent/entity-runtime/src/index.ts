// index.ts —— entity-runtime 的公开出口（切片阶段，先小后大）

export { runAgent, type RunOptions } from './agent';
export {
    DEFAULT_BUDGET,
    estimateChars,
    simpleCompactor,
    type CompactEvent,
    type CompactionBudget,
    type CompactionInput,
    type CompactionResult,
    type Compactor,
    type TokenUsage,
    type TranscriptEntry,
} from './compaction';
export { openStore, type Store } from './db';
export { Inbox } from './inbox';
export { Projector, nextId } from './projection';
export { RoomActor, type RoomActorDeps, type SessionInfo as RoomSessionInfo } from './room';
export { RoomLog, toMessage, type RoomEntry, type RoomEntryInput } from './room-log';
export {
    BotSession,
    DEFAULT_COMPACT,
    type CompactOptions,
    type SessionDeps,
    type SessionStats,
    type TurnResult,
} from './session';
export { modelOf, parseModelKey } from './providers';
export type {
    AgentEvent,
    Author,
    Bot,
    Delivery,
    Room,
    RoomMember,
    RoomEvent,
    InboxItem,
    InboxMode,
    Item,
} from './types';
