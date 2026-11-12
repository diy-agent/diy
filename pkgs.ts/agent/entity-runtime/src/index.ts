// index.ts —— entity-runtime 的公开出口（切片阶段，先小后大）

export { runAgent, type RunOptions } from './agent';
export { openStore, type Store } from './db';
export { Inbox } from './inbox';
export { Projector, nextId } from './projection';
export { modelOf, parseModelKey } from './providers';
export type {
    AgentEvent,
    Author,
    Bot,
    Entity,
    EntityKind,
    InboxItem,
    InboxMode,
    Item,
} from './types';
