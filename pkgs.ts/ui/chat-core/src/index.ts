// @diy-agent/chat-core —— UI 与后端之间的契约与无框架状态（禁止 React / node / UI kit）

export type { ChatClient, CompactEventInfo, CompactOutcome, SessionInfo, SessionStats, TokenUsage } from './client';
export { botsOf, dirOf, memberIdsOf, primaryBotOf } from './entity';
export {
    completeMention,
    dismissMention,
    filterMentionCandidates,
    mentionCandidatesOf,
    mentionQuery,
    moveActive,
    type MentionCandidate,
} from './mention';
export { MockChatClient, type MockOptions } from './mock';
export { applyEvent, emptyState, fromSnapshot, type ConversationState } from './reduce';
export { jobOf, jobViewOfNotice, stripAnsi, type JobRow, type JobState, type JobView } from './job';
export {
    awaitingText,
    DELIVERY_QUIET_MS,
    deliveryNoteOf,
    doingText,
    elapsedText,
    idleNowOf,
    progressLineOf,
    WAIT_QUIET_MS,
    waitTextOf,
    type BotProgress,
} from './progress';
export { ConversationStore, type ConversationModel } from './store';
export { endFooterOf, type EndFooter } from './end-footer';
export { buildTimeline, type TimelineDelivery, type TimelineEntry, type TimelinePart } from './timeline';
export {
    DEFAULT_CAPABILITIES,
    type AnsweredAsk,
    type AskAnswer,
    type AskField,
    type AskOption,
    type AskQuestion,
    type AskQuestionAnswer,
    type AskRequest,
    type Author,
    type Bot,
    type Capabilities,
    type Command,
    type Delivery,
    type DeliveryState,
    type Room,
    type Item,
    type ProgressStage,
    type Snapshot,
    type StreamEvent,
    type TurnEndReason,
} from './types';
