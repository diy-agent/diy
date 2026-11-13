// server/index.ts —— diy2 切片后端：实体 / bot / 历史 / 流式对话（SSE）。
//
//   GET  /api/rooms            实体列表（项目/任务/bot）
//   POST /api/bots                新建 bot（落 sqlite）
//   GET  /api/rooms/:id/history?afterSeq=
//   POST /api/rooms/:id/chat   { text } → SSE: { kind:'item'|'done'|'error' }

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BotSession, Inbox, RoomLog, openStore } from '@diy-agent/entity-runtime';
import type { RoomEntry, TurnResult } from '@diy-agent/entity-runtime';
import type { Author, Bot, Item, Room } from '@diy-agent/protocol';

const PORT = Number(process.env['DIY2_PORT'] ?? 5191);
const DEFAULT_MODEL = 'chen56@opencode-go/deepseek-v4.1-flash';

const dataDir = join(homedir(), '.diy', 'diy2');
mkdirSync(dataDir, { recursive: true });
const store = openStore(join(dataDir, 'diy2.db'));
const inbox = new Inbox(store.db);

/** 每个 (room, bot) 一个 BotSession：各自串行，互不阻塞 */
const sessions = new Map<string, BotSession>();
/** 每个房间一份公共日志（内存版，append-only） */
const roomLogs = new Map<string, RoomLog>();
/** 房间当前进行中的轮次：运行中再发消息，沿用同一 turn（不然会跳到时间线末尾） */
const activeTurns = new Map<string, { turn: number; turnId: string }>();

/** 房间级的 SSE 订阅者（同一房间的多个请求共享事件流） */
const subscribers = new Map<string, Set<ServerResponse>>();

function attach(roomId: string, res: ServerResponse): void {
    let set = subscribers.get(roomId);
    if (set === undefined) {
        set = new Set();
        subscribers.set(roomId, set);
    }
    set.add(res);
    res.on('close', () => set?.delete(res));
}

function broadcast(roomId: string, payload: unknown): void {
    for (const res of subscribers.get(roomId) ?? []) sse(res, payload);
}

/** 收尾：等这个房间的所有会话都跑完，再通知并断开订阅 */
function finish(roomId: string, attempt = 0): void {
    if (sessionsOf(roomId).some(({ session }) => session.busy) && attempt < 600) {
        // 还有 bot 在跑（@ 唤起 / 排队），等它结束再收尾，免得把它的产出丢在已关闭的连接外
        setTimeout(() => finish(roomId, attempt + 1), 100);
        return;
    }
    activeTurns.delete(roomId);
    for (const res of subscribers.get(roomId) ?? []) {
        sse(res, { kind: 'done' });
        res.end();
    }
    subscribers.delete(roomId);
}

function logOf(roomId: string): RoomLog {
    let log = roomLogs.get(roomId);
    if (log === undefined) {
        log = new RoomLog();
        roomLogs.set(roomId, log);
    }
    return log;
}

/** 这个房间里所有已建好的 session（含 botId） */
function sessionsOf(roomId: string): Array<{ botId: string; session: BotSession }> {
    const prefix = `${roomId}::`;
    const out: Array<{ botId: string; session: BotSession }> = [];
    for (const [actor, session] of sessions) {
        if (actor.startsWith(prefix)) out.push({ botId: actor.slice(prefix.length), session });
    }
    return out;
}

/** 取/建某个 bot 在这个 room 里的 session；新建时回放公共日志（后加入的成员也能读到此前结论） */
function sessionOf(roomId: string, bot: Bot): BotSession {
    const actor = `${roomId}::${bot.id}`;
    let session = sessions.get(actor);
    if (session === undefined) {
        const persisted = new Set<string>();
        session = new BotSession({
            actor,
            bot,
            modelKey: bot.modelKey,
            nextTurn: () => ({ turn: nextTurn(roomId), turnId: `turn-${Date.now().toString(36)}` }),
            nextOrder: () => nextOrder(roomId),
            onItem: (item) => {
                broadcast(roomId, { kind: 'item', item });
                if ((item.status === 'done' || item.status === 'failed') && !persisted.has(item.id)) {
                    persisted.add(item.id);
                    store.appendItem(roomId, item);
                }
            },
            onError: (message) => broadcast(roomId, { kind: 'error', message }),
            onDelivery: (messageId, state) => {
                const delivery = store.setDelivery({ roomId, messageId, botId: bot.id, state });
                broadcast(roomId, { kind: 'delivery', delivery });
            },
            onTurnEnd: (result) => publishConclusion(roomId, bot, result),
        });
        for (const entry of logOf(roomId).all()) session.ingest(entry);
        sessions.set(actor, session);
    }
    return session;
}

