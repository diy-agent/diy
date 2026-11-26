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
    /** 发送一条消息。resolve = 后端已受理（首条事件/建流成功），UI 据此清草稿；reject = 压根没发出去 */
    send(text: string): Promise<void>;
    cancel(): void;
    /** 只停某个成员（开会时用） */
    stop(botId?: string): void;
    /** 重拉快照（`limit` 缺省 = 服务端缺省的分页；`0` = 全量） */
    reload(limit?: number): void;
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

    /** 释放常驻订阅（切走房间 / 卸载时用）。连接是共用的，退订只是从话题上摘掉自己 */
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
    reload = (limit?: number): void => {
        const token = ++this.loadToken;
        void this.client
            .load(this.entityId, limit === undefined ? undefined : { limit })
            .then((snapshot) => {
                if (token !== this.loadToken) return;
                this.loadedOnce = true;
                this.emit(fromSnapshot(snapshot));
            })
            .catch((error: unknown) => this.emit({ ...this.state, error: messageOf(error) }));
    };

    /** 全量拉一次（用户点「加载更早的」）：`limit = 0` 在协议里就是“全都要” */
    loadAll = (): void => this.reload(0);

    private post = (command: Command): Promise<void> =>
        new Promise((resolve, reject) => {
            this.emit({ ...this.state, error: undefined, running: true });
            let accepted = false;
            /**
             * 「受理」的口径：POST 返回 200（服务端受理即返，不再挂到整轮结束）、
             * 收到首条事件、或本地主动 abort（那时消息多半已到后端）都算。
             */
            const accept = (): void => {
                if (accepted) return;
                accepted = true;
                resolve();
            };
            this.client
                .post(this.entityId, command, (event) => {
                    accept();
                    this.apply(event);
                })
                // 不在这里置 running=false：谁在说话由服务端的 running 事件决定，
                // 否则多 bot 并行时，先结束的那个会把还在说的那个一起标成空闲
                .catch((error: unknown) => {
                    const message = messageOf(error);
                    // abort 不是故障（例如调用方自己取消了这次请求），别弹错误条，
                    // 也别让 UI 把已经发出去的那句恢复成草稿
                    if (/abort/i.test(message)) {
                        accept();
                        return;
                    }
                    this.emit({ ...this.state, error: message });
                    if (!accepted) reject(new Error(message));
                })
                .then(accept);
        });

    /** 运行中也允许发：后端决定它在哪个边界生效（next-step 默认） */
    send = (text: string): Promise<void> => {
        const trimmed = text.trim();
        if (trimmed === '') return Promise.resolve();
        return this.post({ kind: 'send', text: trimmed });
    };

    cancel = (): void => {
        void this.post({ kind: 'cancel' }).catch(() => undefined);
    };

    /** 只停某个成员（开会时用）；不传 = 停整个房间 */
    stop = (botId?: string): void => {
        void this.post({ kind: 'cancel', ...(botId === undefined ? {} : { botId }) }).catch(() => undefined);
    };
}
