// server/app.ts —— diy2 的 HTTP/SSE 适配层：**只产出 handler，不 listen**。
//
// 领域逻辑全在 `RoomActor`（entity-runtime/src/room.ts）：成员、路由、结论、
// 回合与顺序、会话池、压缩。这里只做四件事：
//   1. 解析请求 / 回 JSON
//   2. 房间订阅（同一房间多个请求共享一条 SSE）
//   3. 把 RoomActor 的事件转成 SSE
//   4. 进程内的房间与 bot 装配（种子数据）
//
// 为什么不再是「import 即 listen」（##dev-app 构建对齐）：老写法把「监听哪个端口 / 读哪个
// 数据根 / 要不要静态服务」焊死在模块顶层，于是三个入口（bin/diy2、tsx 直跑、vite）各写一份
// 装配逻辑，端口散在 5 处。现在端口 / 数据根 / 变体只从 `./config` 来（唯一真源），
// 监听由调用方做：`server/index.ts`（生产）、`server/dev.ts`（单端口 dev）、`bin/diy2`（全局命令）。

import { type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createStaticHandler } from './static';
import { createStreamHub } from './stream';
import { APP_ID, type Diy2Config } from './config';

import { JOURNAL_KINDS, RoomActor, openStore } from '@diy-agent/entity-runtime';
import type { CompactEvent, RoomEvent } from '@diy-agent/entity-runtime';
import type { AskQuestionAnswer, Author, Bot, Room } from '@diy-agent/protocol';

