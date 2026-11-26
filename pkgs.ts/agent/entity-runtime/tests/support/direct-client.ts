// support/direct-client.ts —— 不带网络的 ChatClient 实现（测试 / 未来的同进程宿主用）。
//
// `wire=true` 时所有命令与事件都过一次 JSON：模拟任何真实传输都会做的序列化边界，
// 用来抓"载荷里有不可序列化东西"这类只有换传输才暴露的问题。

import type {
    AskAnswer,
    ChatClient,
    Command,
    CompactOutcome,
    SessionInfo,
    Snapshot,
    StreamEvent,
} from '@diy-agent/chat-core';

import { HUMAN, type Harness } from './harness';

export class DirectRoomClient implements ChatClient {
    constructor(
        private readonly harness: Harness,
        private readonly wire = false,
    ) {}

    private maybe<T>(value: T): T {
        return this.wire ? (JSON.parse(JSON.stringify(value)) as T) : value;
    }

    async load(): Promise<Snapshot> {
        return this.maybe({
            items: this.harness.items(),
            deliveries: this.harness.room.deliveries(),
            asks: this.harness.room.pendingAskRequests(),
            // 与线上 `chat.history` 对齐：谁在跑是**服务端事实**，不由客户端倒推
            speaking: this.harness.room.runningBots(),
            runningTurns: this.harness.room.runningTurns(),
        });
    }

    async post(
        _entityId: string,
        command: Command,
        onEvent: (event: StreamEvent) => void,
        signal?: AbortSignal,
    ): Promise<void> {
        const emit = (event: StreamEvent) => onEvent(this.maybe(event));
        const off = this.harness.subscribe((event) => emit(event as unknown as StreamEvent));
        try {
            if (signal?.aborted === true) return;
            if (command.kind === 'cancel') {
                this.harness.room.cancel({
                    keepQueue: command.keepQueue === true,
                    ...(command.botId === undefined ? {} : { botId: command.botId }),
                });
                emit({ kind: 'done' });
                return;
            }
            await this.harness.room.say({ text: command.text, author: HUMAN });
        } catch (error) {
            emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        } finally {
            off();
        }
        emit({ kind: 'done' });
    }

    watch(_entityId: string, onEvent: (event: StreamEvent) => void): () => void {
        return this.harness.subscribe((event) => onEvent(this.maybe(event as unknown as StreamEvent)));
    }

    async sessions(): Promise<SessionInfo[]> {
        return this.maybe(this.harness.room.sessionsInfo() as unknown as SessionInfo[]);
    }

    async compact(botId: string, options: { keepTurns?: number } = {}): Promise<CompactOutcome> {
        const event = await this.harness.room.compact(botId, options);
        const stats = this.harness.room.sessionsInfo().find((info) => info.botId === botId)?.stats;
        return this.maybe({ event, stats } as unknown as CompactOutcome);
    }

    async answerAsk(_entityId: string, askId: string, answer: AskAnswer): Promise<void> {
        this.harness.room.answerAsk(askId, answer);
    }
}
