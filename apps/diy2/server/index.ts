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

import { Inbox, Projector, openStore, runAgent, type Author, type Bot, type Entity, type Item } from '@diy-agent/entity-runtime';

const PORT = Number(process.env['DIY2_PORT'] ?? 5191);
const DEFAULT_MODEL = 'chen56@opencode-go/deepseek-v4.1-flash';

const dataDir = join(homedir(), '.diy', 'diy2');
mkdirSync(dataDir, { recursive: true });
const store = openStore(join(dataDir, 'diy2.db'));
const inbox = new Inbox(store.db);

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
        bots = [diy, cops, task];
    }

    const byName = (name: string): Bot | undefined => bots.find((bot) => bot.name === name);
    const entities = new Map<string, Entity>();
    entities.set('proj:diy', {
        id: 'proj:diy',
        kind: 'project',
        name: 'diy',
        dir: '~/git/diy/diy',
        botIds: [byName('diy')?.id ?? bots[0]!.id],
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
                if (home !== undefined) home.botIds = [...home.botIds, bot.id];
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
                if (body.botId !== undefined && !entity.botIds.includes(body.botId)) entity.botIds = [...entity.botIds, body.botId];
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

        // /api/entities/:id/chat
        if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'entities' && parts[3] === 'chat') {
            const id = decodeURIComponent(parts[2] ?? '');
            const entity = entities.get(id);
            if (entity === undefined) return json(res, 404, { error: 'entity not found' });

            void readBody<{ text?: string }>(req).then(async (body) => {
                const text = (body.text ?? '').trim();
                if (text === '') return json(res, 400, { error: 'text required' });
                const botId = entity.botIds[0];
                const bot = botId === undefined ? undefined : store.listBots().find((b) => b.id === botId);
                if (bot === undefined) return json(res, 400, { error: 'entity has no bot' });

                res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                });

                const now = Date.now();
                // 1) 用户消息：先落 inbox，再落时间线
                inbox.post(id, 'chat', { text }, 'now');
                const claimed = inbox.drain(id);
                const userItem: Item = {
                    id: `u-${now.toString(36)}`,
                    seq: store.seqOf(id) + 1,
                    turnId: `turn-${now.toString(36)}`,
                    at: now,
                    status: 'done',
                    author: { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' },
                    type: 'chat',
                    data: { text },
                };
                const savedUser = store.appendItem(id, userItem);
                sse(res, { kind: 'item', item: savedUser });

                // 2) 组装历史（最近 20 条文本）
                const history = store
                    .itemsOf(id)
                    .filter((item) => item.type === 'chat')
                    .slice(-20)
                    .map((item) => ({
                        role: item.author?.role === 'human' ? ('user' as const) : ('assistant' as const),
                        content: (item.data as { text: string }).text,
                    }));

                // 3) 跑 agent，逐事件投影 + 推送
                const abort = new AbortController();
                req.on('close', () => abort.abort());
                const projector = new Projector(authorOf(bot));
                const persisted = new Set<string>();

                try {
                    for await (const event of runAgent({ bot, modelKey: bot.modelKey, history, signal: abort.signal })) {
                        for (const item of projector.apply(event)) {
                            sse(res, { kind: 'item', item });
                            if (item.status === 'done' && !persisted.has(item.id)) {
                                persisted.add(item.id);
                                store.appendItem(id, item);
                            }
                        }
                    }
                } catch (error) {
                    sse(res, { kind: 'error', message: error instanceof Error ? error.message : String(error) });
                } finally {
                    inbox.complete(claimed.map((item) => item.id));
                    sse(res, { kind: 'done' });
                    res.end();
                }
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
