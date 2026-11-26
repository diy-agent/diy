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
        /** 列表 + 侧栏投影（hasDraft / pendingAsks / lastActivityAt / unread） */
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
        // 「把已有 bot 拉进房间」没了：成员 = 类型角色表（2026-11-24 裁）。
        // 要往某类房间里加人 ⇒ 去角色页给那个类型建一个角色，该类所有房间同时生效。
        /**
         * 上报「这个房间我看到 seq 了」（未读水位，2026-11-26）。
         *
         * 客户端在**房间打开且页面可见**时上报（`seq` 不传 = 推到这个房间当前最后一条）；
         * 服务端只前进不后退（迟到的旧上报不能把水位拉回去，否则那个房间永远有未读）。
         *
         * `seq` 留成可选是故意的：UI 表达的是“我在看这个房间”，它没有理由知道全局 seq。
         */
        markRead: RpcSchema.unary({
            input: { id: Id, seq: z.number().int().nonnegative().optional() },
            output: Any,
        }),
    },
});

/**
 * 角色（原 bots）：**全局表**，每行 = 某个工作对象类型上的固定席位。
 *
 * 改一个角色 ⇒ 该类型的所有房间同时变（成员是派生的，没有「加入/退出房间」这回事）。
 * `modelKey` / `reasoningEffort` 传 null 表示「清空 → 继续继承」。
 */
export const rolesApi = RpcSchema.group({
    children: {
        list: RpcSchema.unary({ input: {}, output: Any }),
        create: RpcSchema.unary({
            input: {
                type: z.string().min(1),
                name: z.string().min(1),
                color: z.string().min(1).optional(),
                instructions: z.string().optional(),
                modelKey: z.string().nullable().optional(),
                reasoningEffort: z.string().nullable().optional(),
                primary: z.boolean().optional(),
            },
            output: Any,
        }),
        /** 改角色；`type` 不改（改类型 = 换一套房间，等于新建一个再删掉旧的） */
        update: RpcSchema.unary({
            input: {
                id: Id,
                name: z.string().min(1).optional(),
                color: z.string().min(1).optional(),
                instructions: z.string().optional(),
                modelKey: z.string().nullable().optional(),
                reasoningEffort: z.string().nullable().optional(),
                primary: z.boolean().optional(),
            },
            output: Any,
        }),
        /** 删角色；某类型最后一个角色不许删（否则那类房间没人应答） */
        remove: RpcSchema.unary({ input: { id: Id }, output: Any }),
        /** 类型默认配置（2026-11-26）：几百个 bot 共享一套 model / effort，bot 只存 override */
        config: RpcSchema.group({
            children: {
                list: RpcSchema.unary({ input: {}, output: Any }),
                set: RpcSchema.unary({
                    input: {
                        type: z.string().min(1),
                        modelKey: z.string().nullable().optional(),
                        reasoningEffort: z.string().nullable().optional(),
                    },
                    output: Any,
                }),
            },
        }),
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
        /**
         * 手动压缩；`keepTurns` = 面板上的「保留最近几轮」（缺省 = 全局常量）。
         *
         * 没有 `maxChars`：压缩上限是全局常量，不由一次手工操作去动它
         * （2026-11-25 对齐 diy1 的 keepRounds —— 用户能调的只有「留多少轮」）。
         */
        compact: RpcSchema.unary({
            input: {
                id: Id,
                botId: Id,
                keepTurns: z.number().int().min(0).optional(),
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

/**
 * 任务的需求账本树（要做成哪些东西）。**只读**：writer 只有 agent 的 `unit_*` 工具，
 * 界面是旁观窗口。
 */
export const unitsApi = RpcSchema.group({
    children: {
        list: RpcSchema.unary({ input: { id: Id }, output: Any }),
        /**
         * 模型实际读到的那段文本（`units` 节的 YAML）。
         *
         * 为什么要开这个口子：界面能画树、能画图，但「模型到底读到了什么」此前只能靠 demo 推断。
         * 文本由 `unitsContextValue()` 生成、`toYaml()` 落字 —— 与上下文注入同一份代码，
         * 所以这里显示的不是「另一种表达」，就是原文。
         */
        text: RpcSchema.unary({ input: { id: Id }, output: Any }),
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
/** 一个模型的覆盖字段（`model.yaml` 的 `<group>.<provider>.models.<id>`） */
const ModelPatchInput = z.object({
    name: z.string().optional(),
    contextWindow: z.number().optional(),
    cost: z
        .object({
            input: z.number(),
            output: z.number(),
            cacheRead: z.number().optional(),
            cacheWrite: z.number().optional(),
        })
        .optional(),
});

export const modelsApi = RpcSchema.group({
    children: {
        list: RpcSchema.unary({ input: {}, output: Any }),
        /**
         * 配置页的整页快照（含目录里**还没接**的 provider）。
         *
         * 与 `list` 不合成一条：`list` 只要「现在能选什么」，回包小、每次都要拉；
         * 这里要「目录里还有什么、哪些被关掉了」，只在打开配置页 / 写完时拉。
         */
        config: RpcSchema.unary({ input: {}, output: Any }),
        // 写方法的回包一律是**重算后的整页快照**（`saveAccount` 多一个 `{ saved }`）：
        // 界面不必自己拼第二份状态，也就不会出现「服务端改了、界面还是老的」。
        saveProvider: RpcSchema.unary({
            input: {
                providerId: Id,
                kind: z.enum(['std', 'custom']).optional(),
                /** 只对 custom 有效（std 的 spec 来自目录快照，不走手填） */
                spec: z
                    .object({ id: z.string().optional(), npm: z.string().optional(), api: z.string().optional() })
                    .optional(),
                models: z.record(z.string(), ModelPatchInput).optional(),
                /** `null` = 删掉这个键；空数组也当删（空白名单 = 全关，没人想要这个） */
                filter: z
                    .object({
                        include: z.array(z.string()).nullable().optional(),
                        exclude: z.array(z.string()).nullable().optional(),
                    })
                    .optional(),
            },
            output: Any,
        }),
        removeProvider: RpcSchema.unary({ input: { providerId: Id }, output: Any }),
        /** `value` 是唯一会流进来的 key；回包只有 `chars` */
        saveAccount: RpcSchema.unary({
            input: {
                providerId: Id,
                name: z.string().min(1),
                value: z.string().min(1),
                /** 配置里还没有这家时先建段（界面的「连接」） */
                kind: z.enum(['std', 'custom']).optional(),
            },
            output: Any,
        }),
        renameAccount: RpcSchema.unary({
            input: { providerId: Id, from: z.string().min(1), to: z.string().min(1) },
            output: Any,
        }),
        removeAccount: RpcSchema.unary({ input: { providerId: Id, name: z.string().min(1) }, output: Any }),
        /** `null` = 清掉 `defaultModel`（回落到「没设」，界面不猜一个） */
        saveDefaultModel: RpcSchema.unary({ input: { modelKey: z.string().nullable() }, output: Any }),
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
        roles: rolesApi,
        chat: chatApi,
        asks: asksApi,
        drafts: draftsApi,
        journal: journalApi,
        models: modelsApi,
        units: unitsApi,
        links: linksApi,
        jobs: jobsApi,
    },
});
