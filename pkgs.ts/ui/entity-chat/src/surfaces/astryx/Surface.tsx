// Astryx surface —— 用 Astryx 的 Chat 组件族渲染同一份 ConversationModel。
//
// 与 assistant-ui surface 的区别：不引任何聊天 runtime，消息/工具/输入的"状态机"在 chat-core。
// 这里只做 Item → Astryx 组件 的映射。

import { ChatComposer, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList, ChatSystemMessage, ChatToolCalls } from '@astryxdesign/core';
import * as React from 'react';

import type { Author, Bot, Delivery, Item } from '../../model';
import { conversationOf, useStore } from '../../store';

interface ChatBlock {
    key: string;
    author?: Author;
    texts: string[];
    tools: { name: string; state: 'running' | 'ok' | 'error'; args?: unknown }[];
    streaming: boolean;
}

type Row = { kind: 'user' | 'notice' | 'error' | 'assistant'; item?: Item; block?: ChatBlock };

/**
 * Item[] → 行。多 agent 并发时同一轮的不同 bot 的 item 会按 order 交错，
 * 所以块必须按 (turnId, authorId) 聚合而不是按相邻性切段——否则同一 bot 会被切成两块。
 * @see projection.ts 的 assistant-ui 投影，规则必须一致。
 */
function groupItems(items: Item[]): Row[] {
    const rows: Row[] = [];
    const blocks = new Map<string, ChatBlock>();

    for (const item of items) {
        if (item.type === 'notice') {
            rows.push({ kind: 'notice', item });
            continue;
        }
        if (item.type === 'error') {
            rows.push({ kind: 'error', item });
            continue;
        }
        if (item.author?.role === 'human') {
            rows.push({ kind: 'user', item });
            continue;
        }

        const blockKey = `${item.turnId}:${item.author?.id ?? 'unknown'}`;
        let block = blocks.get(blockKey);
        if (block === undefined) {
            block = { key: blockKey, author: item.author, texts: [], tools: [], streaming: false };
            blocks.set(blockKey, block);
            rows.push({ kind: 'assistant', block });
        }
        if (item.type === 'chat') {
            block.texts.push(item.data.text);
        } else if (item.type === 'tool') {
            block.tools.push({ name: item.data.name, state: item.data.state, args: item.data.args });
        }
        if (item.status === 'streaming') block.streaming = true;
    }
    return rows;
}

function DeliveryChips({ deliveries, bots }: { deliveries: Delivery[]; bots: Record<string, Bot> }) {
    if (deliveries.length === 0) return null;
    return (
        <span className="flex flex-wrap gap-1.5">
            {deliveries.map((delivery) => {
                const bot = bots[delivery.botId];
                const label =
                    delivery.state === 'delivered'
                        ? '已收到'
                        : delivery.state === 'failed'
                          ? '失败'
                          : delivery.state === 'delivering'
                            ? '发送中'
                            : '排队';
                return (
                    <span key={delivery.botId} className="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] opacity-70">
                        <span className="size-1.5 rounded-full" style={{ background: bot?.color ?? '#9ca3af' }} />
                        {bot?.name ?? delivery.botId} {label}
                    </span>
                );
            })}
        </span>
    );
}

export function AstryxSurface({ targetId }: { targetId: string }) {
    const shell = useStore();
    const conversation = conversationOf(targetId);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);
    const [draft, setDraft] = React.useState('');

    const rows = React.useMemo(() => groupItems(state.items), [state.items]);

    return (
        <div data-astryx-theme="neutral" className="flex min-h-0 flex-1 flex-col">
            <ChatLayout
                composer={
                    <ChatComposer
                        value={draft}
                        onChange={setDraft}
                        placeholder="和这个实体对话…"
                        onSubmit={(value) => {
                            conversation.send(value);
                            setDraft('');
                        }}
                        onStop={() => conversation.cancel()}
                        isStopShown={state.running}
                    />
                }
            >
                <ChatMessageList>
                    {rows.map((row) => {
                        if (row.kind === 'notice' && row.item?.type === 'notice') {
                            return (
                                <ChatSystemMessage key={row.item.id} variant="divider">
                                    {row.item.data.text}
                                </ChatSystemMessage>
                            );
                        }
                        if (row.kind === 'error' && row.item?.type === 'error') {
                            return <ChatSystemMessage key={row.item.id}>{row.item.data.message}</ChatSystemMessage>;
                        }
                        if (row.kind === 'user' && row.item !== undefined) {
                            const userItem = row.item;
                            const text = userItem.type === 'chat' ? userItem.data.text : '';
                            const deliveries = state.deliveries.filter((delivery) => delivery.messageId === userItem.id);
                            return (
                                <ChatMessage key={userItem.id} sender="user" name={userItem.author?.name}>
                                    <ChatMessageBubble metadata={<DeliveryChips deliveries={deliveries} bots={shell.bots} />}>{text}</ChatMessageBubble>
                                </ChatMessage>
                            );
                        }
                        const block = row.block;
                        if (block === undefined) return null;
                        return (
                            <ChatMessage key={block.key} sender="assistant" name={block.author?.name}>
                                {block.texts.length > 0 && (
                                    <ChatMessageBubble>
                                        <span className="whitespace-pre-wrap">{block.texts.join('\n\n')}</span>
                                    </ChatMessageBubble>
                                )}
                                {block.tools.length > 0 && (
                                    <ChatToolCalls
                                        calls={block.tools.map((tool, index) => ({
                                            key: `${block.key}-${index}`,
                                            name: tool.name,
                                            status: tool.state === 'running' ? 'running' : tool.state === 'error' ? 'error' : 'complete',
                                            target: tool.args === undefined ? undefined : JSON.stringify(tool.args).slice(0, 80),
                                        }))}
                                    />
                                )}
                            </ChatMessage>
                        );
                    })}
                </ChatMessageList>
            </ChatLayout>
        </div>
    );
}
