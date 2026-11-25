// index.ts —— entity-runtime 的公开出口（切片阶段，先小后大）

export { runAgent, type RunOptions } from './agent';
export {
    DEFAULT_BUDGET,
    estimateChars,
    keepFromOf,
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
    type EntityLink,
    type EntityRecord,
    type AskRecord,
    type JournalEntry,
    type JournalKind,
    type LinkSets,
    type OpenTurn,
    type ProjectInput,
    type ProjectRecord,
    type Store,
    type TaskInput,
    type TaskRecord,
} from './db';
export {
    CORE_TYPES,
    LINK_KINDS,
    isCoreType,
    isEntityId,
    isEntityType,
    isLinkKind,
    isPluginType,
    newEntityId,
    splitPluginType,
    type CoreType,
    type LinkKind,
    type PluginTypeParts,
} from './id';
export { adviceOf, endItems, endReasonOf, publishable, type EndFacts, type EndItemContext } from './end-reason';
export {
    botLastTurnOf,
    needsHuman,
    outcomeOfFact,
    outcomeText,
    withTurnFact,
    type BotLastTurn,
} from './bot-status';
export { Projector, nextId } from './projection';
export { RoomActor, type RoomActorDeps, type SessionInfo as RoomSessionInfo } from './room';
export { buildRoomTools, type RoomJobs, type RoomToolsOptions } from './tools/index';
export { createJobRegistry, jobOwnerOf, parseJobOwner, type JobOwner, type RoomJobsHost } from './jobs';
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
export {
    DEFAULT_MAX_OUTPUT_TOKENS,
    defaultModelKeyOf,
    maxOutputTokensOf,
    modelConfigPath,
    modelHome,
    modelOf,
    modelProviders,
    parseModelKey,
    type ModelView,
    type ProviderView,
} from './providers';
export { factsOf, replay, STOP_SCENARIOS, type StopReplay, type StopScenario } from './stop-scenarios';
export type {
    AgentEvent,
    Author,
    Bot,
    BotOutcome,
    BotRow,
    BotState,
    Delivery,
    Room,
    RoomMember,
    RoomEvent,
    InboxMode,
    Item,
} from './types';
export { dayOf, renderTaskDoc, taskDirOf } from './task-dir';
