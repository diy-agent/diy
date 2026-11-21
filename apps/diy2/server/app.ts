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
import type { Duplex } from 'node:stream';

import { createStaticHandler } from './static';
import { createRpcSocket, type RpcStreamInfo } from './rpc';
import { APP_ID, type Diy2Config } from './config';

import { JOURNAL_KINDS, RoomActor, createJobRegistry, newEntityId, openStore } from '@diy-agent/entity-runtime';
import type { CompactEvent, RoomEvent } from '@diy-agent/entity-runtime';
import { ChannelServerBinding, type HandlersOf } from '@diy-agent/rpc';
import { diy2Api } from '@diy-agent/protocol';
import type { AskAnswer, AskQuestionAnswer, Author, Bot, Room } from '@diy-agent/protocol';

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
 * 后台作业账本：**进程级一张表**（`bash(background)` 起的 run 与 `job` 工具查的是同一份）。
 * 收口通知按归属串 `<roomId>#<botId>` 回到对应房间 —— 房间不在（已删 / 别的进程起的）就静默。
 */
let jobs: ReturnType<typeof createJobRegistry>;
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

/** 关系里「另一边」怎么显示：任务 `#12 标题`、项目名字、其它实体（未来的插件类型）退回 id */
function labelOf(id: string): { label: string; type: string } {
    const task = store.taskOf(id);
    if (task !== undefined) return { label: `#${task.number} ${task.title}`, type: 'task' };
    const project = store.projectOf(id);
    if (project !== undefined) return { label: project.name, type: 'project' };
    return { label: id, type: store.entityOf(id)?.type ?? 'unknown' };
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
            jobs: { registry: jobs },
            ...(config.maxSteps === undefined ? {} : { maxSteps: config.maxSteps }),
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

/** RPC 版取房间：不存在就抛（HTTP 路由那边是 json 404，这里是异常） */
function requireRoom(id: string): RoomActor {
    const actor = roomOf(id);
    if (actor === undefined) throw new Error(`房间不存在：${id}`);
    return actor;
}

// ─── 种子：bot 落 sqlite；项目/任务先在内存 ────────────────────────

function seed(): void {
    let bots = store.listBots();
    if (bots.length === 0) {
        const create = (name: string, homeRoomId: string, persona: string): Bot => {
            const bot: Bot = {
                id: newEntityId(),
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
            data: { name: 'diy', dir: '~/git/diy/diy' },
            members: [
                { botId: byName('diy')?.id ?? bots[0]!.id, primary: true },
                { botId: byName('小满')?.id ?? bots[0]!.id },
            ],
            modelKey: DEFAULT_MODEL,
        },
        {
            id: 'proj:cops',
            type: 'project',
            data: { name: 'cops', dir: '~/git/cops' },
            members: [{ botId: byName('cops')?.id ?? bots[1]!.id, primary: true }],
            modelKey: DEFAULT_MODEL,
        },
        {
            id: 'task:t-001',
            type: 'task',
            data: { title: '任务树与多会话', dir: '~/git/diy/diy', projectId: 'proj:diy', status: 'open' },
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
            data: roomId.startsWith('task') ? { title: bot?.name ?? roomId } : { name: bot?.name ?? roomId },
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
        id: newEntityId(),
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
    /** 入口名（老字段名 variant 仍然保留给读者，值 = launch） */
    variant: string;
    launch: string | null;
    name: string | null;
    tools: 'shell' | 'files';
}

export interface Diy2App {
    handle: (req: IncomingMessage, res: ServerResponse) => void;
    /**
     * 处理一条 HTTP upgrade（`/rpc` 归这里，返回 true；其余返回 false 交给别人 ——
     * dev 里 vite 的 HMR 也走 upgrade 通道，**不要动不是自己的 socket**）。
     */
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
    /** 当前 WS 连接与它们正在订阅的房间（dev app / 排查用） */
    rpcStreams: () => RpcStreamInfo[];
    info: () => Diy2AppInfo;
    /** 关闭所有 SSE / WS 订阅（进程退出 / dev 重启前调用；sqlite 由进程退出收尾） */
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

    // 作业账本要在 `seed()` / 首个房间之前建好：`actorOf` 装配工具时要用它。
    // 根目录 `<home>/log/job/runs`：与其余运行产物同根，清 home 就清干净。
    jobs = createJobRegistry({
        rootDir: join(config.home, 'log', 'job', 'runs'),
        onDone: (event, owner) => rooms.get(owner.roomId)?.notifyJobDone(owner, event),
    });

    seed();

    // 对话框草稿的 owner 是 synthetic scope（`dlg:<用途>:<roomId>`）：删项目时已级联，
    // 剩下的（用户再也不打开那个对话框 / 房间 id 早就换掉）靠 TTL 收，别让库只增不减。
    const prunedDialogs = store.pruneDraftOwners('dlg:', Date.now() - DIALOG_DRAFT_TTL);
    if (prunedDialogs > 0) console.log(`[drafts] 清掉 ${prunedDialogs} 条过期对话框草稿`);

    /**
     * diy2 的**命令面**（RPC）。与 REST 并存到客户端全部切完（P2a），之后删 REST。
     *
     * handler 直接复用路由里的同一套领域操作，不再经过 req/res —— 错误用异常表达，
     * 由 rpc 传输层转成错误帧（HTTP 那边是 4xx/5xx）。
     */
    type Diy2Handlers = HandlersOf<typeof diy2Api>;

    const bindDiy2Api = (server: ChannelServerBinding): void => {
        const handlers: Diy2Handlers = {
            info: async () => info(),
            rooms: {
                list: async () => {
                    const draftOwners = store.draftOwnersByKind();
                    const withInputDraft = new Set(draftOwners.input);
                    const lastItemAt = store.lastItemAtByRoom();
                    return [...rooms.values()].map((actor) => {
                        const id = actor.spec.id;
                        const at = lastItemAt[id];
                        const pendingRequests = actor.pendingAskRequests();
                        const pendingAsks = pendingRequests.length;
                        return {
                            ...actor.spec,
                            hasDraft: withInputDraft.has(id),
                            ...(pendingAsks === 0 ? {} : { pendingAsks }),
                            // 带题干：侧栏 ? 的 tooltip 要说清「问的是什么」，只说个数进房间还得自己翻
                            ...(pendingAsks === 0
                                ? {}
                                : {
                                      pendingAskTitles: pendingRequests.map(
                                          (request) => request.questions[0]?.question ?? '',
                                      ),
                                  }),
                            ...(at === undefined ? {} : { lastActivityAt: at }),
                        };
                    });
                },
                create: async ({ input }) => {
                    const type = input.type ?? 'project';
                    const projectId = input.data?.['projectId'];
                    if (type === 'task' && (typeof projectId !== 'string' || roomOf(projectId) === undefined)) {
                        throw new Error('task 需要有效的 data.projectId');
                    }
                    const modelKey = input.modelKey ?? DEFAULT_MODEL;
                    const id = newEntityId();
                    const bot = { ...newBot(input.name, id, `${type} bot`), modelKey };
                    store.upsertBot(bot);
                    const spec: Room = {
                        id,
                        type,
                        // 容器名跟着容器走：任务的标题 / 项目的名字都在 data 里
                        data:
                            type === 'task'
                                ? { status: 'open', title: input.name, ...input.data }
                                : { name: input.name, ...input.data },
                        members: [{ botId: bot.id, primary: true }],
                        modelKey,
                    };
                    store.setMembers(id, spec.members);
                    actorOf(spec);
                    return store.listRooms().find((room) => room.id === id) ?? spec;
                },
                update: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    // 容器的名字落在自己的键上：任务叫 title，项目叫 name
                    const namePatch =
                        input.name === undefined ? {} : { [actor.spec.type === 'task' ? 'title' : 'name']: input.name };
                    actor.update({
                        ...(input.modelKey === undefined ? {} : { modelKey: input.modelKey }),
                        ...(input.name === undefined && input.data === undefined
                            ? {}
                            : { data: { ...namePatch, ...input.data } }),
                    });
                    return actor.spec;
                },
                remove: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    const victims =
                        actor.spec.type === 'project'
                            ? [
                                  input.id,
                                  ...[...rooms.values()]
                                      .filter((entry) => entry.spec.data['projectId'] === input.id)
                                      .map((entry) => entry.spec.id),
                              ]
                            : [input.id];
                    for (const roomId of victims) {
                        rooms.get(roomId)?.stop();
                        rooms.delete(roomId);
                        store.deleteRoom(roomId);
                        broadcast(roomId, { kind: 'done' });
                    }
                    const removed = new Set(victims);
                    const referenced = new Set(
                        [...rooms.values()].flatMap((entry) => entry.spec.members.map((m) => m.botId)),
                    );
                    for (const bot of store.listBots()) {
                        if (removed.has(bot.homeRoomId) && !referenced.has(bot.id)) store.deleteBot(bot.id);
                    }
                    return { id: input.id, deleted: victims };
                },
                addMember: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    actor.addMember(input.botId);
                    return actor.spec;
                },
            },
            bots: {
                list: async () => store.listBots(),
                create: async ({ input }) => {
                    const name = input.name.trim();
                    if (name === '') throw new Error('name required');
                    const bot = newBot(name, input.homeRoomId ?? 'proj:diy', 'room 成员 bot');
                    store.upsertBot({ ...bot, ...(input.modelKey === undefined ? {} : { modelKey: input.modelKey }) });
                    roomOf(bot.homeRoomId)?.addMember(bot.id);
                    return bot;
                },
                update: async ({ input }) => {
                    const bot = store.listBots().find((entry) => entry.id === input.id);
                    if (bot === undefined) throw new Error(`bot 不存在：${input.id}`);
                    const next = {
                        ...bot,
                        ...(input.name === undefined ? {} : { name: input.name }),
                        ...(input.color === undefined ? {} : { color: input.color }),
                        ...(input.persona === undefined ? {} : { persona: input.persona }),
                        ...(input.modelKey === undefined ? {} : { modelKey: input.modelKey }),
                        ...(input.homeRoomId === undefined ? {} : { homeRoomId: input.homeRoomId }),
                    };
                    store.upsertBot(next);
                    return next;
                },
                remove: async ({ input }) => {
                    store.deleteBot(input.id);
                    return { ok: true };
                },
            },
            chat: {
                history: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    return {
                        items: actor.items(0),
                        deliveries: actor.deliveries(),
                        asks: actor.pendingAskRequests(),
                        answered: actor.answeredAskRequests(),
                    };
                },
                chat: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    const text = input.text.trim();
                    if (text === '') throw new Error('text required');
                    void actor.say({ text, author: HUMAN }).catch((error: unknown) => {
                        broadcast(input.id, {
                            kind: 'error',
                            message: error instanceof Error ? error.message : String(error),
                        });
                    });
                    return { ok: true };
                },
                cancel: async ({ input }) => {
                    requireRoom(input.id).cancel({
                        keepQueue: input.keepQueue === true,
                        ...(input.botId === undefined ? {} : { botId: input.botId }),
                    });
                    return { ok: true };
                },
                sessions: async ({ input }) => ({ sessions: requireRoom(input.id).sessionsInfo() }),
                compact: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    const event = await actor.compact(input.botId, {});
                    return {
                        event,
                        stats: actor.sessionsInfo().find((entry) => entry.botId === input.botId)?.stats,
                    };
                },
            },
            asks: {
                list: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    return { asks: actor.pendingAskRequests(), answered: actor.answeredAskRequests() };
                },
                answer: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    const outcome = actor.answerAsk(input.askId, input.answer as AskAnswer);
                    if (outcome.ok) return { ok: true };
                    throw new Error(outcome.code === 'bad-answer' ? outcome.reason : 'no such pending ask');
                },
                cancel: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    if (!actor.cancelAsk(input.askId)) throw new Error('no such pending ask');
                    return { ok: true, pending: actor.pendingAsks() };
                },
            },
            drafts: {
                list: async ({ input }) => ({ drafts: store.listDrafts(input.owner) }),
                put: async ({ input }) => {
                    if (tooLargeDraft(input.value)) throw new Error('draft too large (max 256KB)');
                    return { updatedAt: store.putDraft(input.owner, input.field, input.value)?.updatedAt ?? 0 };
                },
                remove: async ({ input }) => {
                    store.deleteDraft(input.owner, input.field);
                    return { ok: true };
                },
            },
            journal: {
                list: async ({ input }) => ({ entries: store.journalOf(input.id, input.limit ?? 50) }),
            },
            links: {
                list: async ({ input }) => {
                    const links = store.linksOf(input.id);
                    return {
                        out: links.out.map((link) => ({ id: link.to, kind: link.kind, ...labelOf(link.to) })),
                        in: links.in.map((link) => ({ id: link.from, kind: link.kind, ...labelOf(link.from) })),
                    };
                },
                add: async ({ input }) => {
                    store.link(input.id, input.to, input.kind ?? 'related');
                    return { ok: true };
                },
                remove: async ({ input }) => ({ removed: store.unlink(input.id, input.to, input.kind) }),
            },
        };
        server.use({ prefix: 'diy2', api: diy2Api, handlers });
    };

    // RPC 面：事件流（WS）+ 命令面。与 SSE 并存一段时间 —— 客户端切过去、验证稳定后再删 SSE。
    const rpc = createRpcSocket({
        attach,
        hasRoom: (roomId) => roomOf(roomId) !== undefined,
        bind: bindDiy2Api,
    });

    info = (): Diy2AppInfo => ({
        app: APP_ID,
        pid: process.pid,
        port: opts.port?.() ?? (config.port === 0 ? null : config.port),
        home: config.home,
        env: config.env,
        // `variant` 是老字段（读者还在用它）：现在 = 入口名（launch），两者不再各算一遍
        variant: config.launch,
        launch: config.launch,
        name: config.name,
        tools: config.tools,
    });

    const close = (): void => {
        rpc.close();
        subscribers.clear();
    };

    return { handle, handleUpgrade: rpc.handleUpgrade, rpcStreams: rpc.streams, info, close };
}
