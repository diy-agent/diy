// server/index.ts —— diy2 的 HTTP/SSE 适配层。
//
// 领域逻辑全在 `RoomActor`（entity-runtime/src/room.ts）：成员、路由、结论、
// 回合与顺序、会话池、压缩。这里只做四件事：
//   1. 解析请求 / 回 JSON
//   2. 房间订阅（同一房间多个请求共享一条 SSE）
//   3. 把 RoomActor 的事件转成 SSE
//   4. 进程内的房间与 bot 装配（种子数据）

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createStaticHandler } from './static';

import { RoomActor, openStore } from '@diy-agent/entity-runtime';
import type { CompactEvent, RoomEvent } from '@diy-agent/entity-runtime';
import type { Author, Bot, Room } from '@diy-agent/protocol';

const PORT = Number(process.env['DIY2_PORT'] ?? 5191);
// 生产（全局命令 diy2）：同一个进程顺带把 UI 也发出去；开发时为空，前端走 vite dev server
const WEB_DIR = process.env['DIY2_WEB_DIR'];
const serveStatic = createStaticHandler(WEB_DIR);
const DEFAULT_MODEL = 'chen56@opencode-go/deepseek-v4.1-flash';
const COMPACT_BUDGET = {
    keepLast: Number(process.env['DIY2_COMPACT_KEEP'] ?? 12),
    maxChars: Number(process.env['DIY2_COMPACT_CHARS'] ?? 24000),
};

