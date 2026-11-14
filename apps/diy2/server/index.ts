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

import { RoomActor, openStore } from '@diy-agent/entity-runtime';
import type { RoomEvent } from '@diy-agent/entity-runtime';
import type { Author, Bot, Room, RoomMember } from '@diy-agent/protocol';

const PORT = Number(process.env['DIY2_PORT'] ?? 5191);
const DEFAULT_MODEL = 'chen56@opencode-go/deepseek-v4.1-flash';
const COMPACT_BUDGET = {
    keepLast: Number(process.env['DIY2_COMPACT_KEEP'] ?? 12),
    maxChars: Number(process.env['DIY2_COMPACT_CHARS'] ?? 24000),
};

const dataDir = join(homedir(), '.diy', 'diy2');
mkdirSync(dataDir, { recursive: true });
const store = openStore(join(dataDir, 'diy2.db'));
const HUMAN: Author = { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' };
const COLORS = ['#7cc4ff', '#f7b267', '#a3e635', '#f472b6', '#c084fc', '#38bdf8'];

// ─── 房间装配 ─────────────────────────────────────────────────────

/** roomId → 聚合根（房间的领域对象） */
const rooms = new Map<string, RoomActor>();
/** 房间级 SSE 订阅者：同一房间的多个请求共享一条事件流 */
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

function broadcast(roomId: string, payload: RoomEvent): void {
    for (const res of subscribers.get(roomId) ?? []) sse(res, payload);
}

/** 收尾：等这个房间所有会话都跑完，再通知并断开订阅 */
function finish(roomId: string, attempt = 0): void {
    if ((rooms.get(roomId)?.busy() ?? false) && attempt < 600) {
        setTimeout(() => finish(roomId, attempt + 1), 100);
        return;
    }
    for (const res of subscribers.get(roomId) ?? []) {
        sse(res, { kind: 'done' });
        res.end();
    }
    subscribers.delete(roomId);
}

function actorOf(spec: Room): RoomActor {
    let actor = rooms.get(spec.id);
    if (actor === undefined) {
        actor = new RoomActor({
            spec,
            store,
            bots: () => store.listBots(),
            emit: (event) => broadcast(spec.id, event),
            budget: COMPACT_BUDGET,
            onCompact: (bot, event) => logCompact(spec.id, bot, event),
        });
        rooms.set(spec.id, actor);
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
            members: [{ botId: byName('diy')?.id ?? bots[0]!.id, primary: true }, { botId: byName('小满')?.id ?? bots[0]!.id }],
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
            data: { dir: '~/git/diy/diy', projectId: 'proj:diy' },
            members: [{ botId: byName('任务树与多会话')?.id ?? bots[2]!.id, primary: true }],
            modelKey: DEFAULT_MODEL,
        },
    ];

    // 恢复成员关系（重启后 @ 仍生效）
    const saved = store.members();
    for (const spec of specs) {
        const members: RoomMember[] | undefined = saved[spec.id];
        if (members !== undefined && members.length > 0) spec.members = members;
        store.setMembers(spec.id, spec.members);
        actorOf(spec).recover();
    }
}

seed();

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
            json(res, 200, [...rooms.values()].map((actor) => actor.spec));
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
                const bot = newBot(name, body.homeRoomId ?? 'proj:diy', 'room 成员 bot');
                store.upsertBot({ ...bot, ...(body.modelKey === undefined ? {} : { modelKey: body.modelKey }) });
                roomOf(bot.homeRoomId)?.addMember(bot.id);
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
                const bot = newBot(name, id, `${type} bot`);
                store.upsertBot(bot);
                const spec: Room = {
                    id,
                    type,
                    name,
                    data: body.data ?? {},
                    members: [{ botId: bot.id, primary: true }],
                    modelKey: DEFAULT_MODEL,
                };
                store.setMembers(id, spec.members);
                actorOf(spec);
                json(res, 200, spec);
            });
            return;
        }

        // PATCH /api/rooms/:id —— 改名 / 改房间模型
        if (req.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'rooms' && parts.length === 3) {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            void readBody<{ name?: string; modelKey?: string }>(req).then((body) => {
                actor.update({
                    ...(body.name === undefined ? {} : { name: body.name }),
                    ...(body.modelKey === undefined ? {} : { modelKey: body.modelKey }),
                });
                json(res, 200, actor.spec);
            });
            return;
        }

        // POST /api/rooms/:id/bots —— 加入已有 bot（借用）
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'bots') {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            void readBody<{ botId?: string }>(req).then((body) => {
                if (body.botId !== undefined) actor.addMember(body.botId);
                json(res, 200, actor.spec);
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

        // GET /api/rooms/:id/sessions —— 每个成员的上下文概况 + 最近的压缩事件
        if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'sessions' && parts.length === 4) {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            json(res, 200, { sessions: actor.sessionsInfo() });
            return;
        }

        // POST /api/rooms/:id/sessions/:botId/compact —— 手动压一次（只影响这个成员）
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'sessions' && parts[5] === 'compact') {
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

        // POST /api/rooms/:id/chat —— 投一条消息；SSE 订阅这个房间的事件
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'chat') {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });

            void readBody<{ text?: string; recipients?: string[]; mode?: 'next-step' | 'next-turn' }>(req).then(async (body) => {
                const text = (body.text ?? '').trim();
                if (text === '') return json(res, 400, { error: 'text required' });

                res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                });
                attach(id, res);

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
            });
            return;
        }

        // POST /api/rooms/:id/cancel —— 停止这个房间所有在跑的会话
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'cancel') {
            const id = decodeURIComponent(parts[2] ?? '');
            const actor = roomOf(id);
            if (actor === undefined) return json(res, 404, { error: 'room not found' });
            void readBody<{ keepQueue?: boolean }>(req).then((body) => {
                actor.cancel({ keepQueue: body.keepQueue === true });
                finish(id);
                json(res, 200, { ok: true });
            });
            return;
        }

        json(res, 404, { error: `unknown ${req.method ?? '?'} ${url.pathname}` });
    } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
});

server.listen(PORT, () => {
    console.log(`[diy2] http://localhost:${PORT}  db=${join(dataDir, 'diy2.db')}`);
});