/**
 * 结论进公共日志，并复制给房间里其他 session —— **不唤醒任何人**。
 * 其他 bot 只会在下一次被唤醒时读到它（防乒乓）。
 * 唯一的例外：结论里显式 @ 了某个 bot，那是"点名"，算唤醒。
 */
function publishConclusion(roomId: string, bot: Bot, result: TurnResult): void {
    if (result.failed || result.text === '') return;
    const entry = logOf(roomId).append({
        kind: 'conclusion',
        botId: bot.id,
        name: bot.name,
        color: bot.color,
        text: result.text,
        turn: result.turn,
        turnId: result.turnId,
    });
    for (const { botId, session } of sessionsOf(roomId)) {
        if (botId !== bot.id) session.ingest(entry);
    }

    // bot 之间只能单人 @；@all 在 bot 侧忽略（防一次结论炸醒全房间）
    const room = rooms.get(roomId);
    if (room === undefined) return;
    const mentioned = [...result.text.matchAll(/@([^\s@]+)/g)].map((match) => match[1] ?? '');
    const name = mentioned.find((value) => value !== 'all');
    if (name === undefined) return;
    const participants = participantsOf(roomId);
    const target = participants.find((candidate) => candidate.name === name && candidate.id !== bot.id);
    if (target === undefined) return;

    const notice: Item = {
        id: `n-${Date.now().toString(36)}`,
        seq: store.seqOf(roomId) + 1,
        order: nextOrder(roomId),
        turn: result.turn,
        turnId: result.turnId,
        at: Date.now(),
        status: 'done',
        type: 'notice',
        data: { text: `${bot.name} 在结论里 @${target.name}，已唤起`, kind: 'mention' },
    };
    broadcast(roomId, { kind: 'item', item: store.appendItem(roomId, notice) });
    void sessionOf(roomId, target).post({
        messageId: notice.id,
        text: `[${bot.name} 的结论] ${result.text}`,
        mode: 'next-turn',
        turn: { turn: result.turn, turnId: result.turnId },
    });
}

function participantsOf(roomId: string): Bot[] {
    const room = rooms.get(roomId);
    if (room === undefined) return [];
    const bots = store.listBots();
    return room.botIds.map((botId) => bots.find((bot) => bot.id === botId)).filter((bot): bot is Bot => bot !== undefined);
}

function nextTurn(roomId: string): number {
    const turns = store.itemsOf(roomId).map((item) => (item as { turn?: number }).turn ?? 0);
    return Math.max(0, ...turns) + 1;
}

/** 展示顺序：每个实体一个单调计数器（跨 bot 也稳定） */
const orderCounter = new Map<string, number>();
function nextOrder(roomId: string): number {
    if (!orderCounter.has(roomId)) {
        const orders = store.itemsOf(roomId).map((item) => (item as { order?: number }).order ?? 0);
        orderCounter.set(roomId, Math.max(0, ...orders));
    }
    const next = (orderCounter.get(roomId) ?? 0) + 1;
    orderCounter.set(roomId, next);
    return next;
}

/**
 * 路由：每个容器有一个 primary bot；默认只有 primary 回。
 *   @all    → 全体成员（开会）
 *   @名字   → 命中的 bot
 *   没有 @  → 只有 primary
 */
function route(room: Room, bots: Bot[], text: string): Bot[] {
    const primary = bots.find((bot) => bot.id === room.primaryBotId) ?? bots[0];
    const mentioned = [...text.matchAll(/@([^\s@]+)/g)].map((match) => match[1] ?? '');
    if (mentioned.includes('all')) return bots;
    const picked = bots.filter((bot) => mentioned.includes(bot.name));
    if (picked.length > 0) return picked;
    return primary === undefined ? [] : [primary];
}

const COLORS = ['#7cc4ff', '#f7b267', '#a3e635', '#f472b6', '#c084fc', '#38bdf8'];

