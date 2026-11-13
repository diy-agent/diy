// server/index.ts —— diy2 切片后端：实体 / bot / 历史 / 流式对话（SSE）。
//
//   GET  /api/entities            实体列表（项目/任务/bot）
//   POST /api/bots                新建 bot（落 sqlite）
//   GET  /api/entities/:id/history?afterSeq=
//   POST /api/entities/:id/chat   { text } → SSE: { kind:'item'|'done'|'error' }

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Inbox, Projector, openStore, runAgent } from '@diy-agent/entity-runtime';
import type { Author, Bot, Entity, Item } from '@diy-agent/protocol';

const PORT = Number(process.env['DIY2_PORT'] ?? 5191);
const DEFAULT_MODEL = 'chen56@opencode-go/deepseek-v4.1-flash';

const dataDir = join(homedir(), '.diy', 'diy2');
mkdirSync(dataDir, { recursive: true });
const store = openStore(join(dataDir, 'diy2.db'));
const inbox = new Inbox(store.db);

/** 每个实体一条串行链：同一实体的轮次严格按发送顺序执行 */
const chains = new Map<string, Promise<void>>();

function nextTurn(entityId: string): number {
    const turns = store.itemsOf(entityId).map((item) => (item as { turn?: number }).turn ?? 0);
    return Math.max(0, ...turns) + 1;
}

/** 展示顺序：每个实体一个单调计数器（跨 bot 也稳定） */
const orderCounter = new Map<string, number>();
function nextOrder(entityId: string): number {
    if (!orderCounter.has(entityId)) {
        const orders = store.itemsOf(entityId).map((item) => (item as { order?: number }).order ?? 0);
        orderCounter.set(entityId, Math.max(0, ...orders));
    }
    const next = (orderCounter.get(entityId) ?? 0) + 1;
    orderCounter.set(entityId, next);
    return next;
}

/**
 * 路由：容器只有一个 owner；默认只有 owner 回。
 *   @all    → 全体（owner + 其他）
 *   @名字   → 命中的 bot（可以是 owner 或其他）
 *   没有 @  → 只有 owner
 */
function route(entity: Entity, bots: Bot[], text: string): Bot[] {
    const owner = bots[0];
    const mentioned = [...text.matchAll(/@([^\s@]+)/g)].map((match) => match[1] ?? '');
    if (mentioned.includes('all')) return bots;
    const picked = bots.filter((bot) => mentioned.includes(bot.name));
    if (picked.length > 0) return picked;
    return owner === undefined ? [] : [owner];
}

const COLORS = ['#7cc4ff', '#f7b267', '#a3e635', '#f472b6', '#c084fc', '#38bdf8'];

// ─── 种子：bot 落 sqlite；项目/任务先在内存 ────────────────────────

