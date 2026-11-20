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
export {
    ASK_DRAFT_PREFIX,
    JOURNAL_KINDS,
    openStore,
    type Draft,
    type JournalEntry,
    type JournalKind,
    type Store,
} from './db';
export { adviceOf, endItems, endReasonOf, publishable, type EndFacts, type EndItemContext } from './end-reason';
export { Projector, nextId } from './projection';
export { RoomActor, type RoomActorDeps, type SessionInfo as RoomSessionInfo } from './room';
export { buildRoomTools, type RoomToolsOptions } from './tools/index';
export { RoomLog, toMessage, type RoomEntry, type RoomEntryInput } from './room-log';
export {
    BotSession,
    DEFAULT_COMPACT,
    type CompactOptions,
    type SessionDeps,
    type SessionEvent,
    type SessionStats,
    type Turn,
    type TurnResult,
} from './session';
export { modelOf, parseModelKey } from './providers';
export { factsOf, replay, STOP_SCENARIOS, type StopReplay, type StopScenario } from './stop-scenarios';
export type { AgentEvent, Author, Bot, Delivery, Room, RoomMember, RoomEvent, InboxMode, Item } from './types';