const HUMAN: Author = { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' };

// ─── 种子：bot 落 sqlite；项目/任务先在内存 ────────────────────────

function seed(): Map<string, Room> {
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
    const rooms = new Map<string, Room>();
    const diyBots = [byName('diy')?.id ?? bots[0]!.id, ...(byName('小满') === undefined ? [] : [byName('小满')!.id])];
    rooms.set('proj:diy', {
        id: 'proj:diy',
        type: 'project',
        name: 'diy',
        data: { dir: '~/git/diy/diy' },
        botIds: diyBots,
        primaryBotId: diyBots[0]!,
        modelKey: DEFAULT_MODEL,
    });
    const copsBots = [byName('cops')?.id ?? bots[1]!.id];
    rooms.set('proj:cops', {
        id: 'proj:cops',
        type: 'project',
        name: 'cops',
        data: { dir: '~/git/cops' },
        botIds: copsBots,
        primaryBotId: copsBots[0]!,
        modelKey: DEFAULT_MODEL,
    });
    const taskBots = [byName('任务树与多会话')?.id ?? bots[2]!.id];
    rooms.set('task:t-001', {
        id: 'task:t-001',
        type: 'task',
        name: '任务树与多会话',
        data: { dir: '~/git/diy/diy', projectId: 'proj:diy' },
        botIds: taskBots,
        primaryBotId: taskBots[0]!,
        modelKey: DEFAULT_MODEL,
    });
    // 恢复参与关系（重启后 bot 列表与 @ 仍在）
    const saved = store.entityBots();
    for (const [id, botIds] of Object.entries(saved)) {
        const room = rooms.get(id);
        if (room !== undefined && botIds.length > 0) {
            room.botIds = botIds;
            room.primaryBotId = botIds[0]!;
        }
    }

    return rooms;
}

const rooms = seed();

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

function sse(res: ServerResponse, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function authorOf(bot: Bot): Author {
    return { id: bot.id, name: bot.name, color: bot.color, role: 'bot' };
}

// ─── 路由 ─────────────────────────────────────────────────────────

const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
        if (req.method === 'GET' && url.pathname === '/api/rooms') {
            json(res, 200, [...rooms.values()]);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/bots') {
            json(res, 200, store.listBots());
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/bots') {
            void readBody<{ name?: string; homeRoomId?: string; modelKey?: string }>(req).then((body) => {
                const name = (body.name ?? '').trim();
                if (name === '') return json(res, 400, { error: 'name required' });
                const bot: Bot = {
                    id: `bot-${Date.now().toString(36)}`,
                    name,
                    color: COLORS[store.listBots().length % COLORS.length]!,
                    persona: 'room 成员 bot',
                    homeRoomId: body.homeRoomId ?? 'proj:diy',
                    modelKey: body.modelKey ?? DEFAULT_MODEL,
                };
                store.upsertBot(bot);
                const home = rooms.get(bot.homeRoomId);
                if (home !== undefined) {
                    home.botIds = [...home.botIds, bot.id];
                    store.setEntityBots(home.id, home.botIds);
                }
                json(res, 200, bot);
            });
            return;
        }

        // POST /api/rooms —— 新建任意类型的容器（默认 bot 同名）
        if (req.method === 'POST' && url.pathname === '/api/rooms') {
            void readBody<{ type?: string; name?: string; data?: Record<string, unknown> }>(req).then((body) => {
                const name = (body.name ?? '').trim();
                if (name === '') return json(res, 400, { error: 'name required' });
                const type = body.type ?? 'project';
                const id = `${type}-${Date.now().toString(36)}`;
                const bot: Bot = {
                    id: `bot-${Date.now().toString(36)}`,
                    name,
                    color: COLORS[store.listBots().length % COLORS.length]!,
                    persona: `${type} bot`,
                    homeRoomId: id,
                    modelKey: DEFAULT_MODEL,
                };
                store.upsertBot(bot);
                const room: Room = {
                    id,
                    type,
                    name,
                    data: body.data ?? {},
                    botIds: [bot.id],
                    primaryBotId: bot.id,
                    modelKey: DEFAULT_MODEL,
                };
                rooms.set(id, room);
                store.setEntityBots(id, room.botIds);
                json(res, 200, room);
            });
            return;
        }

        // PATCH /api/entities/:id —— 改名 / 改模型
        if (req.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'rooms' && parts.length === 3) {
            const id = decodeURIComponent(parts[2] ?? '');
            const room = rooms.get(id);
            if (room === undefined) return json(res, 404, { error: 'room not found' });
            void readBody<{ name?: string; modelKey?: string }>(req).then((body) => {
                if (body.name !== undefined && body.name.trim() !== '') {
                    room.name = body.name.trim();
                    const primary = store.listBots().find((bot) => bot.id === room.primaryBotId);
                    if (primary !== undefined) store.upsertBot({ ...primary, name: room.name });
                }
                if (body.modelKey !== undefined) room.modelKey = body.modelKey;
                json(res, 200, room);
            });
            return;
        }

        // POST /api/entities/:id/bots —— 加入已有 bot（借用）
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'bots') {
            const id = decodeURIComponent(parts[2] ?? '');
            const room = rooms.get(id);
            if (room === undefined) return json(res, 404, { error: 'room not found' });
            void readBody<{ botId?: string }>(req).then((body) => {
                if (body.botId !== undefined && !room.botIds.includes(body.botId)) {
                    room.botIds = [...room.botIds, body.botId];
                    store.setEntityBots(id, room.botIds);
                }
                json(res, 200, room);
            });
            return;
        }

        if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'sessions') {
            const id = decodeURIComponent(parts[2] ?? '');
            json(res, 200, {
                sessions: sessionsOf(id).map(({ botId, session }) => ({ botId, messages: session.context() })),
            });
            return;
        }

        // /api/entities/:id/history
        if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'history') {
            const id = decodeURIComponent(parts[2] ?? '');
            const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0');
            json(res, 200, { items: store.itemsOf(id, afterSeq) });
            return;
        }

        if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'deliveries') {
            const id = decodeURIComponent(parts[2] ?? '');
            json(res, 200, { deliveries: store.listDeliveries(id) });
            return;
        }

        // POST /api/rooms/:id/chat —— 投一条消息（next-step），SSE 订阅这个房间的事件
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'chat') {
            const id = decodeURIComponent(parts[2] ?? '');
            const room = rooms.get(id);
            if (room === undefined) return json(res, 404, { error: 'room not found' });

            void readBody<{ text?: string; recipients?: string[]; mode?: 'next-step' | 'next-turn' }>(req).then(async (body) => {
                const text = (body.text ?? '').trim();
                if (text === '') return json(res, 400, { error: 'text required' });

                const participants = participantsOf(id);
                if (participants.length === 0) return json(res, 400, { error: 'room has no bot' });

                res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                });
                attach(id, res);

                const now = Date.now();
                const busy = [...sessions].some(([actor, session]) => actor.startsWith(`${id}::`) && session.busy);
                const turnRef = (busy ? activeTurns.get(id) : undefined) ?? {
                    turn: nextTurn(id),
                    turnId: `turn-${now.toString(36)}`,
                };
                activeTurns.set(id, turnRef);
                const { turn, turnId } = turnRef;

                const userItem: Item = {
                    id: `u-${now.toString(36)}`,
                    seq: store.seqOf(id) + 1,
                    order: nextOrder(id),
                    turn,
                    turnId,
                    at: now,
                    status: 'done',
                    author: HUMAN,
                    type: 'chat',
                    data: { text },
                };
                const savedUser = store.appendItem(id, userItem);
                broadcast(id, { kind: 'item', item: savedUser });

                // 显式 recipients = 开会；缺省按 @ 规则路由
                const explicit = (body.recipients ?? [])
                    .map((botId) => participants.find((bot) => bot.id === botId))
                    .filter((bot): bot is Bot => bot !== undefined);
                const recipients = explicit.length > 0 ? explicit : route(room, participants, text);
                const recipientIds = new Set(recipients.map((bot) => bot.id));

                // 先把成员 session 建好（新建的会回放日志），再追加这条公共条目，
                // 否则被 @ 的人会把同一条消息收两遍（日志 + steering）。
                for (const bot of participants) sessionOf(id, bot);
                const entry: RoomEntry = logOf(id).append({ kind: 'say', author: HUMAN, text, turn, turnId });

                // 没被点名的成员：只进上下文，不唤醒（下一轮才读到）
                for (const bot of participants) {
                    if (!recipientIds.has(bot.id)) sessionOf(id, bot).ingest(entry);
                }

                for (const bot of recipients) {
                    const delivery = store.setDelivery({ roomId: id, messageId: savedUser.id, botId: bot.id, state: 'queued' });
                    broadcast(id, { kind: 'delivery', delivery });
                }

                const mode = body.mode ?? 'next-step';
                const posts = recipients.map((bot) =>
                    sessionOf(id, bot).post({ messageId: savedUser.id, text, mode, turn: { turn, turnId }, entry }),
                );
                await Promise.all(posts);

                finish(id);
            });
            return;
        }

        // POST /api/rooms/:id/cancel —— 停止这个房间所有在跑的会话
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'cancel') {
            const id = decodeURIComponent(parts[2] ?? '');
            void readBody<{ keepQueue?: boolean }>(req).then((body) => {
                for (const [actor, session] of sessions) {
                    if (actor.startsWith(`${id}::`)) session.cancel({ keepQueue: body.keepQueue === true });
                }
                broadcast(id, { kind: 'done' });
                json(res, 200, { ok: true });
            });
            return;
        }

        json(res, 404, { error: `unknown ${req.method ?? '?'} ${url.pathname}` });
    } catch (error) {
        if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        else res.end();
    }
});

server.listen(PORT, () => {
    console.log(`[diy2] http://localhost:${PORT}  db=${join(dataDir, 'diy2.db')}`);
});