const DEFAULT_MODEL = 'chen56@opencode-go/deepseek-v4.1-flash';
/** 提问卡草稿：提问早就有了结局（或从时间线上消失）这么久，就不再算"未提交输入" */
const ASK_DRAFT_TTL = 30 * 60 * 1000;
/** 对话框草稿：synthetic owner 不随房间级联删，超过这么久没人再来就清掉 */
const DIALOG_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
const HUMAN: Author = { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' };
const COLORS = ['#7cc4ff', '#f7b267', '#a3e635', '#f472b6', '#c084fc', '#38bdf8'];

/**
 * 装配期状态：原本是模块顶层的 const（import 即装配 → import 即 listen）。
 * 现在由 `createDiy2App(config)` 一次写入 —— 一个进程只装一次（dev 改服务端代码靠重启进程，
 * 不靠热替换），所以模块级 let 足够；把 700 行闭包化只会淹掉真正的改动。
 */
let config: Diy2Config;
let store: ReturnType<typeof openStore>;
let serveStatic: ReturnType<typeof createStaticHandler>;
/** `/api/info` 的回包工厂（由 `createDiy2App` 装配：端口要问调用方，模块层答不出） */
let info: () => Diy2AppInfo;

// ─── 房间装配 ─────────────────────────────────────────────────────

/** roomId → 聚合根（房间的领域对象） */
let rooms = new Map<string, RoomActor>();
/**
 * 话题上推的帧：房间领域事件 + 传输层的收尾帧。
 *
 * `done` 不属于房间（`RoomEvent` 里剔除它），它是「这条话题到头了」的传输层信号 ——
 * 以前「一条流一个房间」时靠关连接表达，现在连接是共用的，只能靠帧说。
 */
type RoomFrame = RoomEvent | { kind: 'done' };

/**
 * 一条房间事件的去向。以前它就是「一个 ServerResponse = 一条连接」，于是
 * 「谁在看这个房间」和「谁占着一条连接」是同一件事 —— 多页工作台必然撑爆连接数。
 * 现在它只是个函数：多路复用的那条连接把它写成一帧带话题的 SSE（见 ./stream）。
 */
type Sink = (event: RoomFrame) => void;
let subscribers = new Map<string, Set<Sink>>();

function attach(roomId: string, sink: Sink): () => void {
    let set = subscribers.get(roomId);
    if (set === undefined) {
        set = new Set();
        subscribers.set(roomId, set);
    }
    set.add(sink);
    return () => {
        set?.delete(sink);
        if (set !== undefined && set.size === 0) subscribers.delete(roomId);
    };
}

function broadcast(roomId: string, payload: RoomFrame): void {
    for (const sink of subscribers.get(roomId) ?? []) sink(payload);
}

/**
 * 话题名 → 房间 id。多路复用的连接上订阅的是话题（`room:<id>`），
 * 不是路径 —— 一条连接要能同时承载多个房间，就不能让路径决定订阅什么。
 */
const ROOM_TOPIC = 'room:';
const roomTopic = (roomId: string): string => `${ROOM_TOPIC}${roomId}`;
function roomOfTopic(topic: string): string | undefined {
    return topic.startsWith(ROOM_TOPIC) ? topic.slice(ROOM_TOPIC.length) : undefined;
}

/**
 * 多路复用：一个 app 实例的所有页面、所有房间共用**一条** SSE。
 *
 * 一条房间话题只在有人听时接到广播上（`onFirstSubscriber`），最后一个订阅者离开就摘掉：
 * 没人看的房间不该还占着一条连接的空位 —— 那正是老实现里 6 条攒满的原因。
 */
const hub = createStreamHub({
    onFirstSubscriber(topic, push) {
        const roomId = roomOfTopic(topic);
        if (roomId === undefined) return undefined;
        if (roomOf(roomId) === undefined) return undefined;
        return attach(roomId, (event) => {
            push(event);
        });
    },
});

/** 房间的工作目录：自己的 data.dir，任务则继承所属项目 */
function cwdOf(spec: Room): string | undefined {
    const own = spec.data['dir'];
    if (typeof own === 'string' && own !== '') return expandHome(own);
    const projectId = spec.data['projectId'];
    const parent =
        typeof projectId === 'string' ? [...rooms.values()].find((actor) => actor.spec.id === projectId) : undefined;
    const parentDir = parent?.spec.data['dir'];
    return typeof parentDir === 'string' && parentDir !== '' ? expandHome(parentDir) : undefined;
}

function expandHome(dir: string): string {
    return dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir;
}

function actorOf(spec: Room): RoomActor {
    let actor = rooms.get(spec.id);
    if (actor === undefined) {
        const cwd = cwdOf(spec);
        actor = new RoomActor({
            spec,
            store,
            bots: () => store.listBots(),
            emit: (event) => broadcast(spec.id, event),
            budget: config.compact,
            onCompact: (bot, event) => logCompact(spec.id, bot, event),
            ...(cwd === undefined ? {} : { cwd }),
            home: config.home,
            shell: config.tools !== 'files',
        });
        rooms.set(spec.id, actor);
        // 运行时新建的容器也要落库：不落的话重启后侧栏里就没了（消息还在，只是没入口）
        store.saveRoom(spec);
    }
    return actor;
}

/** 压缩是一等事件：改预算前先看这行 */
function logCompact(roomId: string, bot: Bot, event: CompactEvent): void {
    const before = `${event.before.entries}msgs/${event.before.chars}c`;
    const after = `${event.after.entries}msgs/${event.after.chars}c`;
    const usage = event.usage === undefined ? '' : ` usage=${event.usage.inputTokens}/${event.usage.outputTokens}`;
    console.log(
        `[compact] ${bot.name} @${roomId} turn=${event.turn} ${event.strategy} ${before} → ${after} ` +
            `folded=${event.folded} dropped=${event.dropped} ${event.durationMs}ms${usage}`,
    );
}

function roomOf(id: string): RoomActor | undefined {
    return rooms.get(id);
}

// ─── 种子：bot 落 sqlite；项目/任务先在内存 ────────────────────────

function seed(): void {
    let bots = store.listBots();
    if (bots.length === 0) {
        const create = (name: string, homeRoomId: string, persona: string): Bot => {
            const bot: Bot = {
                id: `bot-${Date.now().toString(36)}-${bots.length + 1}`,
                name,
                color: COLORS[bots.length % COLORS.length]!,
                persona,
                homeRoomId,
                modelKey: DEFAULT_MODEL,
            };
            store.upsertBot(bot);
            return bot;
        };
        const diy = create('diy', 'proj:diy', '项目 bot：工程视角，先结论后理由。');
        const cops = create('cops', 'proj:cops', '项目 bot：产品视角，拆需求、写验收。');
        const task = create('任务树与多会话', 'task:t-001', '任务 bot：运维视角，可观测性与回滚。');
        const xiaoman = create('小满', 'proj:diy', '产品视角：拆需求、找边界、写验收。');
        bots = [diy, cops, task, xiaoman];
    }

    const byName = (name: string): Bot | undefined => bots.find((bot) => bot.name === name);
    const specs: Room[] = [
        {
            id: 'proj:diy',
            type: 'project',
            name: 'diy',
            data: { dir: '~/git/diy/diy' },
            members: [
                { botId: byName('diy')?.id ?? bots[0]!.id, primary: true },
                { botId: byName('小满')?.id ?? bots[0]!.id },
            ],
            modelKey: DEFAULT_MODEL,
        },
        {
            id: 'proj:cops',
            type: 'project',
            name: 'cops',
            data: { dir: '~/git/cops' },
            members: [{ botId: byName('cops')?.id ?? bots[1]!.id, primary: true }],
            modelKey: DEFAULT_MODEL,
        },
        {
            id: 'task:t-001',
            type: 'task',
            name: '任务树与多会话',
            data: { dir: '~/git/diy/diy', projectId: 'proj:diy', status: 'open' },
            members: [{ botId: byName('任务树与多会话')?.id ?? bots[2]!.id, primary: true }],
            modelKey: DEFAULT_MODEL,
        },
    ];

    // 恢复成员关系（重启后 @ 仍生效）
    const saved = store.members();

    // 1) 落库的容器优先：运行时新建的项目/任务，重启后原样回来
    for (const room of store.listRooms()) {
        const index = specs.findIndex((spec) => spec.id === room.id);
        if (index >= 0) {
            const seedSpec = specs[index]!;
            specs[index] = {
                ...seedSpec,
                ...room,
                data: { ...seedSpec.data, ...room.data },
                members: room.members.length > 0 ? room.members : seedSpec.members,
            };
        } else {
            specs.push(room);
        }
    }

    // 2) 老库兼容：rooms 表是后加的，之前只落了成员。成员表里有、房间表里没有的，
    //    按主 bot 还原一个容器 —— 消息本来就还在磁盘上，别让它们没有入口。
    const known = new Set(specs.map((spec) => spec.id));
    for (const [roomId, members] of Object.entries(saved)) {
        if (known.has(roomId)) continue;
        const primary = members.find((member) => member.primary === true) ?? members[0];
        const bot = primary === undefined ? undefined : bots.find((entry) => entry.id === primary.botId);
        specs.push({
            id: roomId,
            type: roomId.startsWith('task') ? 'task' : 'project',
            name: bot?.name ?? roomId,
            data: {},
            members,
            modelKey: bot?.modelKey ?? DEFAULT_MODEL,
        });
    }

    for (const spec of specs) {
        const members = saved[spec.id];
        if (members !== undefined && members.length > 0) spec.members = members;
        store.setMembers(spec.id, spec.members);
        store.saveRoom(spec);
        actorOf(spec).recover();
    }
}

// 装配动作（seed + 草稿清理）在 `createDiy2App` 里做：顶层语句等于「import 即启动」，
// 而 import 的时机不再由本模块决定（生产入口 / dev 入口 / bin 都可能先 import）。

// ─── 工具 ─────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

/**
 * 读 body 的统一入口：坏 JSON / 读流失败都要有回包。
 * 之前每个 `void readBody(...).then(...)` 都没 catch —— 客户端发一段坏 JSON
 * 就是"请求永不响应 + unhandled rejection"，Node 默认把后者当崩溃。
 */
function onBody<T>(req: IncomingMessage, res: ServerResponse, handler: (body: T) => void | Promise<void>): void {
    readBody<T>(req)
        .then(handler)
        .catch(() => {
            if (!res.writableEnded) json(res, 400, { error: 'invalid JSON body' });
        });
}

/**
 * synthetic scope 的 owner 白名单（`dlg:<用途>:<roomId>`）：`dlg:` 是保留前缀，
 * 房间 id 是 `<type>-<base36>` / `proj:xxx`，不会撞上。
 */
const DIALOG_DRAFT_OWNER = /^dlg:[a-z][a-z0-9-]{0,40}:[A-Za-z0-9:._-]{1,120}$/;

/** 单条草稿上限：超了宁可拒（413）也不静默截断用户打的字 */
function tooLargeDraft(value: unknown): boolean {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > 256 * 1024;
}

function newBot(name: string, homeRoomId: string, persona: string): Bot {
    return {
        id: `bot-${Date.now().toString(36)}`,
        name,
        color: COLORS[store.listBots().length % COLORS.length]!,
        persona,
        homeRoomId,
        modelKey: DEFAULT_MODEL,
    };
}

// ─── 路由 ─────────────────────────────────────────────────────────

const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    try {
        // GET /api/info —— 实例自报身份（探活判据：`app` + `home`）。端口/pid 都是缓存，
        // 「谁在监听这个端口、用哪个数据根」只有监听者自己答得准（仓库 ##328 同一现场）。
        if (req.method === 'GET' && url.pathname === '/api/info') {
            json(res, 200, info());
            return;
        }

        // GET /api/stream —— **一个 app 实例一条**事件流（首帧交身份，之后靠订阅说要看什么）
        //
        // 为什么不再「一个房间一条流」：浏览器同源 HTTP/1.1 只有 6 条连接且按 profile 算，
        // 多页工作台里 3 个聊天页就能把配额吃满，之后连 /history 都永久排队。
        if (req.method === 'GET' && url.pathname === '/api/stream') {
            hub.handle(req, res);
            return;
        }

        // POST /api/stream/subscribe | /unsubscribe —— 在这条连接上增减话题
        //
        // SSE 是单工的，订阅只能另开一个请求；身份（conn）由首帧下发，不接受客户端自造 id。
        if (
            req.method === 'POST' &&
            (url.pathname === '/api/stream/subscribe' || url.pathname === '/api/stream/unsubscribe')
        ) {
            const subscribing = url.pathname.endsWith('/subscribe');
            onBody<{ conn?: string; topic?: string }>(req, res, (body) => {
                const conn = body.conn ?? '';
                const topic = body.topic ?? '';
                const roomId = roomOfTopic(topic);
                if (roomId === undefined) return json(res, 400, { error: 'unknown topic' });
                if (subscribing && roomOf(roomId) === undefined) return json(res, 404, { error: 'room not found' });
                if (!subscribing) {
                    hub.unsubscribe(conn, topic);
                    json(res, 200, { ok: true });
                    return;
                }
                // 404 = 「这条连接已经不在了」：客户端据此知道等下一次重连再订，不用重试
                const hit = hub.subscribe(conn, topic);
                json(res, hit ? 200 : 404, hit ? { ok: true } : { error: 'no such connection' });
            });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/rooms') {
            // hasDraft / pendingAsks / lastActivityAt 都是列表页的投影字段（侧栏 ✎ / ? / 最后活动），
            // 不属于 Room 领域类型。
            // 草稿分两类各归各的标记：✎ 只认输入类（发言框 / 对话框表单），? 认提问 ——
            // 提问填了一半不该点亮 ✎（卡片就在时间线上，行上再点一个 ✎ 是噪音）。
            const draftOwners = store.draftOwnersByKind();
            const withInputDraft = new Set(draftOwners.input);
            const lastItemAt = store.lastItemAtByRoom();
            json(
                res,
                200,
                [...rooms.values()].map((actor) => {
                    const id = actor.spec.id;
                    const at = lastItemAt[id];
                    const pendingAsks = actor.pendingAsks();
                    return {
                        ...actor.spec,
                        hasDraft: withInputDraft.has(id),
                        ...(pendingAsks === 0 ? {} : { pendingAsks }),
                        ...(at === undefined ? {} : { lastActivityAt: at }),
                    };
                }),
            );
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/bots') {
            json(res, 200, store.listBots());
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/bots') {
            onBody<{ name?: string; homeRoomId?: string; modelKey?: string }>(req, res, (body) => {
                const name = (body.name ?? '').trim();
                if (name === '') return json(res, 400, { error: 'name required' });
                const bot = newBot(name, body.homeRoomId ?? 'proj:diy', 'room 成员 bot');
                store.upsertBot({ ...bot, ...(body.modelKey === undefined ? {} : { modelKey: body.modelKey }) });
                roomOf(bot.homeRoomId)?.addMember(bot.id);
                json(res, 200, bot);
            });
            return;
        }

        // POST /api/rooms —— 新建任意类型的容器（默认 bot 同名）
        if (req.method === 'POST' && url.pathname === '/api/rooms') {
            onBody<{ type?: string; name?: string; modelKey?: string; data?: Record<string, unknown> }>(
                req,
                res,
                (body) => {
                    const name = (body.name ?? '').trim();
                    if (name === '') return json(res, 400, { error: 'name required' });
                    const type = body.type ?? 'project';
                    // 任务必须挂在项目下：侧栏按 projectId 分组，没归属的任务等于隐身
                    const projectId = body.data?.['projectId'];
                    if (type === 'task' && (typeof projectId !== 'string' || roomOf(projectId) === undefined)) {
                        return json(res, 400, { error: 'task 需要有效的 data.projectId' });
                    }
                    // 默认模型由 UI 传（SettingsDialog 的那份）；没传才用服务端兜底
                    const modelKey = body.modelKey ?? DEFAULT_MODEL;
                    const id = `${type}-${Date.now().toString(36)}`;
                    const bot = { ...newBot(name, id, `${type} bot`), modelKey };
                    store.upsertBot(bot);
                    const spec: Room = {
                        id,
                        type,
                        name,
                        // 任务默认 open（GitHub 语义：新开的就是 open，两态）；缺省不该是空白
                        data: type === 'task' ? { status: 'open', ...body.data } : (body.data ?? {}),
                        members: [{ botId: bot.id, primary: true }],
                        modelKey,
                    };
                    store.setMembers(id, spec.members);
                    actorOf(spec);
                    json(res, 200, spec);
                },
            );
            return;
        }

        // PATCH /api/rooms/:id —— 改名 / 改房间模型 / 改 data（任务状态、描述…）
        if (req.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'rooms' && parts.length === 3) {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            onBody<{ name?: string; modelKey?: string; data?: Record<string, unknown> }>(req, res, (body) => {
                actor.update({
                    ...(body.name === undefined ? {} : { name: body.name }),
                    ...(body.modelKey === undefined ? {} : { modelKey: body.modelKey }),
                    ...(body.data === undefined ? {} : { data: body.data }),
                });
                json(res, 200, actor.spec);
            });
            return;
        }

        /**
         * DELETE /api/rooms/:id —— 删容器。
         *
         * 项目连带它的任务一起删：侧栏按 projectId 分组，留下任务就是一堆「未归属」孤儿
         * （数据还在、名字还占着，用户以为自己没删干净）。
         * 专属 bot（homeRoomId 在这个容器里、删完不再被任何容器引用）一并清掉 ——
         * 不清的话 AddMemberDialog 里会越积越多出幽灵 bot。
         */
        if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'rooms' && parts.length === 3) {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            const victims =
                actor.spec.type === 'project'
                    ? [
                          id,
                          ...[...rooms.values()]
                              .filter((entry) => entry.spec.data['projectId'] === id)
                              .map((entry) => entry.spec.id),
                      ]
                    : [id];
            for (const roomId of victims) {
                rooms.get(roomId)?.stop();
                rooms.delete(roomId);
                store.deleteRoom(roomId);
                // 订阅者（多页工作台里正看着这个房间的页）先收一句 done，再把话题从连接上摘掉：
                // 房间没了，再往这条话题上推事件没有意义
                broadcast(roomId, { kind: 'done' });
                // 话题摘掉时订阅者会各自 detach（attach 返回的那个函数）
                hub.drop(roomTopic(roomId));
            }
            const removed = new Set(victims);
            const referenced = new Set([...rooms.values()].flatMap((entry) => entry.spec.members.map((m) => m.botId)));
            for (const bot of store.listBots()) {
                if (removed.has(bot.homeRoomId) && !referenced.has(bot.id)) store.deleteBot(bot.id);
            }
            json(res, 200, { id, deleted: victims });
            return;
        }

        // POST /api/rooms/:id/bots —— 加入已有 bot（借用）
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'bots') {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            onBody<{ botId?: string }>(req, res, (body) => {
                if (body.botId !== undefined) actor.addMember(body.botId);
                json(res, 200, actor.spec);
            });
            return;
        }

        /**
         * /api/drafts/:owner[/:field] —— synthetic scope 的未提交输入。
         *
         * 对话框（新建任务的描述）在提交之前**没有实体 id**：它既不是某个房间的内容，
         * 又必须扛住误关 / 切面 / 刷新。owner 就用 `dlg:<用途>:<roomId>` 这种保留前缀，
         * 和房间草稿共用一张表、一套语义，但不进 `hasDraft`（侧栏 ✎ 说的是"房间里"）。
         *
         * 只放行我们自己的前缀：别让这个接口变成任意键值仓库。
         */
        if (parts[0] === 'api' && parts[1] === 'drafts' && (parts.length === 3 || parts.length === 4)) {
            const owner = decodeURIComponent(parts[2] ?? '');
            if (!DIALOG_DRAFT_OWNER.test(owner)) return json(res, 400, { error: 'invalid draft owner' });
            const field = parts.length === 4 ? decodeURIComponent(parts[3] ?? '') : '';
            if (req.method === 'GET' && parts.length === 3) {
                json(res, 200, { drafts: store.listDrafts(owner) });
                return;
            }
            if (field === '' || field.length > 128) return json(res, 400, { error: 'invalid draft field' });
            if (req.method === 'DELETE') {
                store.deleteDraft(owner, field);
                json(res, 200, { ok: true });
                return;
            }
            if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' });
            onBody<{ value?: unknown }>(req, res, (body) => {
                if (!('value' in body)) return json(res, 400, { error: 'value required' });
                if (tooLargeDraft(body.value)) return json(res, 413, { error: 'draft too large (max 256KB)' });
                const saved = store.putDraft(owner, field, body.value);
                json(res, 200, { updatedAt: saved?.updatedAt ?? 0 });
            });
            return;
        }

        // GET /api/rooms/:id/drafts —— 这个容器里所有未提交输入（composer / ask:<id>）
        if (
            req.method === 'GET' &&
            parts[0] === 'api' &&
            parts[1] === 'rooms' &&
            parts[3] === 'drafts' &&
            parts.length === 4
        ) {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            // 打开房间顺手自愈：正常结局由 room 的 `settleAsk` 直接删（那是主路径），
            // 这里只兜底「提问从时间线上彻底消失了、没人替它清」的残留 ——
            // 还在等回答的保留，其余旧草稿清掉，避免 ? / ✎ 为一个不存在的提问亮着
            store.pruneAskDrafts(
                id,
                new Set(actor.pendingAskRequests().map((request) => request.askId)),
                Date.now() - ASK_DRAFT_TTL,
            );
            json(res, 200, { drafts: store.listDrafts(id) });
            return;
        }

        // PUT /api/rooms/:id/drafts/:field —— 写一条草稿；值没有内容 = 删除
        // DELETE 同义，给"清空"一个不用带 body 的入口
        if (
            (req.method === 'PUT' || req.method === 'DELETE') &&
            parts[0] === 'api' &&
            parts[1] === 'rooms' &&
            parts[3] === 'drafts' &&
            parts.length === 5
        ) {
            const id = decodeURIComponent(parts[2] ?? '');
            const field = decodeURIComponent(parts[4] ?? '');
            if (roomOf(id) === undefined) return json(res, 404, { error: 'room not found' });
            if (field === '' || field.length > 128) return json(res, 400, { error: 'invalid draft field' });
            if (req.method === 'DELETE') {
                store.deleteDraft(id, field);
                json(res, 200, { ok: true });
                return;
            }
            onBody<{ value?: unknown }>(req, res, (body) => {
                if (!('value' in body)) return json(res, 400, { error: 'value required' });
                if (tooLargeDraft(body.value)) return json(res, 413, { error: 'draft too large (max 256KB)' });
                const saved = store.putDraft(id, field, body.value);
                json(res, 200, { updatedAt: saved?.updatedAt ?? 0 });
            });
            return;
        }

        // GET /api/rooms/:id/history?afterSeq=
        if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'history') {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            json(res, 200, { items: actor.items(Number(url.searchParams.get('afterSeq') ?? '0')) });
            return;
        }

        // ── 任务日志（append-only）────────────────────────────────────
        // GET  /api/rooms/:id/journal?limit=  → { entries }
        // POST /api/rooms/:id/journal { kind, text } → { entry }
        if (parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'journal' && parts.length === 4) {
            const id = decodeURIComponent(parts[2] ?? '');
            if (roomOf(id) === undefined) return json(res, 404, { error: 'room not found' });
            if (req.method === 'GET') {
                const raw = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
                const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 50;
                json(res, 200, { entries: store.journalOf(id, limit) });
                return;
            }
            if (req.method === 'POST') {
                onBody<{ kind?: string; text?: string }>(req, res, (body) => {
                    const text = (body.text ?? '').trim();
                    if (text === '') return json(res, 400, { error: 'text required' });
                    const kind = body.kind ?? 'progress';
                    if (!(JOURNAL_KINDS as readonly string[]).includes(kind)) {
                        return json(res, 400, { error: `kind 必须是 ${JOURNAL_KINDS.join(' / ')}` });
                    }
                    const entry = store.appendJournal(id, { kind: kind as (typeof JOURNAL_KINDS)[number], text });
                    json(res, 200, { entry });
                });
                return;
            }
        }

        if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'deliveries') {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            json(res, 200, { deliveries: actor.deliveries() });
            return;
        }

        // 以前这里是 `GET /api/rooms/:id/events`（一个房间一条常驻 SSE）。现在房间是
        // `/api/stream` 上的话题（`room:<id>`）：一条连接就能看多个房间，见 ./stream。

        // GET /api/rooms/:id/asks —— 还在等用户回答的提问
        if (
            req.method === 'GET' &&
            parts[0] === 'api' &&
            parts[1] === 'rooms' &&
            parts[3] === 'asks' &&
            parts.length === 4
        ) {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            json(res, 200, { asks: actor.pendingAskRequests(), answered: actor.answeredAskRequests() });
            return;
        }

        // GET /api/rooms/:id/sessions —— 每个成员的上下文概况 + 最近的压缩事件
        if (
            req.method === 'GET' &&
            parts[0] === 'api' &&
            parts[1] === 'rooms' &&
            parts[3] === 'sessions' &&
            parts.length === 4
        ) {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            json(res, 200, { sessions: actor.sessionsInfo() });
            return;
        }

        // POST /api/rooms/:id/sessions/:botId/compact —— 手动压一次（只影响这个成员）
        if (
            req.method === 'POST' &&
            parts[0] === 'api' &&
            parts[1] === 'rooms' &&
            parts[3] === 'sessions' &&
            parts[5] === 'compact'
        ) {
            const id = decodeURIComponent(parts[2] ?? '');
            const botId = decodeURIComponent(parts[4] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            void readBody<{ keepLast?: number; maxChars?: number }>(req)
                .catch(() => ({}) as { keepLast?: number; maxChars?: number })
                .then(async (body) => {
                    const event = await actor.compact(botId, {
                        ...(body.keepLast === undefined ? {} : { keepLast: body.keepLast }),
                        ...(body.maxChars === undefined ? {} : { maxChars: body.maxChars }),
                    });
                    json(res, 200, { event, stats: actor.sessionsInfo().find((info) => info.botId === botId)?.stats });
                })
                .catch((error: unknown) => json(res, 400, { error: String(error) }));
            return;
        }

        // POST /api/rooms/:id/asks/:askId/cancel —— 撤回一问（不想答了，卡片失效）
        // 与回答路由靠段数区分（这条 6 段、那条 5 段），先后无关；但两条都认 parts[3] === 'asks'，
        // 新加 asks 子路由时记得把段数写进条件，别只判 parts[3]。
        if (
            req.method === 'POST' &&
            parts[0] === 'api' &&
            parts[1] === 'rooms' &&
            parts[3] === 'asks' &&
            parts[5] === 'cancel'
        ) {
            const id = decodeURIComponent(parts[2] ?? '');
            const askId = decodeURIComponent(parts[4] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            const hit = actor.cancelAsk(askId);
            json(
                res,
                hit ? 200 : 404,
                hit ? { ok: true, pending: actor.pendingAsks() } : { error: 'no such pending ask' },
            );
            return;
        }

        // POST /api/rooms/:id/asks/:askId —— 回答一次提问（整批一次提交）
        // body: { answers: [{ id, values?, fields?, text?, skipped? }] }
        //
        // 三态返回：200 收下 / 404 这一问已失效 / 400 题对不上（少一题、多一题、旧题集）。
        // 400 必须与 404 分开：前者该提示“刷新一下重答”，后者是“这张卡已经没了”，
        // 混成一个只会让用户对着旧卡片反复重试。
        if (
            req.method === 'POST' &&
            parts[0] === 'api' &&
            parts[1] === 'rooms' &&
            parts[3] === 'asks' &&
            parts.length === 5
        ) {
            const id = decodeURIComponent(parts[2] ?? '');
            const askId = decodeURIComponent(parts[4] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            onBody<{ answers?: AskQuestionAnswer[] }>(req, res, (body) => {
                const outcome = actor.answerAsk(askId, { answers: body.answers ?? [] });
                if (outcome.ok) return json(res, 200, { ok: true });
                if (outcome.code === 'bad-answer') return json(res, 400, { error: outcome.reason });
                return json(res, 404, { error: 'no such pending ask' });
            });
            return;
        }

        // POST /api/rooms/:id/chat —— 投一条消息；事件走 /api/stream 的 `room:<id>` 话题
        //
        // 为什么只回 JSON 不等这一轮：以前这个 POST 本身就是那条 SSE，一直挂到整轮结束（可能
        // 十几分钟），于是每句插话各占一条连接 —— 多页工作台里几条插话就是几次上限。
        // 现在「受理」与「说完」分开：受理立刻回，事件一律走那条共用连接，
        // 所以 `say()` 失败不能再用响应状态表达，改用广播一条 error（UI 已有这条路）。
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'chat') {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });

            onBody<{ text?: string; recipients?: string[]; mode?: 'next-step' | 'next-turn' }>(req, res, (body) => {
                const text = (body.text ?? '').trim();
                if (text === '') return json(res, 400, { error: 'text required' });

                json(res, 200, { ok: true });
                void actor
                    .say({
                        text,
                        author: HUMAN,
                        ...(body.recipients === undefined ? {} : { recipients: body.recipients }),
                        ...(body.mode === undefined ? {} : { mode: body.mode }),
                    })
                    .catch((error: unknown) => {
                        broadcast(id, {
                            kind: 'error',
                            message: error instanceof Error ? error.message : String(error),
                        });
                    });
            });
            return;
        }

        // POST /api/rooms/:id/cancel —— 停止这个房间所有在跑的会话
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'cancel') {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            onBody<{ keepQueue?: boolean; botId?: string }>(req, res, (body) => {
                actor.cancel({
                    keepQueue: body.keepQueue === true,
                    ...(body.botId === undefined ? {} : { botId: body.botId }),
                });
                json(res, 200, { ok: true });
            });
            return;
        }

        // 静态资源 / SPA 路由：/api 之外的 GET 交给 UI 产物
        if (req.method === 'GET' && !url.pathname.startsWith('/api') && serveStatic !== undefined) {
            if (serveStatic(url.pathname, res)) return;
        }

        json(res, 404, { error: `unknown ${req.method ?? '?'} ${url.pathname}` });
    } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
};