function seed(): Map<string, Entity> {
    let bots = store.listBots();
    if (bots.length === 0) {
        const create = (name: string, homeEntityId: string, persona: string): Bot => {
            const bot: Bot = {
                id: `bot-${Date.now().toString(36)}-${bots.length + 1}`,
                name,
                color: COLORS[bots.length % COLORS.length]!,
                persona,
                homeEntityId,
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
    const entities = new Map<string, Entity>();
    entities.set('proj:diy', {
        id: 'proj:diy',
        kind: 'project',
        name: 'diy',
        dir: '~/git/diy/diy',
        botIds: [byName('diy')?.id ?? bots[0]!.id, ...(byName('小满') === undefined ? [] : [byName('小满')!.id])],
        modelKey: DEFAULT_MODEL,
    });
    entities.set('proj:cops', {
        id: 'proj:cops',
        kind: 'project',
        name: 'cops',
        dir: '~/git/cops',
        botIds: [byName('cops')?.id ?? bots[1]!.id],
        modelKey: DEFAULT_MODEL,
    });
    entities.set('task:t-001', {
        id: 'task:t-001',
        kind: 'task',
        name: '任务树与多会话',
        projectId: 'proj:diy',
        dir: '~/git/diy/diy',
        botIds: [byName('任务树与多会话')?.id ?? bots[2]!.id],
        modelKey: DEFAULT_MODEL,
    });
    // 恢复参与关系（重启后 bot 列表与 @ 仍在）
    const saved = store.entityBots();
    for (const [id, botIds] of Object.entries(saved)) {
        const entity = entities.get(id);
        if (entity !== undefined && botIds.length > 0) entity.botIds = botIds;
    }

    // bot 自己也是实体（独立对话）
    for (const bot of bots) {
        entities.set(`bot:${bot.id}`, {
            id: `bot:${bot.id}`,
            kind: 'bot',
            name: bot.name,
            botIds: [bot.id],
            modelKey: bot.modelKey,
        });
    }
    return entities;
}

const entities = seed();

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
        if (req.method === 'GET' && url.pathname === '/api/entities') {
            json(res, 200, [...entities.values()]);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/bots') {
            json(res, 200, store.listBots());
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/bots') {
            void readBody<{ name?: string; homeEntityId?: string; modelKey?: string }>(req).then((body) => {
                const name = (body.name ?? '').trim();
                if (name === '') return json(res, 400, { error: 'name required' });
                const bot: Bot = {
                    id: `bot-${Date.now().toString(36)}`,
                    name,
                    color: COLORS[store.listBots().length % COLORS.length]!,
                    persona: '实体专属 bot',
                    homeEntityId: body.homeEntityId ?? 'proj:diy',
                    modelKey: body.modelKey ?? DEFAULT_MODEL,
                };
                store.upsertBot(bot);
                entities.set(`bot:${bot.id}`, {
                    id: `bot:${bot.id}`,
                    kind: 'bot',
                    name: bot.name,
                    botIds: [bot.id],
                    modelKey: bot.modelKey,
                });
                const home = entities.get(bot.homeEntityId);
                if (home !== undefined) {
                    home.botIds = [...home.botIds, bot.id];
                    store.setEntityBots(home.id, home.botIds);
                }
                json(res, 200, bot);
            });
            return;
        }

        // POST /api/entities —— 新建项目/任务（owner bot 同名）
        if (req.method === 'POST' && url.pathname === '/api/entities') {
            void readBody<{ kind?: 'project' | 'task'; name?: string; dir?: string; projectId?: string }>(req).then((body) => {
                const name = (body.name ?? '').trim();
                const kind = body.kind ?? 'project';
                if (name === '') return json(res, 400, { error: 'name required' });
                const bot: Bot = {
                    id: `bot-${Date.now().toString(36)}`,
                    name,
                    color: COLORS[store.listBots().length % COLORS.length]!,
                    persona: kind === 'project' ? '项目 bot' : '任务 bot',
                    homeEntityId: '',
                    modelKey: DEFAULT_MODEL,
                };
                const id = kind === 'project' ? `proj:${name}-${Date.now().toString(36)}` : `task:${name}-${Date.now().toString(36)}`;
                bot.homeEntityId = id;
                store.upsertBot(bot);
                const entity: Entity = {
                    id,
                    kind,
                    name,
                    dir: body.dir,
                    projectId: body.projectId,
                    botIds: [bot.id],
                    modelKey: DEFAULT_MODEL,
                };
                entities.set(id, entity);
                entities.set(`bot:${bot.id}`, { id: `bot:${bot.id}`, kind: 'bot', name: bot.name, botIds: [bot.id], modelKey: bot.modelKey });
                store.setEntityBots(id, entity.botIds);
                json(res, 200, entity);
            });
            return;
        }

        // PATCH /api/entities/:id —— 改名 / 改模型
        if (req.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'entities' && parts.length === 3) {
            const id = decodeURIComponent(parts[2] ?? '');
            const entity = entities.get(id);
            if (entity === undefined) return json(res, 404, { error: 'entity not found' });
            void readBody<{ name?: string; modelKey?: string }>(req).then((body) => {
                if (body.name !== undefined && body.name.trim() !== '') {
                    entity.name = body.name.trim();
                    const owner = store.listBots().find((bot) => bot.id === entity.botIds[0]);
                    if (owner !== undefined) store.upsertBot({ ...owner, name: entity.name });
                }
                if (body.modelKey !== undefined) entity.modelKey = body.modelKey;
                json(res, 200, entity);
            });
            return;
        }

        // POST /api/entities/:id/bots —— 加入已有 bot（借用）
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'entities' && parts[3] === 'bots') {
            const id = decodeURIComponent(parts[2] ?? '');
            const entity = entities.get(id);
            if (entity === undefined) return json(res, 404, { error: 'entity not found' });
            void readBody<{ botId?: string }>(req).then((body) => {
                if (body.botId !== undefined && !entity.botIds.includes(body.botId)) {
                    entity.botIds = [...entity.botIds, body.botId];
                    store.setEntityBots(id, entity.botIds);
                }
                json(res, 200, entity);
            });
            return;
        }

        // /api/entities/:id/history
        if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'entities' && parts[3] === 'history') {
            const id = decodeURIComponent(parts[2] ?? '');
            const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0');
            json(res, 200, { items: store.itemsOf(id, afterSeq) });
            return;
        }

        if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'entities' && parts[3] === 'deliveries') {
            const id = decodeURIComponent(parts[2] ?? '');
            json(res, 200, { deliveries: store.listDeliveries(id) });
            return;
        }

        // /api/entities/:id/chat
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'entities' && parts[3] === 'chat') {
            const id = decodeURIComponent(parts[2] ?? '');
            const entity = entities.get(id);
            if (entity === undefined) return json(res, 404, { error: 'entity not found' });

            void readBody<{ text?: string }>(req).then((body) => {
                const text = (body.text ?? '').trim();
                if (text === '') return json(res, 400, { error: 'text required' });

                // 同一实体串行：上一轮没结束，这一轮排队等
                const run = (chains.get(id) ?? Promise.resolve()).then(async () => {
                    const participants = entity.botIds
                        .map((botId) => store.listBots().find((b) => b.id === botId))
                        .filter((bot): bot is Bot => bot !== undefined);
                    if (participants.length === 0) {
                        json(res, 400, { error: 'entity has no bot' });
                        return;
                    }

                    res.writeHead(200, {
                        'content-type': 'text/event-stream; charset=utf-8',
                        'cache-control': 'no-cache',
                        connection: 'keep-alive',
                    });

                    const now = Date.now();
                    const turn = nextTurn(id);
                    const turnId = `turn-${now.toString(36)}`;

                    const userItem: Item = {
                        id: `u-${now.toString(36)}`,
                        seq: store.seqOf(id) + 1,
                        order: nextOrder(id),
                        turn,
                        turnId,
                        at: now,
                        status: 'done',
                        author: { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' },
                        type: 'chat',
                        data: { text },
                    };
                    const savedUser = store.appendItem(id, userItem);
                    sse(res, { kind: 'item', item: savedUser });

                    const recipients = route(entity, participants, text);

                    // 路由结果落 outbox：先 queued，再逐条推进
                    for (const bot of recipients) {
                        const delivery = store.setDelivery({ entityId: id, messageId: savedUser.id, botId: bot.id, state: 'queued' });
                        sse(res, { kind: 'delivery', delivery });
                    }

                    const history = store
                        .itemsOf(id)
                        .filter((item) => item.type === 'chat')
                        .slice(-20)
                        .map((item) => ({
                            role: item.author?.role === 'human' ? ('user' as const) : ('assistant' as const),
                            content: (item.data as { text: string }).text,
                        }));

                    const abort = new AbortController();
                    req.on('close', () => abort.abort());
                    const projectors = new Map<string, Projector>();

                    // 同一轮内：多个 bot 并行；各自一条投影 + 一条 outbox
                    await Promise.all(
                        recipients.map(async (bot) => {
                            const delivering = store.setDelivery({ entityId: id, messageId: savedUser.id, botId: bot.id, state: 'delivering' });
                            sse(res, { kind: 'delivery', delivery: delivering });

                            const projector = new Projector(authorOf(bot), turn);
                            projectors.set(bot.id, projector);
                            const persisted = new Set<string>();
                            let failed = false;

                            try {
                                for await (const event of runAgent({ bot, modelKey: bot.modelKey, history, signal: abort.signal })) {
                                    if (event.type === 'run.failed') failed = true;
                                    for (const item of projector.apply(event)) {
                                        const ordered: Item = item.order === undefined ? { ...item, order: nextOrder(id) } : item;
                                        sse(res, { kind: 'item', item: ordered });
                                        if ((ordered.status === 'done' || ordered.status === 'failed') && !persisted.has(ordered.id)) {
                                            persisted.add(ordered.id);
                                            store.appendItem(id, ordered);
                                        }
                                    }
                                }
                            } catch (error) {
                                failed = true;
                                sse(res, { kind: 'error', message: error instanceof Error ? error.message : String(error) });
                            } finally {
                                const done = store.setDelivery({
                                    entityId: id,
                                    messageId: savedUser.id,
                                    botId: bot.id,
                                    state: failed ? 'failed' : 'delivered',
                                });
                                sse(res, { kind: 'delivery', delivery: done });
                            }
                        }),
                    );

                    // bot → bot：从回复文本里找 @（只允许单人，@all 忽略），只跳一层
                    const mentioned = new Set<string>();
                    for (const bot of recipients) {
                        const text = projectors
                            .get(bot.id)
                            ?.all()
                            .filter((item) => item.type === 'chat')
                            .map((item) => (item.type === 'chat' ? item.data.text : ''))
                            .join(' ') ?? '';
                        for (const name of [...text.matchAll(/@([^\s@]+)/g)].map((match) => match[1] ?? '')) {
                            if (name !== 'all') mentioned.add(name);
                        }
                    }

                    const already = new Set(recipients.map((bot) => bot.id));
                    const targets = participants
                        .filter((bot) => mentioned.has(bot.name) && !already.has(bot.id))
                        .slice(0, 1);

                    for (const target of targets) {
                        const notice: Item = {
                            id: `n-${Date.now().toString(36)}`,
                            seq: store.seqOf(id) + 1,
                            order: nextOrder(id),
                            turn,
                            turnId,
                            at: Date.now(),
                            status: 'done',
                            type: 'notice',
                            data: { text: `@${target.name} 被激活`, kind: 'mention' },
                        };
                        const savedNotice = store.appendItem(id, notice);
                        sse(res, { kind: 'item', item: savedNotice });

                        const history2 = store
                            .itemsOf(id)
                            .filter((item) => item.type === 'chat')
                            .slice(-20)
                            .map((item) => ({
                                role: item.author?.role === 'human' ? ('user' as const) : ('assistant' as const),
                                content: (item.data as { text: string }).text,
                            }));

                        const projector = new Projector(authorOf(target), turn);
                        const persisted = new Set<string>();
                        try {
                            for await (const event of runAgent({ bot: target, modelKey: target.modelKey, history: history2, signal: abort.signal })) {
                                for (const item of projector.apply(event)) {
                                    const ordered: Item = item.order === undefined ? { ...item, order: nextOrder(id) } : item;
                                    sse(res, { kind: 'item', item: ordered });
                                    if ((ordered.status === 'done' || ordered.status === 'failed') && !persisted.has(ordered.id)) {
                                        persisted.add(ordered.id);
                                        store.appendItem(id, ordered);
                                    }
                                }
                            }
                        } catch (error) {
                            sse(res, { kind: 'error', message: error instanceof Error ? error.message : String(error) });
                        }
                    }

                    sse(res, { kind: 'done' });
                    res.end();
                });
                chains.set(id, run.catch(() => undefined));
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
