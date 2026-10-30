// actions.ts — 读 / 写 bot 与「测试对话」的**纯函数层**（不碰 DOM、不认识 Electron）。
//
// 三件事：
//   ① bot 身份读写全走 @diy-agent/bot 的 BotStore（本文件不自己拼路径）
//   ② 测试对话 = 真 Session + **内存存储**（@diy-agent/session-store-memory）：
//      **一个字节不落盘**，也不出现在会话列表（##474 判据 4）
//   ③ 参数来自 renderer 的一律先校验成强类型（形状不对就抛，不猜）

import {
    createFileBotStore,
    type BotConfig,
    type BotId,
    type BotStore,
} from '@diy-agent/bot';
import { createOpenAiCompatible, resolveProviderConfig } from '@diy-agent/llm-provider';
import { loadCatalog, readAccountValue, readDefaultModel, type ModelCatalogEntry } from '@diy-agent/model-catalog';
import { createSession, type AgentSession, type ChatMessage, type LlmPort } from '@diy-agent/session';
import { openMemorySessionStore } from '@diy-agent/session-store-memory';
import { BotConfigPageError } from './errors.js';
import type { BotSnapshot, BotView, ModelOptionView, TestChatView, TestMessageView } from './shared.js';

/** 建动作表的选项（测试注入 clock / llmFor；缺省 = 真模型、真时间） */
export interface BotActionsOptions {
    /** 数据根（`$DIY_HOME`） */
    readonly home: string;
    /** 时间源；缺省 = 现在 */
    readonly clock?: () => Date;
    /** 建 LLM 端口（测试注入假实现；缺省 = 按模型目录 + provider key 建真 provider） */
    readonly llmFor?: (modelKey: string) => LlmPort;
}

export interface BotActions {
    snapshot(): Promise<BotSnapshot>;
    create(args: unknown): Promise<BotSnapshot>;
    save(args: unknown): Promise<BotSnapshot>;
    remove(args: unknown): Promise<BotSnapshot>;
    testSend(args: unknown): Promise<TestChatView>;
    testReset(args: unknown): Promise<TestChatView>;
}