// ─── 装配入口（唯一） ──────────────────────────────────────────────

/** `/api/info` 的回包；`port` 为 null = 还没监听（dev 的 SSR 预装配阶段） */
export interface Diy2AppInfo {
    app: typeof APP_ID;
    pid: number;
    port: number | null;
    home: string;
    env: string;
    variant: string;
    launch: string | null;
    name: string | null;
    tools: 'shell' | 'files';
}

export interface Diy2App {
    handle: (req: IncomingMessage, res: ServerResponse) => void;
    info: () => Diy2AppInfo;
    /** 关闭所有 SSE 订阅（进程退出 / dev 重启前调用；sqlite 由进程退出收尾） */
    close: () => void;
}

/**
 * 装配一个 diy2 应用（**不监听端口**）。
 *
 * @param opts.config 运行配置（`./config` 的唯一真源）
 * @param opts.webDir 静态服务目录：`null` = 明确不要（dev 交给 vite）；`undefined` = 用 config 的
 * @param opts.port   实际监听端口（`() => server.address().port`；dev 单端口时由调用方给）
 */
export function createDiy2App(opts: {
    config: Diy2Config;
    webDir?: string | null | undefined;
    port?: () => number | null;
}): Diy2App {
    config = opts.config;
    // null 与 undefined 是两件事：null = 「我明确不要静态服务」（dev 的页面来自 vite），
    // undefined = 「按配置来」（生产）。写成 `??` 会让 dev 在 build/lab/web 存在时**悄悄**
    // 拿到上一轮的旧壳子 —— 那种 bug 只能靠肉眼分辨「为什么改了 UI 没变」。
    serveStatic = createStaticHandler(opts.webDir === null ? undefined : (opts.webDir ?? config.webDir));
    rooms = new Map();
    subscribers = new Map();

    mkdirSync(config.home, { recursive: true });
    store = openStore(config.dbPath);

    seed();

    // 对话框草稿的 owner 是 synthetic scope（`dlg:<用途>:<roomId>`）：删项目时已级联，
    // 剩下的（用户再也不打开那个对话框 / 房间 id 早就换掉）靠 TTL 收，别让库只增不减。
    const prunedDialogs = store.pruneDraftOwners('dlg:', Date.now() - DIALOG_DRAFT_TTL);
    if (prunedDialogs > 0) console.log(`[drafts] 清掉 ${prunedDialogs} 条过期对话框草稿`);

    info = (): Diy2AppInfo => ({
        app: APP_ID,
        pid: process.pid,
        port: opts.port?.() ?? (config.port === 0 ? null : config.port),
        home: config.home,
        env: config.env,
        variant: config.variant,
        launch: config.launch,
        name: config.name,
        tools: config.tools,
    });

    const close = (): void => {
        hub.close();
        subscribers.clear();
    };

    return { handle, info, close };
}
