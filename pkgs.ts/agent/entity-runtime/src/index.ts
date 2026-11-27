// index.ts —— entity-runtime 的公开出口（切片阶段，先小后大）

export { runAgent, type RunOptions } from './agent';

// 迁移体系（实现全在 ./migrations/，一个迁移一个文件）
export { migrations } from './migrations/index';
export { migrationPlan, type MigrationPlanItem } from './migrations/plan';
export { appliedCount } from './migrations/run';
export type { Migration, MigrationRuntime } from './migrations/types';
export {
    DEFAULT_BUDGET,
    estimateChars,
    estimateTokens,
    retainTokensForTurns,
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
    MIGRATION_STEPS,
    PLACEHOLDER_MODEL_KEY,
    openStore,
    type MigrationReporter,
    type MigrationStepEvent,
    type OpenStoreOptions,
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
    UNIT_STATUSES,
    type UnitInput,
    type UnitRecord,
    type UnitStatus,
} from './db';
export {
    unitBoard,
    unitTreeLines,
    unitsContextValue,
    unitsContextText,
    type UnitBoard,
    type UnitBoardRow,
    type UnitFacts,
    type UnitHead,
    type UnitsContextText,
    type UnitsContextValue,
} from './units';
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
    createTurnLookup,
    needsHuman,
    outcomeOfFact,
    outcomeText,
    withTurnFact,
    type BotLastTurn,
    type TurnFactSource,
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
    snapshotPath,
    type ModelView,
    type ProviderView,
} from './providers';
export { factsOf, replay, STOP_SCENARIOS, type StopReplay, type StopScenario } from './stop-scenarios';
export type { AgentEvent, Author, Bot, BotProfile, Delivery, Room, RoomMember, RoomEvent, InboxMode, Item } from './types';
export { dayOf, renderTaskDoc, taskDirOf } from './task-dir';