/** 建一份动作表（每个页面实例一份：测试对话会按 bot 缓存内存会话，随页面关闭消失） */
export function createBotActions(options: BotActionsOptions): BotActions {
    const home = options.home;
    const now = options.clock ?? (() => new Date());
    const store: BotStore = createFileBotStore({ home, sessionsDir: sessionsDirOf(home) });

    let catalogCache: ModelCatalogEntry[] | null = null;
    const catalog = (): ModelCatalogEntry[] => (catalogCache ??= loadCatalog(home));

    const models = (): ModelOptionView[] =>
        catalog().map((entry) => ({ providerId: entry.providerId, modelId: entry.modelId, name: entry.name }));

    /** 测试对话的会话（**只在内存里**；key = botId） */
    const testSessions = new Map<string, AgentSession>();

    const viewOf = async (config: BotConfig): Promise<BotView> => ({
        id: config.id,
        name: config.name,
        instructions: config.instructions,
        model: config.model ?? null,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
        sessionCount: (await store.sessionsOf(config.id)).length,
    });

    const snapshot = async (): Promise<BotSnapshot> => ({
        home,
        bots: await Promise.all((await store.list()).map(viewOf)),
        models: models(),
        defaultModel: readDefaultModel(home),
    });

    /** 新建一个 bot（id 缺省 = `bot-<n>`，n 取现有最大 + 1） */
    const create = async (args: unknown): Promise<BotSnapshot> => {
        const input = recordOf(args, 'create');
        const name = requiredString(input['name'], 'name');
        const instructions = optionalString(input['instructions'], 'instructions') ?? '';
        const model = modelOf(input['model']);
        const existing = await store.list();
        if (existing.some((config) => config.name === name)) {
            // 名字只是标签，允许重名会让人分不清谁是谁；这里挡一下（id 才是引用键）
            throw new BotConfigPageError('bot-config/id-taken', `已经有同名 bot「${name}」`);
        }
        const id = optionalString(input['id'], 'id') ?? nextBotId(existing.map((config) => config.id));
        if (existing.some((config) => config.id === id)) {
            throw new BotConfigPageError('bot-config/id-taken', `bot id 已存在：${id}`);
        }
        checkModel(model);
        const at = now().toISOString();
        await store.save({
            id,
            name,
            instructions,
            ...(model === null ? {} : { model }),
            createdAt: at,
            updatedAt: at,
        });
        return snapshot();
    };

    /** 改身份（name / instructions / model）；换配置后旧的测试会话丢弃（下一轮按新配置开） */
    const save = async (args: unknown): Promise<BotSnapshot> => {
        const input = recordOf(args, 'save');
        const id = requiredString(input['id'], 'id');
        const current = await store.load(id);
        if (current === null) throw new BotConfigPageError('bot-config/not-found', `没有 bot ${id}`);
        const name = requiredString(input['name'], 'name');
        const instructions = optionalString(input['instructions'], 'instructions') ?? current.instructions;
        const model = input['model'] === undefined ? (current.model ?? null) : modelOf(input['model']);
        checkModel(model);
        const next: BotConfig = {
            id: current.id,
            name,
            instructions,
            ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
            ...(current.maxOutputTokens === undefined ? {} : { maxOutputTokens: current.maxOutputTokens }),
            createdAt: current.createdAt,
            updatedAt: now().toISOString(),
            // 空模型 = 跟随缺省：**不写这个键**（与任务的 persona 同一套「缺省不写」约定）
            ...(model === null ? {} : { model }),
        };
        await store.save(next);
        testSessions.delete(id);
        return snapshot();
    };

    /** 删 bot（只删 `bots/<id>/`；会话目录一个不动） */
    const remove = async (args: unknown): Promise<BotSnapshot> => {
        const input = recordOf(args, 'remove');
        const id = requiredString(input['id'], 'id');
        testSessions.delete(id);
        await store.remove(id);
        return snapshot();
    };

    /** 测试对话：说一句、收一句（走真模型；会话只活在内存里） */
    const testSend = async (args: unknown): Promise<TestChatView> => {
        const input = recordOf(args, 'testSend');
        const id = requiredString(input['id'], 'id');
        const text = requiredString(input['text'], 'text');
        const config = await store.load(id);
        if (config === null) throw new BotConfigPageError('bot-config/not-found', `没有 bot ${id}`);
        const session = await testSessionOf(config);
        if (session.busy) throw new BotConfigPageError('bot-config/busy', '上一句还没答完');
        for await (const _delta of session.send(text)) {
            // 页面不需要增量；消息线在 session 里自己攒
        }
        return testChatView(id, session);
    };

    /** 丢弃测试对话（下一次从零开始；内存里也没有残留） */
    const testReset = async (args: unknown): Promise<TestChatView> => {
        const input = recordOf(args, 'testReset');
        const id = requiredString(input['id'], 'id');
        testSessions.delete(id);
        return { botId: id, messages: [], usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ephemeral: true };
    };

    // ── 测试会话（内存） ─────────────────────────────

    const testSessionOf = async (config: BotConfig): Promise<AgentSession> => {
        const hit = testSessions.get(config.id);
        if (hit !== undefined) return hit;
        const { key, modelId } = resolveModelKey(home, config, catalog());
        const session = createSession({
            id: `test-${config.id}`,
            llm: (options.llmFor ?? defaultLlmFor(home))(key),
            // ⚠️ 内存存储：进程退出即消失，**不产生任何文件**（判据 4）
            store: openMemorySessionStore({ maxEntries: 200 }),
            ...(modelId === '' ? {} : { model: modelId }),
            ...(config.instructions.trim() === '' ? {} : { system: config.instructions }),
        });
        testSessions.set(config.id, session);
        return session;
    };

    const checkModel = (model: string | null): void => {
        if (model === null) return;
        const found = catalog().some((entry) => `${entry.providerId}/${entry.modelId}` === model);
        if (!found) {
            throw new BotConfigPageError('bot-config/unknown-model', `模型目录里没有 ${model}`);
        }
    };

    return { snapshot, create, save, remove, testSend, testReset };
}

