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
        /** 把已有 bot 拉进房间（借用） */
        addMember: RpcSchema.unary({ input: { id: Id, botId: Id }, output: Any }),
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

export const botsApi = RpcSchema.group({
    children: {
        list: RpcSchema.unary({ input: {}, output: Any }),
        /**
         * 每 bot 一行状态（在跑 / 等回答 / 上一轮出错 / 空闲）：
         * 二级弹层与三级表格都读它 —— 两处一份数据，不会一个说有 3 个、一个说有 4 个。
         */
        rows: RpcSchema.unary({ input: {}, output: Any }),
        /** 批量重试：给选中的 (房间, bot) 各发一条「继续」（已在跑的跳过） */
        retry: RpcSchema.unary({
            input: { targets: z.array(z.object({ roomId: Id, botId: Id })).min(1) },
            output: Any,
        }),
        create: RpcSchema.unary({
            input: {
                name: z.string().min(1),
                homeRoomId: z.string().optional(),
                modelKey: z.string().min(1).optional(),
            },
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
        /**
         * 等房间出现新条目（长轮询）。
         *
         * 给 agent 自己的循环用：全是 unary 的 RPC 面下，`run_code` 想「盯」一件事
         * 只能 `sleep` 轮询 —— 短了浪费轮次、长了错过时机。这条把「等」变成一次调用。
         * 有新条目立即返回；等到 `timeoutMs` 没动静就 `timedOut: true`（**不算错误**）。
         */
        wait: RpcSchema.unary({
            input: {
                id: Id,
                /** 只要 seq 大于它的条目；缺省 0 = 从第一条起（调用方通常传上一轮的 `seq`） */
                sinceSeq: z.number().int().min(0).optional(),
                /**
                 * 最多等多久（毫秒）；缺省 10s，封顶 120s（再长就该转后台作业）。
                 *
                 * 缺省值要**明显小于** `run_code` 的 30s 预算：两者叠着用时（代码里 `await` 它），
                 * 等得比外层预算长就变成「一用就撞超时」—— 而且 `vm` 杀不掉 await 之后的等待。
                 */
                timeoutMs: z.number().int().min(0).max(120_000).optional(),
            },
            output: Any,
        }),
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
        units: unitsApi,
        links: linksApi,
        jobs: jobsApi,
    },
});
