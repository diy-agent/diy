/**
 * api.ts —— diy2 的**完整 RPC 面**（浏览器侧的唯一 API）。
 *
 * 为什么放在 protocol：服务端（apps/diy2）与客户端（chat-transport / entity-chat）
 * 必须拿同一棵树 —— 方法名、入参形状、哪些是流，只有一份定义。protocol 本来就是
 * 两端共用的协议层（纯 TS + zod，无 node / UI 依赖）。
 *
 * 输出大多用 `z.unknown()`：领域对象（Room / Item / Snapshot…）的形状在 protocol 里
 * 已有 TS 类型，这里不重复定义一遍 zod（重复就会漂移）；调用方在边界处断言类型。
 * **入参**仍然逐字段校验 —— 那是网络边界，错误必须在这里拦。
 *
 * 挂载：服务端 `server.use({ prefix: 'diy2', api: diy2Api, handlers })`；
 * 客户端 `createTypedClient(binding, diy2Api, { prefix: 'diy2' })`。
 */

import { RpcSchema } from '@diy-agent/rpc';
import { z } from 'zod';

const Any = z.unknown();
const Id = z.string().min(1);
const Data = z.record(z.string(), Any);

export const roomsApi = RpcSchema.group({
    children: {
        /** 列表 + 侧栏投影（hasDraft / pendingAsks / lastActivityAt） */
        list: RpcSchema.unary({ input: {}, output: Any }),
        create: RpcSchema.unary({
            input: {
                name: z.string().min(1),
                type: z.enum(['project', 'task']).optional(),
                modelKey: z.string().optional(),
                data: Data.optional(),
            },
            output: Any,
        }),
        update: RpcSchema.unary({
            input: {
                id: Id,
                name: z.string().optional(),
                modelKey: z.string().optional(),
                data: Data.optional(),
            },
            output: Any,
        }),
        /** 返回 { id, deleted: string[] }（项目连带任务） */
        remove: RpcSchema.unary({ input: { id: Id }, output: Any }),
        /** 把已有 bot 拉进房间（借用） */
        addMember: RpcSchema.unary({ input: { id: Id, botId: Id }, output: Any }),
    },
});

export const botsApi = RpcSchema.group({
    children: {
        list: RpcSchema.unary({ input: {}, output: Any }),
        create: RpcSchema.unary({
            input: { name: z.string().min(1), homeRoomId: z.string().optional(), modelKey: z.string().optional() },
            output: Any,
        }),
        /** 改 bot（名字 / 人格 / 模型 / 归属） */
        update: RpcSchema.unary({
            input: {
                id: Id,
                name: z.string().optional(),
                color: z.string().optional(),
                persona: z.string().optional(),
                modelKey: z.string().optional(),
                homeRoomId: z.string().optional(),
            },
            output: Any,
        }),
        remove: RpcSchema.unary({ input: { id: Id }, output: Any }),
    },
});

export const chatApi = RpcSchema.group({
    children: {
        /** 打开房间要的三份：items / deliveries / asks（answered 一起回） */
        history: RpcSchema.unary({ input: { id: Id }, output: Any }),
        /** 发一条消息（受理即返；事件从 /rpc 的 room 流进来） */
        chat: RpcSchema.unary({ input: { id: Id, text: z.string().min(1) }, output: Any }),
        cancel: RpcSchema.unary({
            input: { id: Id, keepQueue: z.boolean().optional(), botId: z.string().optional() },
            output: Any,
        }),
        sessions: RpcSchema.unary({ input: { id: Id }, output: Any }),
        compact: RpcSchema.unary({ input: { id: Id, botId: Id }, output: Any }),
    },
});

export const asksApi = RpcSchema.group({
    children: {
        list: RpcSchema.unary({ input: { id: Id }, output: Any }),
        answer: RpcSchema.unary({ input: { id: Id, askId: Id, answer: Any }, output: Any }),
        cancel: RpcSchema.unary({ input: { id: Id, askId: Id }, output: Any }),
    },
});

export const draftsApi = RpcSchema.group({
    children: {
        list: RpcSchema.unary({ input: { owner: Id }, output: Any }),
        put: RpcSchema.unary({ input: { owner: Id, field: Id, value: Any }, output: Any }),
        remove: RpcSchema.unary({ input: { owner: Id, field: Id }, output: Any }),
    },
});

export const journalApi = RpcSchema.group({
    children: {
        list: RpcSchema.unary({ input: { id: Id, limit: z.number().int().positive().optional() }, output: Any }),
    },
});

export const linksApi = RpcSchema.group({
    children: {
        list: RpcSchema.unary({ input: { id: Id }, output: Any }),
        add: RpcSchema.unary({ input: { id: Id, to: Id, kind: z.string().optional() }, output: Any }),
        remove: RpcSchema.unary({ input: { id: Id, to: Id, kind: Id }, output: Any }),
    },
});

export const diy2Api = RpcSchema.group({
    desc: 'diy2 的全部浏览器 API（命令走 unary，房间事件走 /rpc 的 room 流）',
    children: {
        info: RpcSchema.unary({ input: {}, output: Any }),
        rooms: roomsApi,
        bots: botsApi,
        chat: chatApi,
        asks: asksApi,
        drafts: draftsApi,
        journal: journalApi,
        links: linksApi,
    },
});
