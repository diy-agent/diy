// index.ts —— entity-runtime 的公开出口（切片阶段，先小后大）

export { runAgent, type RunOptions } from './agent';
export { openStore, type Store } from './db';
export { Inbox } from './inbox';
export { Projector, nextId } from './projection';
export { BotSession, type ChatMessage, type SessionDeps } from './session';
export { modelOf, parseModelKey } from './providers';
export type {
    AgentEvent,
    Author,
    Bot,
    Delivery,
    Room,
    InboxItem,
    InboxMode,
    Item,
} from './types';
