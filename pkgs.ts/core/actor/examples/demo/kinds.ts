// kinds.ts — 示范用的两个 kind（和真实产品同形：房间 + 成员会话）。
//
// 刻意保持小：每个 kind 只装「协议要证明的那一件事」。
//   demo.peer  单个会话：状态 + 一个命令 + 一个查询（被扇出问的那个子查询）
//   demo.room  房间：消息（只追加）+ 成员名册（扇出到各成员所在节点）
//
// 口径与 docs/ 一致：`data` 里只有业务字段；`type` 只说执行成没成；
// 摆放（哪个成员在哪个 target）只在 room 的 state 里，调用方不许指定。

import { z } from 'zod';

import { defineKind } from '../../src/index.js';

const PeerState = z.object({
    label: z.string(),
    /** 这个会话此刻有没有在跑（扇出要读的那一位） */
    running: z.boolean(),
});

export const peerKind = defineKind({
    name: 'demo.peer',
    state: PeerState,
    initial: ({ uri }) => ({ label: uri.split('/').pop() ?? uri, running: false }),
    events: { changed: PeerState },
})
    .command('set', { input: PeerState, output: PeerState }, (ctx, input) => ({
        output: input,
        state: input,
        events: [{ name: 'changed', data: input }],
    }))
    .query('live', { input: z.object({}), output: PeerState }, (ctx) => ({ ...ctx.state }))
    .build();

const Message = z.object({
    /** 第几条（= 位置，不是 id；消息不改不删，所以位置就是身份） */
    n: z.number().int().positive(),
    text: z.string().min(1),
    at: z.number().int().nonnegative(),
});

const MemberRef = z.object({
    memberId: z.string().min(1),
    /** 这个成员所在节点的地址（只有 actor 知道；调用方看不到，也不需要） */
    target: z.string().min(1),
});

const RoomState = z.object({
    messages: z.array(Message),
    members: z.array(MemberRef),
});

/** 名册里每个成员的状态：**三态**，`unknown` 不是「没有这个成员」 */
const MemberLive = z.object({
    memberId: z.string().min(1),
    state: z.enum(['running', 'idle', 'unknown']),
    label: z.string().optional(),
    /** 只在 `unknown` 时有值：为什么没读到（执行轴 code） */
    reason: z.string().optional(),
});

export const roomKind = defineKind({
    name: 'demo.room',
    state: RoomState,
    initial: () => ({ messages: [], members: [] }),
    events: {
        posted: Message,
        joined: MemberRef,
    },
})
    .command(
        'post',
        { input: z.object({ text: z.string().min(1) }), output: z.object({ n: z.number().int() }) },
        (ctx, input) => {
            const message = { n: ctx.state.messages.length + 1, text: input.text, at: ctx.now };
            return {
                output: { n: message.n },
                state: { ...ctx.state, messages: [...ctx.state.messages, message] },
                events: [{ name: 'posted', data: message }],
            };
        },
    )
    .command('join', { input: MemberRef, output: z.void() }, (ctx, input) => ({
        state: {
            ...ctx.state,
            // 同一个 memberId 再 join = 换地址（重绑定），不是加两个成员
            members: [...ctx.state.members.filter((m) => m.memberId !== input.memberId), input],
        },
        events: [{ name: 'joined', data: input }],
    }))
    .query('read', { input: z.object({}), output: z.object({ messages: z.array(Message) }) }, (ctx) => ({
        messages: ctx.state.messages,
    }))
    .fanoutQuery('roster', {
        input: z.object({}),
        output: z.object({ members: z.array(MemberLive) }),
        subquery: 'live',
        targets: (ctx) => ctx.state.members.map((m) => ({ target: m.target, memberId: m.memberId })),
        aggregate: ({ ctx, results }) => ({
            members: ctx.state.members.map((m) => {
                const hit = results.find((r) => r.target.memberId === m.memberId);
                // 每个成员在 results 里必有一项（要么 answered，要么带 code）
                if (!hit) return { memberId: m.memberId, state: 'unknown' as const, reason: 'E_INTERNAL' };
                if (!hit.answered) return { memberId: m.memberId, state: 'unknown' as const, reason: hit.code };
                const live = hit.value as z.output<typeof PeerState>;
                return {
                    memberId: m.memberId,
                    state: live.running ? ('running' as const) : ('idle' as const),
                    label: live.label,
                };
            }),
        }),
    })
    .build();
