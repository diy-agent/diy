// store.ts —— ConversationStore：无框架的会话状态（get/subscribe/intents）。
//
// surface 只拿它渲染 + 发意图；不直接碰 client / fetch。

import type { ChatClient } from './client';
import { applyEvent, emptyState, fromSnapshot, type ConversationState } from './reduce';
import { DEFAULT_CAPABILITIES, type Capabilities, type Command } from './types';

/** Error → 人能读的一句话（别把 "Error: ..." 前缀甩给用户） */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface ConversationModel {
    get(): ConversationState;
    subscribe(listener: () => void): () => void;
    readonly capabilities: Capabilities;
    send(text: string): void;
    cancel(): void;
    /** 只停某个成员（开会时用） */
    stop(botId?: string): void;
    reload(): void;
}

export class ConversationStore implements ConversationModel {
    private state: ConversationState = emptyState();
    private readonly listeners = new Set<() => void>();
    private loadToken = 0;

    readonly capabilities = DEFAULT_CAPABILITIES;

    private detachWatch: (() => void) | undefined;
    private readySeen = false;
    /** 至少成功拉过一次快照：首次 ready 只在"构造时那次没拉成"的情况下才补拉 */
    private loadedOnce = false;

    constructor(
        private readonly client: ChatClient,
        public readonly entityId: string,
    ) {
        this.attach();
    }

    /** 挂上常驻订阅（幂等）。切回房间 / 重连后复用同一个 store 时调它 */
    attach = (): void => {
        if (this.detachWatch !== undefined) return;
        // 常驻订阅：不依赖"我发过消息"，后台 bot 的提问 / 结论也能实时进来
        this.detachWatch = this.client.watch?.(this.entityId, (event) => this.apply(event));
    };

    /** 释放常驻订阅（切走房间 / 卸载时用，避免每个看过的房间各挂一条 SSE） */
    dispose = (): void => {
        this.detachWatch?.();
        this.detachWatch = undefined;
    };

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
        if (event.kind === 'ready') {
            // 首次连接一般不用重拉（构造时已经 load 过）；但那次也可能失败（后端还没起来），
            // 所以只在"已经拉成功过"时跳过。重连后一律补拉，填平断线期间丢的事件。
            if (this.readySeen || !this.loadedOnce) this.reload();
            this.readySeen = true;
            return;
        }
        this.emit(applyEvent(this.state, event));
    }

    /** 箭头方法：surface 可以把 reload 直接当回调传（不解绑 this） */
    reload = (): void => {
        const token = ++this.loadToken;
        void this.client
            .load(this.entityId)
            .then((snapshot) => {
                if (token !== this.loadToken) return;
                this.loadedOnce = true;
                this.emit(fromSnapshot(snapshot));
            })
            .catch((error: unknown) => this.emit({ ...this.state, error: messageOf(error) }));
    };

    private post = (command: Command): void => {
        this.emit({ ...this.state, error: undefined, running: true });
        void this.client
            .post(this.entityId, command, (event) => this.apply(event))
            // 不在这里置 running=false：谁在说话由服务端的 running 事件决定，
            // 否则多 bot 并行时，先结束的那个会把还在说的那个一起标成空闲
            .catch((error: unknown) => {
                const message = messageOf(error);
                // 用户点"停止"会 abort 本地流，这不是故障，别弹错误条
                if (/abort/i.test(message)) return;
                this.emit({ ...this.state, error: message });
            });
    };

    /** 运行中也允许发：后端决定它在哪个边界生效（next-step 默认） */
    send = (text: string): void => {
        const trimmed = text.trim();
        if (trimmed === '') return;
        this.post({ kind: 'send', text: trimmed });
    };

    cancel = (): void => {
        this.post({ kind: 'cancel' });
    };

    /** 只停某个成员（开会时用）；不传 = 停整个房间 */
    stop = (botId?: string): void => {
        this.post({ kind: 'cancel', ...(botId === undefined ? {} : { botId }) });
    };
}