/** 会话目录（与 apps/chat 的会话宿主一致：`<home>/sessions/chat`；bot 列表的会话数靠它） */
function sessionsDirOf(home: string): string {
    return `${home.replace(/\/+$/, '')}/sessions/chat`;
}

/** 解决「这个 bot 用哪个模型」：bot.model → model.yaml 的 defaultModel → 目录第一个 */
export function resolveModelKey(
    home: string,
    config: BotConfig,
    catalog: readonly ModelCatalogEntry[],
): { key: string; modelId: string } {
    const candidates = [config.model ?? null, readDefaultModel(home), entryKey(catalog[0])];
    for (const candidate of candidates) {
        if (candidate === null || candidate === '') continue;
        const entry = catalog.find((item) => `${item.providerId}/${item.modelId}` === candidate);
        if (entry !== undefined) return { key: candidate, modelId: entry.modelId };
    }
    throw new BotConfigPageError(
        'bot-config/no-model',
        '模型目录里没有可用模型 —— 先到「模型配置」添加 provider / 模型，或给 bot 指定一个模型',
    );
}

function entryKey(entry: ModelCatalogEntry | undefined): string | null {
    return entry === undefined ? null : `${entry.providerId}/${entry.modelId}`;
}

/** 缺省 LLM：与 apps/chat 的会话宿主同一套解析（key 只在这里取，不打印、不进快照） */
function defaultLlmFor(home: string): (modelKey: string) => LlmPort {
    return (modelKey) => {
        const at = modelKey.indexOf('/');
        const providerId = at <= 0 ? modelKey : modelKey.slice(0, at);
        const modelId = at <= 0 ? '' : modelKey.slice(at + 1);
        const entry = loadCatalog(home).find(
            (item) => item.providerId === providerId && item.modelId === modelId,
        );
        if (entry === undefined) {
            throw new BotConfigPageError('bot-config/unknown-model', `模型目录里没有 ${modelKey}`);
        }
        const apiKey = readAccountValue(home, providerId);
        try {
            return createOpenAiCompatible(
                resolveProviderConfig({ provider: providerId, apiKey, model: modelId, baseURL: entry.baseURL }),
            );
        } catch {
            // provider 表里没有的 custom provider：目录给的 baseURL 直接用（仍是 OpenAI 兼容面）
            return createOpenAiCompatible({ name: providerId, baseURL: entry.baseURL, apiKey, model: modelId });
        }
    };
}

function testChatView(botId: string, session: AgentSession): TestChatView {
    return {
        botId,
        messages: wireOf(session.messages),
        usage: { ...session.usage },
        ephemeral: true,
    };
}

/** session 消息 → 线上形状（只留 user / assistant 且正文非空） */
export function wireOf(messages: readonly ChatMessage[]): TestMessageView[] {
    const out: TestMessageView[] = [];
    for (const message of messages) {
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        out.push({ role: message.role, text: message.text ?? '' });
    }
    return out;
}

/** 新 bot id：`bot-<n>`，n = 现有 `bot-<数字>` 的最大值 + 1（人可读，与任务号同思路） */
export function nextBotId(existing: Iterable<BotId>): BotId {
    let max = 0;
    for (const id of existing) {
        const match = /^bot-(\d+)$/.exec(id);
        if (match !== null) max = Math.max(max, Number(match[1]));
    }
    return `bot-${max + 1}`;
}

// ── 入参校验 ─────────────────────────────────────

function recordOf(args: unknown, method: string): Record<string, unknown> {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new BotConfigPageError('bot-config/bad-args', `${method} 需要对象参数`);
    }
    return args as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
    const text = optionalString(value, field);
    if (text === undefined || text.trim() === '') {
        throw new BotConfigPageError('bot-config/bad-args', `${field} 必须是非空字符串`);
    }
    return text.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
        throw new BotConfigPageError('bot-config/bad-args', `${field} 必须是字符串`);
    }
    return value;
}

/** 模型字段：空串 / null = 跟随缺省（bot.json 里不写这个键） */
function modelOf(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
        throw new BotConfigPageError('bot-config/bad-args', 'model 必须是字符串或 null');
    }
    return value.trim() === '' ? null : value.trim();
}
