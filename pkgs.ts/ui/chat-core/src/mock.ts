// mock.ts —— 与 RpcChatClient 同契约的内存实现：UI 开发/测试/演示不需要后端。
//
// 两种用法：
//   ① 回显模式（缺省）：发什么回什么，逐字符流出来 —— 验输入框、滚动、气泡就够；
//   ② 脚本模式（`seed` / `script`）：按预置步骤产出 tool / notice / ask / error 各种形态 ——
//      工具的折叠行、作业卡片、待答卡、错误条都只能靠它验（它们不来自文本）。
//
// 为什么不用 shadcn 的 `@shadcn/helpers/ai-sdk`（2026-11-26 查证）：那套产出 `UIMessage[]`
// 并靠 `@ai-sdk/react` 的 `useChat` 流动，而我们的对话是 RPC 事件流 → ConversationStore →
// TimelineEntry，不吃 AI SDK 协议。接它等于为 fixture 引一整套 AI SDK。同一个目的，
// 我们只需要「造 Item 与 AskRequest」，成本是这里的几十行。

import type { ChatClient } from './client';
import type { AskRequest, Command, Item, JobNotice, Snapshot, StreamEvent } from './types';

const HUMAN = { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' as const };
const BOT = { id: 'bot:mock', name: 'mock', color: '#7cc4ff', role: 'bot' as const };

/**
 * 一条脚本步骤 —— 对应界面上的一种可验形态。
 *
 * 刻意贴着 `Item` 的 type 命名（chat / tool / notice / error），只多一个 `ask`：
 * ask 不是 Item（它走 Snapshot.asks 另一条路），但在时间线上会长成一张卡。
 */
export type MockStep =
    | { kind: 'chat'; text: string; author?: 'human' | 'bot' }
    | {
          kind: 'tool';
          name: string;
          args?: unknown;
          result?: unknown;
          state?: 'running' | 'ok' | 'error';
      }
    | { kind: 'notice'; text: string; noticeKind?: string; job?: JobNotice }
    | { kind: 'error'; message: string }
    | { kind: 'ask'; request: AskRequest };

export interface MockOptions {
    /** 每个字符的间隔（ms）；0 = 立即返回全文 */
    tickMs?: number;
    /** 固定回复；缺省按输入回显 */
    reply?: (text: string) => string;
    /** 一开始就在快照里的条目（刷新即见，不用先发消息） */
    seed?: MockStep[];
    /** 收到一条消息之后按序产出（给了它就覆盖缺省的回显行为） */
    script?: MockStep[];
}

/** 供 parity 测试/Storybook 使用的脚本化客户端 */
export class MockChatClient implements ChatClient {
    private seq = 0;
    private readonly items = new Map<string, Item[]>();
    private readonly asks = new Map<string, AskRequest[]>();

    constructor(private readonly options: MockOptions = {}) {}

    async load(entityId: string, _options?: { limit?: number }): Promise<Snapshot> {
        // seed 只是「第一次 load 之前把条目铺好」，铺过就不再重复
        if (this.options.seed !== undefined && !this.items.has(entityId)) {
            const seeds = this.options.seed;
            this.items.set(entityId, []);
            for (const step of seeds) {
                // ask 不进 items：它走 Snapshot.asks，时间线由 chat-core 归并成卡片
                if (step.kind === 'ask') {
                    const list = this.asks.get(entityId) ?? [];
                    this.asks.set(entityId, [...list, step.request]);
                    continue;
                }
                this.push(entityId, this.stepToItem(step));
            }
        }
        return { items: this.items.get(entityId) ?? [], deliveries: [], asks: this.asks.get(entityId) ?? [] };
    }

    async post(entityId: string, command: Command, onEvent: (event: StreamEvent) => void): Promise<void> {
        if (command.kind === 'cancel') {
            onEvent({ kind: 'done' });
            return;
        }

        const now = Date.now();
        const turn = (this.items.get(entityId)?.at(-1)?.turn ?? 0) + 1;
        const turnId = `turn-mock-${now}`;

        const userItem = this.makeItem(entityId, turn, turnId, now, {
            kind: 'chat',
            text: command.text,
            author: 'human',
        });
        this.push(entityId, userItem);
        onEvent({ kind: 'item', item: userItem });

        if (this.options.script !== undefined) {
            // 脚本模式：按序产出。ask 只进快照的 asks（时间线由 chat-core 归并），不进 items
            for (const step of this.options.script) {
                if (step.kind === 'ask') {
                    const list = this.asks.get(entityId) ?? [];
                    this.asks.set(entityId, [...list, step.request]);
                    continue;
                }
                const item = this.makeItem(entityId, turn, turnId, now, step);
                this.push(entityId, item);
                onEvent({ kind: 'item', item });
                await new Promise((resolve) => setTimeout(resolve, this.options.tickMs ?? 0));
            }
            onEvent({ kind: 'done' });
            return;
        }

        const text = this.options.reply?.(command.text) ?? `收到：${command.text}`;
        const botItem = this.makeItem(entityId, turn, turnId, now, { kind: 'chat', text: '', author: 'bot' });
        botItem.status = 'streaming';
        this.push(entityId, botItem);
        onEvent({ kind: 'item', item: botItem });

        const tick = this.options.tickMs ?? 16;
        if (tick <= 0) {
            botItem.data = { text };
            botItem.status = 'done';
            this.push(entityId, botItem);
            onEvent({ kind: 'item', item: botItem });
        } else {
            for (let index = 1; index <= text.length; index += 2) {
                await new Promise((resolve) => setTimeout(resolve, tick));
                botItem.data = { text: text.slice(0, index) };
                onEvent({ kind: 'item', item: botItem });
            }
            botItem.status = 'done';
            this.push(entityId, botItem);
            onEvent({ kind: 'item', item: botItem });
        }
        onEvent({ kind: 'done' });
    }

    private makeItem(entityId: string, turn: number, turnId: string, at: number, step: MockStep): Item {
        void entityId;
        return this.stepToItem(step, { seq: ++this.seq, turn, turnId, at: at + this.seq });
    }

    /** MockStep → Item（seed 与 script 共用；ask 不在这里，它不进 items） */
    private stepToItem(
        step: MockStep,
        base: { seq: number; turn: number; turnId: string; at: number } = {
            seq: ++this.seq,
            turn: 1,
            turnId: 'turn-seed',
            at: Date.now(),
        },
    ): Item {
        const head = {
            id: `i-${base.seq}`,
            seq: base.seq,
            turn: base.turn,
            turnId: base.turnId,
            at: base.at,
            status: 'done' as const,
        };
        switch (step.kind) {
            case 'chat':
                return {
                    ...head,
                    author: step.author === 'human' ? HUMAN : BOT,
                    type: 'chat',
                    data: { text: step.text },
                };
            case 'tool':
                return {
                    ...head,
                    author: BOT,
                    type: 'tool',
                    data: {
                        name: step.name,
                        state: step.state ?? 'ok',
                        ...(step.args === undefined ? {} : { args: step.args }),
                        ...(step.result === undefined ? {} : { result: step.result }),
                    },
                };
            case 'notice':
                return {
                    ...head,
                    type: 'notice',
                    data: {
                        text: step.text,
                        kind: step.noticeKind ?? 'info',
                        ...(step.job === undefined ? {} : { job: step.job }),
                    },
                };
            case 'error':
                return { ...head, type: 'error', data: { message: step.message } };
            case 'ask':
                // ask 不该走到这里（调用方已拦），给一个不会静默出错的替身
                return { ...head, type: 'notice', data: { text: `(ask ${step.request.askId})`, kind: 'info' } };
        }
    }

    private push(entityId: string, item: Item): void {
        const list = this.items.get(entityId) ?? [];
        const index = list.findIndex((existing) => existing.id === item.id);
        this.items.set(
            entityId,
            index < 0 ? [...list, item] : list.map((existing) => (existing.id === item.id ? item : existing)),
        );
    }
}
