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

/**
 * 一条附件 ref 的**入参**形状（与 `@diy-agent/attachment` 的 `AttachmentRef` 对齐）。
 *
 * 为什么不直接 `z.unknown()`：附件是网络边界上少有的「形状错了会静默丢图」的输入 ——
 * `relPath` 拼成 `relpath`、`kind` 漏掉，都要在这里就炸，而不是等到模型答非所问。
 * 真源仍在那份 TS 类型 + `parseAttachmentRef`；这里只挡一眼看得出的非法。
 */
const AttachmentRefInput = z.object({
    type: z.enum(['stored', 'linked']),
    id: Id,
    kind: z.enum(['image', 'file', 'archive', 'dir']),
    mime: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    displayName: z.string().min(1),
    source: z.enum(['paste', 'drop', 'pick', 'path', 'url', 'tool', 'relay']),
    createdAt: z.number().int().nonnegative(),
    sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    image: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
    origin: z
        .object({
            url: z.string().optional(),
            toolCallId: z.string().optional(),
            roomId: z.string().optional(),
            originalPath: z.string().optional(),
        })
        .optional(),
    listing: z
        .object({
            count: z.number().int().nonnegative(),
            bytes: z.number().int().nonnegative().optional(),
            sample: z.array(z.string()),
            truncated: z.boolean().optional(),
        })
        .optional(),
    relPath: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
});

/** 一条消息最多带几个附件（挡「把整个相册拖进来」那种） */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

const Attachments = z.array(AttachmentRefInput).max(MAX_ATTACHMENTS_PER_MESSAGE).optional();

