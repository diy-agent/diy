// @diy-agent/chat-core —— UI 与后端之间的契约与无框架状态（禁止 React / node / UI kit）

export { HttpChatClient, type ChatClient } from './client';
export { dirOf, botsOf, ownerOfBot } from './entity';
export { MockChatClient, type MockOptions } from './mock';
export { applyEvent, emptyState, fromSnapshot, type ConversationState } from './reduce';
export { ConversationStore, type ConversationModel } from './store';
export {
    DEFAULT_CAPABILITIES,
    type Author,
    type Bot,
    type Capabilities,
    type Command,
    type Delivery,
    type DeliveryState,
    type Entity,
    type EntityKind,
    type Item,
    type Snapshot,
    type StreamEvent,
} from './types';
