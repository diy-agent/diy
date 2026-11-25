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
                modelKey: z.string().min(1).optional(),
                data: Data.optional(),
            },
            output: Any,
        }),
        update: RpcSchema.unary({
            input: {
                id: Id,
                name: z.string().optional(),
                modelKey: z.string().min(1).optional(),
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
            input: { name: z.string().min(1), homeRoomId: z.string().optional(), modelKey: z.string().min(1).optional() },
            output: Any,
        }),
        /** 改 bot（名字 / 人格 / 模型 / 归属） */
        update: RpcSchema.unary({
            input: {
                id: Id,
                name: z.string().optional(),
                color: z.string().optional(),
                persona: z.string().optional(),
                modelKey: z.string().min(1).optional(),
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
        /** 手动压缩；keepLast / maxChars = 面板上的「保留条数 / 预算」（缺省用启动配置） */
        compact: RpcSchema.unary({
            input: {
                id: Id,
                botId: Id,
                keepLast: z.number().int().min(1).optional(),
                maxChars: z.number().int().min(1).optional(),
            },
            output: Any,
        }),
        /**
         * 撤掉一次正在跑的压缩（摘要那个 LLM 调用挂 AbortSignal）。
         *
         * compactId 来自 `compact` 的返回或 `compact` 事件。已经跑完 / 没这个 id →
         * `{ ok: false }` 而不报错：手点慢一点不该变成一条错误提示。
         */
        cancelCompact: RpcSchema.unary({ input: { id: Id, compactId: Id }, output: Any }),
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

/**
 * 模型目录：真源是 `model.yaml`（`~/.diy/model.yaml` → `@diy-agent/model-catalog`）。
 *
 * 为什么由服务端答、而不是界面自带一张表：界面那份 `PROVIDERS`（端点 / 价目 / 上下文窗口）
 * 会与真配置各自演进，「界面上能选、服务端发不出去」就是这么来的。key 值永不出服务端 ——
 * 账号只有名字与「填没填」。
 */
export const modelsApi = RpcSchema.group({
    children: {
        list: RpcSchema.unary({ input: {}, output: Any }),
    },
});

/**
 * 后台作业（run 表）：**「现在在跑什么」的唯一出口**。
 *
 * 在此之前这张表只能由 agent 通过 `job list` 工具问出来 —— 人看不见，只能等它说完。
 * 界面要的是同一份事实，所以开一个只读投影 + 一个停：口径仍然只有 `job-tool` 那一套
 * （`list` / `kill` 与工具同名同义，文案真源 `run-status.ts`）。
 */
export const jobsApi = RpcSchema.group({
    children: {
        /** 全部 run（活着的在前），带时长 / 命令 / 归属 */
        list: RpcSchema.unary({ input: {}, output: Any }),
        /** 按进程组停止（只有运行中的才可停；返回是否真的发了信号） */
        kill: RpcSchema.unary({ input: { id: Id }, output: Any }),
        /**
         * 一条 run 的输出尾巴（与 `job output` 同一个 `tailOf`）。
         *
         * 界面「明细」里的那段输出用：列表行只够写「跑了多久、退出码几」，
         * 「它到底说了什么」必须能翻 —— 否则出事时人还得回头求 agent 去调工具。
         */
        tail: RpcSchema.unary({ input: { id: Id, lines: z.number().int().positive().optional() }, output: Any }),
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
        models: modelsApi,
        links: linksApi,
        jobs: jobsApi,
    },
});