export const roomsApi = RpcSchema.group({
    children: {
        /** 列表 + 侧栏投影（hasDraft / pendingAsks / lastActivityAt / unread / broken / failed） */
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
export const botProfilesApi = RpcSchema.group({
    children: {
        list: RpcSchema.unary({ input: {}, output: Any }),
        /**
         * 每个席位一行状态（`BotRow`）：在跑 / 等你回答 / 上一轮出错 / 空闲。
         *
         * 一行 = **房间 × 角色**（成员由类型派生，所以“谁是成员”不用问）。二级浮层与三级
         * 全量表读同一份 —— 不在前端各算一遍，否则「弹层说有 3 个、表格说有 4 个」必然出现。
         */
        rows: RpcSchema.unary({ input: {}, output: Any }),
        /** 批量重试：给选中的 (房间, bot) 各发一条「继续」（已在跑的跳过） */
        retry: RpcSchema.unary({
            input: { targets: z.array(z.object({ roomId: Id, botId: Id })).min(1) },
            output: Any,
        }),
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
        /**
         * 打开房间要的三份：items / deliveries / asks（answered 一起回）。
         *
         * `limit`：只要最近多少条（缺省由服务端定，见 `HISTORY_LIMIT`）；`0` / 负数 = 全量 ——
         * 老客户端不传就是服务端缺省，所以这是**向后兼容**的加法（2026-11-26）。
         */
        history: RpcSchema.unary({ input: { id: Id, limit: z.number().int().optional() }, output: Any }),
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
        /**
         * 发一条消息（受理即返；事件从 /rpc 的 room 流进来）。
         *
         * `text` 允许为空**仅当带了附件**（只贴一张图、一个字不打是最常见的用法）——
         * 这条判据在服务端（handler）和后端 room.say 两处都验：zod 只能看到「空串」，
         * 看不出「有没有附件能顶上」。
         */
        chat: RpcSchema.unary({ input: { id: Id, text: z.string(), attachments: Attachments }, output: Any }),
        cancel: RpcSchema.unary({
            input: { id: Id, botId: z.string().optional() },
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
         * 一条需求的全貌：需求本身 + 它的步骤 + 挂在它上面的决策与其它日志。
         *
         * 为什么单开一个方法而不是 list 一次给全：步骤与决策只在**点开某条需求**时要，
         * 「目标」页首屏只需要需求层（12 个任务 125 条，一次全给等于每 5 秒轮询几百条详情）。
         */
        get: RpcSchema.unary({ input: { id: Id, unit: Id }, output: Any }),
        /**
         * 这条需求**在库里长什么样**（真源，不加工）：`task_units` 的行 + 它的步骤行 + 挂它的日志。
         *
         * 为什么要这个口子（2026-11-27 用户）：「详情里也该看到保存的内容源码吧，是数据库记录还是
         * json？」—— 详情面板是给人看的投影，投影和真源之间必须有一条能当场核对的通道，
         * 否则「界面上少了什么」永远只能靠猜。
         */
        raw: RpcSchema.unary({ input: { id: Id, unit: Id }, output: Any }),
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

/**
 * 附件：**字节进 / 字节出**的唯一两个口子。
 *
 * 为什么走 RPC 而不是静态路由：附件本体在 `<home>/blobs`（数据根），而服务端本来就监听在本机；
 * 一个 `GET /blobs/...` 等于把整个附件库开成无鉴权的静态目录。走 RPC 至少与其它数据同一条
 * 通道、同一套校验（`parseAttachmentRef`），将来加鉴权也只改一处。
 *
 * 为什么是 base64 而不是流：现有 RPC 全是 JSON（`binding.invoke(method, { input })`），
 * 没有二进制通道。剪贴板截图 1~3 MB → base64 后 1.4~4 MB，够用；大文件走 `path`
 * （`source: 'path'` 的引用型附件根本不经过这里）。
 */
export const attachmentApi = RpcSchema.group({
    children: {
        /** 粘贴 / 拖拽进来的字节 → 落 blobs → 返回 ref（mime 由服务端嗅探，不听声明） */
        put: RpcSchema.unary({
            input: {
                /** 原名（下载来的文件用得上；剪贴板图没有） */
                name: z.string().optional(),
                /** 调用方声明的 mime（服务端以魔数为准，这里只是兜底） */
                mime: z.string().optional(),
                /**
                 * base64 内容。**上限 12 MB 的 base64**（≈ 9 MB 原图）：
                 * 再大就该走 `adopt`（引用路径）而不是塞进一次 RPC。
                 */
                base64: z
                    .string()
                    .min(1)
                    .max(12 * 1024 * 1024),
                source: z.enum(['paste', 'drop', 'pick', 'tool']).optional(),
            },
            output: Any,
        }),
        /** 按 ref 取回内容（界面显示缩略图 / 原图）：返回 base64 + mime */
        get: RpcSchema.unary({ input: { ref: AttachmentRefInput }, output: Any }),
    },
});

/**
 * 每个方法「什么时候用」—— `apiHelp()` 的说明来源。
 *
 * 为什么不写在各处 `RpcSchema.unary({ desc })`：38 条并排才看得出「名字是不是撞车了」
 * 「哪几个其实该合并」，而改方法时翻 340 行找定义很容易漏。这张表就是给人看的同一份东西。
 *
 * 写用途不写动作：`rooms.list` 不是「列出房间」，而是「侧栏要什么就一次拿全」。
 * 模型读 apiHelp 是为了判断「该不该用这个」，不是想知道它内部干了什么。
 */
export const METHOD_DESC: Readonly<Record<string, string>> = {
    // —— 房间 ——
    'rooms.list': '侧栏要的一切：名字 / 未读 / 在跑 / 等回答 / 坏没坏 / 最后活动时间',
    'rooms.create': '新建项目或任务房间；任务房间的 data 里放 title / body / dir',
    'rooms.update': '改房间名、换模型、写 data（任务 body 也走这里）',
    'rooms.remove': '删房间；删项目会连带它的任务，返回 deleted 列表',
    'rooms.addMember': '把已有 bot 拉进这个房间（借用别处的 bot）',
    'rooms.markRead': '告诉服务端「我看到第几条了」；只前进不后退',
    // —— 角色（原 bot）——
    'botProfiles.list': '所有角色：名字 / 颜色 / 人格 / 模型 / 归哪类房间',
    'botProfiles.rows': '每个席位一行状态：在跑 / 等回答 / 上一轮出错 / 空闲',
    'botProfiles.create': '造一个角色（= 那类房间里多一个席位）',
    'botProfiles.update': '改角色的名字 / 颜色 / 人格 / 模型 / 默认应答',
    'botProfiles.remove': '删角色（每类至少留一个）',
    'botProfiles.retry': '给选中的 (房间, bot) 各发一条「继续」；已在跑的跳过',
    // —— 对话 ——
    'chat.history': '打开房间的三件套：条目 / 投递 / 待答提问；limit 控返回条数',
    'chat.wait': '等新条目（长轮询）。想在代码里「盯」一件事就用它，别 sleep 轮询',
    'chat.chat': '发一条消息（受理即返，事件从 room 流回来）；text 可空仅当带附件',
    'chat.cancel': '中止某轮（botId 指定谁）；队列里没被处理的一律标「已取消」',
    'chat.sessions': '房间内每个 bot 的会话摘要（轮次 / 用量 / 压缩状态）',
    'chat.compact': '手动压缩这个房间的会话；keepTurns 控保留几轮',
    'chat.cancelCompact': '取消正在进行的压缩',
    // —— 提问 ——
    'asks.list': '这个房间待回答的提问 + 已答过的',
    'asks.answer': '回答问题（选项 / 表单值）',
    'asks.cancel': '撤掉一条提问',
    // —— 附件 ——
    'attachment.put': '把文件内容存进去，拿一个 ref（贴图 / 传日志用）',
    'attachment.get': '按 ref 取回内容',
    // —— 草稿 ——
    'drafts.list': '某个 owner 的输入框草稿',
    'drafts.put': '存草稿（打字时防丢）',
    'drafts.remove': '删草稿',
    // —— 账本 ——
    'journal.list': '这个房间的日志（决策 / 踩坑 / 评审 / 进度）',
    'units.list': '任务账本树（哪些做完、哪些现在能做）',
    'units.text': '账本的纯文本渲染（进提示词用）',
    // —— 引用 ——
    'links.list': '一条记录的引用关系',
    'links.add': '加一条引用',
    'links.remove': '删一条引用',
    // —— 作业 ——
    'jobs.list': '后台作业账本（在跑 / 已结束）',
    'jobs.tail': '取某个作业的输出尾部',
    'jobs.kill': '停掉某个作业（整组）',
    // —— 其它 ——
    'models.list': '可选模型目录（按 provider 分组，带能力位）',
    info: '这个实例是谁：端口 / 数据根 / 版本',
};

export const diy2Api = RpcSchema.group({
    desc: 'diy2 的全部浏览器 API（命令走 unary，房间事件走 /rpc 的 room 流）',
    children: {
        info: RpcSchema.unary({ input: {}, output: Any }),
        rooms: roomsApi,
        botProfiles: botProfilesApi,
        chat: chatApi,
        asks: asksApi,
        drafts: draftsApi,
        journal: journalApi,
        models: modelsApi,
        units: unitsApi,
        links: linksApi,
        jobs: jobsApi,
        attachment: attachmentApi,
    },
});
