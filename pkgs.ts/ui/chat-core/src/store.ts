// store.ts —— ConversationStore：无框架的会话状态（get/subscribe/intents）。
//
// surface 只拿它渲染 + 发意图；不直接碰 client / fetch。

import type { ChatClient } from './client';
import { applyEvent, emptyState, fromSnapshot, type ConversationState } from './reduce';
import { DEFAULT_CAPABILITIES, type Capabilities, type Command } from './types';

export interface ConversationModel {
    get(): ConversationState;
    subscribe(listener: () => void): () => void;
    readonly capabilities: Capabilities;
    send(text: string): void;
    cancel(): void;
    reload(): void;
}

export class ConversationStore implements ConversationModel {
    private state: ConversationState = emptyState();
    private readonly listeners = new Set<() => void>();
    private loadToken = 0;

    readonly capabilities = DEFAULT_CAPABILITIES;

    constructor(
        private readonly client: ChatClient,
        public readonly entityId: string,
    ) {}

    get = (): ConversationState => this.state;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    private emit(next: ConversationState): void {
        this.state = next;
        for (const listener of this.listeners) listener();
    }

    private apply(event: Parameters<typeof applyEvent>[1]): void {
        this.emit(applyEvent(this.state, event));
    }

    reload(): void {
        const token = ++this.loadToken;
        void this.client
            .load(this.entityId)
            .then((snapshot) => {
                if (token !== this.loadToken) return;
                this.emit(fromSnapshot(snapshot));
            })
            .catch((error: unknown) => this.emit({ ...this.state, error: String(error) }));
    }

    private post(command: Command): void {
        this.emit({ ...this.state, error: undefined, running: true });
        void this.client
            .post(this.entityId, command, (event) => this.apply(event))
            .catch((error: unknown) => this.emit({ ...this.state, error: String(error), running: false }))
            .finally(() => this.emit({ ...this.state, running: false }));
    }

    send(text: string): void {
        const trimmed = text.trim();
        if (trimmed === '' || this.state.running) return;
        this.post({ kind: 'send', text: trimmed });
    }

    cancel(): void {
        this.post({ kind: 'cancel' });
    }
}