const dataDir = process.env['DIY2_DATA_DIR'] ?? join(homedir(), '.diy', 'diy2');
/** 提问卡草稿：提问早就有了结局（或从时间线上消失）这么久，就不再算"未提交输入" */
const ASK_DRAFT_TTL = 30 * 60 * 1000;
/** 对话框草稿：synthetic owner 不随房间级联删，超过这么久没人再来就清掉 */
const DIALOG_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
mkdirSync(dataDir, { recursive: true });
const store = openStore(join(dataDir, 'diy2.db'));
const HUMAN: Author = { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' };
const COLORS = ['#7cc4ff', '#f7b267', '#a3e635', '#f472b6', '#c084fc', '#38bdf8'];

// ─── 房间装配 ─────────────────────────────────────────────────────

/** roomId → 聚合根（房间的领域对象） */
const rooms = new Map<string, RoomActor>();
/** 房间级 SSE 订阅者：请求流的（每次 chat 一个）+ 常驻监听的（UI 打开房间就挂一条） */
interface Subscriber {
    res: ServerResponse;
    /** 常驻订阅不随某次 chat 结束而关闭 */
    persistent: boolean;
}
const subscribers = new Map<string, Set<Subscriber>>();

function attach(roomId: string, res: ServerResponse, persistent = false): void {
    let set = subscribers.get(roomId);
    if (set === undefined) {
        set = new Set();
        subscribers.set(roomId, set);
    }
    const entry: Subscriber = { res, persistent };
    set.add(entry);
    res.on('close', () => set?.delete(entry));
}

/**
 * 请求流只留最新一条：长会话里每句插话都会开一条 /chat SSE，而它要等整轮结束
 * （可能十几分钟）才收尾；浏览器同源 HTTP/1.1 只有 6 条连接，攒满后新请求
 * 连发都发不出去。旧流补一条 done 后关掉，事件仍走常驻订阅。
 */
function attachChat(roomId: string, res: ServerResponse): void {
    const set = subscribers.get(roomId);
    for (const entry of [...(set ?? [])]) {
        if (entry.persistent) continue;
        sse(entry.res, { kind: 'done' });
        entry.res.end();
        set?.delete(entry);
    }
    attach(roomId, res);
}

function broadcast(roomId: string, payload: RoomEvent): void {
    for (const entry of subscribers.get(roomId) ?? []) sse(entry.res, payload);
}

/** 收尾：等这个房间所有会话都跑完，再通知并断开订阅 */
function finish(roomId: string, attempt = 0): void {
    if ((rooms.get(roomId)?.busy() ?? false) && attempt < 600) {
        setTimeout(() => finish(roomId, attempt + 1), 100);
        return;
    }
    // 只关"请求流"；常驻监听那条留着，UI 才能继续收到后台 bot 的动静
    const set = subscribers.get(roomId);
    for (const entry of [...(set ?? [])]) {
        if (entry.persistent) continue;
        sse(entry.res, { kind: 'done' });
        entry.res.end();
        set?.delete(entry);
    }
    if (set !== undefined && set.size === 0) subscribers.delete(roomId);
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

function actorOf(spec: Room): RoomActor {
    let actor = rooms.get(spec.id);
    if (actor === undefined) {
        const cwd = cwdOf(spec);
        actor = new RoomActor({
            spec,
            store,
            bots: () => store.listBots(),
            emit: (event) => broadcast(spec.id, event),
            budget: COMPACT_BUDGET,
            onCompact: (bot, event) => logCompact(spec.id, bot, event),
            ...(cwd === undefined ? {} : { cwd }),
            shell: process.env['DIY2_TOOLS'] !== 'files',
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
            data: { dir: '~/git/diy/diy', projectId: 'proj:diy', status: 'doing' },
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

seed();

// 对话框草稿的 owner 是 synthetic scope（`dlg:<用途>:<roomId>`）：删项目时已级联，
// 剩下的（用户再也不打开那个对话框 / 房间 id 早就换掉）靠 TTL 收，别让库只增不减。
const prunedDialogs = store.pruneDraftOwners('dlg:', Date.now() - DIALOG_DRAFT_TTL);
if (prunedDialogs > 0) console.log(`[drafts] 清掉 ${prunedDialogs} 条过期对话框草稿`);

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

function sse(res: ServerResponse, payload: unknown): void {
    // 客户端可能已经断开（刷新 / abort / 切房间）：别往死 socket 上写
    if (res.destroyed || res.writableEnded) return;
    try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
        // 写失败说明连接没了，交给 close 事件清理
    }
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

const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
        if (req.method === 'GET' && url.pathname === '/api/rooms') {
            // hasDraft 是列表页的投影字段（侧栏 ✎），不属于 Room 领域类型
            const withDraft = new Set(store.draftOwners());
            json(
                res,
                200,
                [...rooms.values()].map((actor) => ({ ...actor.spec, hasDraft: withDraft.has(actor.spec.id) })),
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
                        // 任务默认「未开始」：侧栏/头部要有个能看见、能改的状态，缺省不该是空白
                        data: type === 'task' ? { status: 'todo', ...body.data } : (body.data ?? {}),
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
                // 订阅者（UI 常驻 SSE / 正在跑的 chat 流）收尾，不然前端挂着一条已不存在的房间的流
                const set = subscribers.get(roomId);
                for (const entry of [...(set ?? [])]) {
                    sse(entry.res, { kind: 'done' });
                    entry.res.end();
                }
                subscribers.delete(roomId);
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
            // 打开房间顺手自愈：还在等回答的 ask 草稿保留，其余「早已有结局 / 已不在时间线上」
            // 的旧草稿清掉 —— 否则侧栏 ✎ 会为一个不存在的提问一直亮着
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

        if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'deliveries') {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            json(res, 200, { deliveries: actor.deliveries() });
            return;
        }

        // GET /api/rooms/:id/events —— 常驻事件流（UI 打开房间时挂一条，后台的 bot 动静也能看到）
        if (
            req.method === 'GET' &&
            parts[0] === 'api' &&
            parts[1] === 'rooms' &&
            parts[3] === 'events' &&
            parts.length === 4
        ) {
            const id = decodeURIComponent(parts[2] ?? '');
            if (roomOf(id) === undefined) return json(res, 404, { error: 'room not found' });
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
            });
            attach(id, res, true);
            sse(res, { kind: 'ready' });
            // 心跳：代理 / 浏览器会掐掉长时间无数据的连接，20s 一帧注释
            const timer = setInterval(() => res.write(': ping\n\n'), 20_000);
            res.on('close', () => clearInterval(timer));
            return;
        }

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

        // POST /api/rooms/:id/asks/:askId —— 回答一次提问（选项 values / 表单 fields）
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'asks') {
            const id = decodeURIComponent(parts[2] ?? '');
            const askId = decodeURIComponent(parts[4] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            onBody<{ values?: string[]; fields?: Record<string, string>; text?: string }>(req, res, (body) => {
                const hit = actor.answerAsk(askId, {
                    ...(body.values === undefined ? {} : { values: body.values }),
                    ...(body.fields === undefined ? {} : { fields: body.fields }),
                    // 自由输入：之前漏传输，导致 kind=text 的回答永远是空
                    ...(body.text === undefined ? {} : { text: body.text }),
                });
                json(res, hit ? 200 : 404, hit ? { ok: true } : { error: 'no such pending ask' });
            });
            return;
        }

        // POST /api/rooms/:id/chat —— 投一条消息；SSE 订阅这个房间的事件
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'chat') {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });

            onBody<{ text?: string; recipients?: string[]; mode?: 'next-step' | 'next-turn' }>(
                req,
                res,
                async (body) => {
                    const text = (body.text ?? '').trim();
                    if (text === '') return json(res, 400, { error: 'text required' });

                    res.writeHead(200, {
                        'content-type': 'text/event-stream; charset=utf-8',
                        'cache-control': 'no-cache',
                        connection: 'keep-alive',
                    });
                    attachChat(id, res);

                    try {
                        await actor.say({
                            text,
                            author: HUMAN,
                            ...(body.recipients === undefined ? {} : { recipients: body.recipients }),
                            ...(body.mode === undefined ? {} : { mode: body.mode }),
                        });
                    } catch (error) {
                        sse(res, { kind: 'error', message: error instanceof Error ? error.message : String(error) });
                    }
                    finish(id);
                },
            );
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
                finish(id);
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
});

// 只绑本机：这个进程带着 read/write/edit/bash 工具，监听 0.0.0.0 等于把
// 任意命令执行面暴露给整个局域网（而且没有鉴权）。要远程用请走 SSH 隧道。
server.listen(PORT, '127.0.0.1', () => {
    console.log(`[diy2] http://localhost:${PORT}  db=${join(dataDir, 'diy2.db')}`);
    if (serveStatic !== undefined) console.log(`[diy2] UI: ${WEB_DIR}`);
});
