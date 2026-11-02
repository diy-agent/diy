// sessions.ts — 多 bot 宿主（apps/chat 的实现，注入给 @diy-agent/chat-page 的 config.sessions）。
//
// ##498：这是「chat 以 bot 为中心」那一刀的数据层：
//   · 左栏是 **bot**（`$DIY_HOME/bots/<id>/bot.json`），不是会话
//   · 一个 bot 一个**长期会话**：`bot.primary()` 懒创建 + 幂等，id 写回 bot.json
//   · 会话本体还是老地方：`$DIY_HOME/sessions/chat/<id>/`（meta.json + @diy-agent/session-store-jsonl 的桶）
//   · **没有「新建会话」**：要新对话 = 新建 bot（或以后做「重置这个 bot 的对话」，本刀不做）
//
// 边界（##465）：
//   · 模型目录由 @diy-agent/model-catalog 投影（只有名字，无 key）
//   · key 只在建 provider 的那一刻从 readAccountValue 取，**不打印、不落盘**
//   · 真 provider 走 @diy-agent/llm-provider；provider 表没有的（custom）直接用 catalog 的 baseURL
//
// ##497：bots 为空 ⇒ snapshot.bot = null（UI 走首启引导）；模型是 bot 身份的一部分。
//
// ##480（store 方向）：session 的缺省存储是**内存**，所以装配器（本文件）必须**显式**构造并注入
// jsonl store —— 不注入的话消息不落盘、重启就没了。

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localISOString } from "@diy-agent/time";
import {
    createBot,
    createFileBotStore,
    createFirstBot as createFirstBotIn,
    type Bot,
    type BotConfig,
} from "@diy-agent/bot";
import { createSession, type AgentSession, type ChatMessage, type LlmPort, type TokenUsage } from "@diy-agent/session";
import { openJsonlSessionStore, type JsonlSessionStore } from "@diy-agent/session-store-jsonl";
import { createOpenAiCompatible, resolveProviderConfig } from "@diy-agent/llm-provider";
import { loadCatalog, readAccountValue, type ModelCatalogCost, type ModelCatalogEntry } from "@diy-agent/model-catalog";
import {
    wireOf,
    type BotDraftInput,
    type BotUpdateInput,
    type BotView,
    type ChatMetrics,
    type ChatSessionHost,
    type ChatSnapshot,
    type FirstBotInput,
    type ModelChoice,
    type WireMessage,
} from "@diy-agent/chat-page";

/** `meta.json` 的形状（会话自己的身份；消息正文在桶里） */
interface SessionMeta {
    readonly id: string;
    readonly title: string;
    /** 模型限定名 `providerId/modelId` */
    readonly model: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly messageCount: number;
}

/** `$DIY_HOME/chat-ui.json`：只记「上次选中的 bot」这类界面状态（不是领域真源） */
interface UiState {
    activeBotId?: string;
}

/** 上一步的用量（底部指标条的「输入 / 缓存 / 本轮」都取这一步，不是会话累计） */
interface StepUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
}

/**
 * 首启草案的**缺省名字 / 指令**（##497）。
 *
 * 注意没有 model：模型必须人来选，不给缺省 —— 以前 `DEFAULT_BOT` 静默建 bot 正是
 * 「用户从没选过模型却已经在聊」的病因。
 */
export const FIRST_BOT_DRAFT = {
    id: "bot-1",
    name: "大王助手",
    instructions: "你是「大王助手」，在 diy 的聊天窗口里陪大王干活。回答要短、要具体，能查证的不靠猜。",
} as const;

export interface ChatSessionsOptions {
    /** 数据根（`$DIY_HOME`） */
    readonly home: string;
    /** 建 LLM 端口（测试注入假实现；缺省 = 真 provider，key 从 readAccountValue 取） */
    readonly llmFor?: (modelKey: string) => LlmPort;
}

/** 把 `providerId/modelId` 切开（模型 id 自身可含 `/`，按第一个 `/` 切） */
export function splitModelKey(key: string): { providerId: string; modelId: string } {
    const at = key.indexOf("/");
    if (at <= 0 || at === key.length - 1) return { providerId: key, modelId: "" };
    return { providerId: key.slice(0, at), modelId: key.slice(at + 1) };
}

/** 新 bot id：`bot-<n>`，n = 现有 `bot-<数字>` 的最大值 + 1（人可读） */
export function nextBotId(existing: Iterable<string>): string {
    let max = 0;
    for (const id of existing) {
        const match = /^bot-(\d+)$/.exec(id);
        if (match !== null) max = Math.max(max, Number(match[1]));
    }
    return `bot-${String(max + 1)}`;
}

/**
 * 单实例 = 单 actor（docs/plans/2026-11-02-concurrency-actor.md）。
 *
 * 一个宿主一份队列：所有会**改变状态**的操作（读—改—写）排进来，一次跑一个。
 * 纯读（snapshot）不排队 —— 读不需要互斥，只要写是串行的。
 *
 * `tail` 永远指向「最后一个入队的操作」，且**吞掉失败**（前一个抛错，下一个照常跑）。
 */
export type Serial = <T>(fn: () => Promise<T>) => Promise<T>;

export function createSerial(): Serial {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
        const next = tail.then(fn, fn);
        tail = next.catch(() => {});
        return next;
    };
}

/** 建一个多 bot 宿主（懒打开：第一次调用才读目录 / 建目录） */
export function createChatSessions(options: ChatSessionsOptions): ChatSessionHost {
    const home = options.home;
    const root = join(home, "sessions", "chat");
    // bot 身份在 `<home>/bots/`；会话归属落在会话自己的目录里（方案 B）
    const botStore = createFileBotStore({ home, sessionsDir: root });
    const uiFile = join(home, "chat-ui.json");

    let catalogCache: ModelCatalogEntry[] | null = null;
    let ui: UiState | null = null;

    /** 打开中的会话（桶 + session 都缓存；同一个 bot 反复点进来必须是同一条消息线） */
    const open = new Map<string, { store: JsonlSessionStore; session: AgentSession; meta: SessionMeta }>();
    /** 每个会话「上一步」的用量（进程内；重启后指标为空 — 不编数字） */
    const lastStep = new Map<string, StepUsage>();
    /** 状态操作的队列（bot 增删改 / 选中 / meta 落盘）—— 单实例顺序执行 */
    const act = createSerial();
    /** 每个会话一条消息队列：同一会话的两条 send 也串行（不同会话互不阻塞） */
    const messageQueues = new Map<string, Serial>();
    const queueFor = (sessionId: string): Serial => {
        const hit = messageQueues.get(sessionId);
        if (hit !== undefined) return hit;
        const queue = createSerial();
        messageQueues.set(sessionId, queue);
        return queue;
    };

    const catalog = (): ModelCatalogEntry[] => (catalogCache ??= loadCatalog(home));

    const choices = (): ModelChoice[] =>
        catalog().map((entry) => ({
            providerId: entry.providerId,
            modelId: entry.modelId,
            name: entry.name,
        }));

    const keyOf = (entry: ModelCatalogEntry | null): string =>
        entry === null ? "" : `${entry.providerId}/${entry.modelId}`;

    const loadUi = async (): Promise<UiState> => {
        if (ui !== null) return ui;
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(await readFile(uiFile, "utf-8"));
        } catch {
            // 没有就是没有（首启 / 老数据）—— 默认选第一个 bot
        }
        const record = parsed !== null && typeof parsed === "object" ? (parsed as { activeBotId?: unknown }) : {};
        ui = typeof record.activeBotId === "string" ? { activeBotId: record.activeBotId } : {};
        return ui;
    };

    const saveUi = async (): Promise<void> => {
        const state = ui ?? {};
        await mkdir(home, { recursive: true });
        await writeFile(uiFile, `${JSON.stringify(state, null, 4)}\n`, "utf-8");
    };

    const writeMeta = async (meta: SessionMeta): Promise<void> => {
        const dir = join(root, meta.id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 4)}\n`, "utf-8");
    };

    const llmFor = (modelKey: string): LlmPort => {
        if (options.llmFor !== undefined) return options.llmFor(modelKey);
        const { providerId, modelId } = splitModelKey(modelKey);
        const entry = catalog().find((item) => item.providerId === providerId && item.modelId === modelId);
        if (entry === undefined) {
            throw new Error(`模型目录里没有 ${modelKey}（model.yaml / providers.custom.yaml 可能变了）`);
        }
        const apiKey = readAccountValue(home, providerId);
        try {
            // 已知 provider：拿 provider 表的默认 endpoint / 会话 header
            return createOpenAiCompatible(
                resolveProviderConfig({ provider: providerId, apiKey, model: modelId, baseURL: entry.baseURL }),
            );
        } catch {
            // 表里没有的 custom provider：catalog 的 baseURL 直接用（仍然 OpenAI 兼容面）
            return createOpenAiCompatible({ name: providerId, baseURL: entry.baseURL, apiKey, model: modelId });
        }
    };

    /** 建一个 bot 句柄：createSession 回调负责建会话目录（meta.json），归属由 bot 包写 */
    const handleOf = (config: BotConfig): Bot =>
        createBot({
            store: botStore,
            config,
            createSession: async (bot) => {
                const now = localISOString();
                const meta: SessionMeta = {
                    id: newSessionId(),
                    title: "新会话",
                    model: bot.model,
                    createdAt: now,
                    updatedAt: now,
                    messageCount: 0,
                };
                await writeMeta(meta);
                return meta.id;
            },
        });

    const opened = async (
        id: string,
    ): Promise<{ store: JsonlSessionStore; session: AgentSession; meta: SessionMeta }> => {
        const hit = open.get(id);
        if (hit !== undefined) return hit;
        const dir = join(root, id);
        const meta = await readMeta(dir);
        if (meta === null) throw new Error(`没有会话 ${id}`);
        // ##498：模型以 **bot 的当前配置**为准（一个 bot 一条长期会话，改模型就是改这条会话）
        const ownerId = await botStore.ownerOf(id);
        const owner = ownerId === null ? null : await botStore.load(ownerId);
        const modelKey = owner !== null && owner.model.trim() !== "" ? owner.model : meta.model;
        const instructions = owner?.instructions.trim() ?? "";
        // ##480：装配器是决定者 —— 直接构造 jsonl store（session 自己的缺省是内存 store），
        // 传实例而不是策略名：将来换远程 store 只改这一行，不存在 switch 分派。
        const store = await openJsonlSessionStore({ dir });
        const initialMessages: readonly ChatMessage[] = await store.readFrom(0);
        const { modelId } = splitModelKey(modelKey);
        const session = createSession({
            id,
            llm: llmFor(modelKey),
            store,
            initialMessages,
            ...(modelId === "" ? {} : { model: modelId }),
            // 行为指令 = system 话术；只在新建会话时写一次（历史里已经有一条，别重复追加）
            ...(initialMessages.length === 0 && instructions !== "" ? { system: instructions } : {}),
        });
        const nextMeta: SessionMeta = meta.model === modelKey ? meta : { ...meta, model: modelKey };
        if (nextMeta !== meta) await writeMeta(nextMeta);
        const value = { store, session, meta: nextMeta };
        open.set(id, value);
        return value;
    };

    /** bot 配置 → 左栏一行（sessionCount 是扫会话目录的投影，不是 bot.json 的一部分） */
    const botView = async (config: BotConfig): Promise<BotView> => ({
        id: config.id,
        name: config.name,
        instructions: config.instructions,
        model: config.model,
        needsModel: config.needsModel === true || config.model.trim() === "",
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
        sessionCount: (await botStore.sessionsOf(config.id)).length,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
    });

    /** 底部指标：上一步的桶 + 模型目录里的窗口 / 价目（缺就缺席，不补 0） */
    const metricsOf = (config: BotConfig, sessionId: string, usage: TokenUsage): ChatMetrics => {
        const last = lastStep.get(sessionId);
        const entry = catalog().find((item) => keyOf(item) === config.model) ?? null;
        const cost = last === undefined ? undefined : stepCost(entry?.cost, last);
        return {
            ...(last === undefined ? {} : { inputTokens: last.inputTokens, outputTokens: last.outputTokens }),
            ...(last?.cacheReadTokens === undefined ? {} : { cacheReadTokens: last.cacheReadTokens }),
            ...(entry?.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
            ...(cost === undefined ? {} : { cost }),
            turns: usage.turns,
        };
    };

    /** 当前 bot（上次选中的那个；没有 / 已删 ⇒ 列表第一个） */
    const activeConfig = async (): Promise<BotConfig | null> => {
        const configs = await botStore.list();
        if (configs.length === 0) return null;
        const state = await loadUi();
        const active = configs.find((config) => config.id === state.activeBotId) ?? configs[0]!;
        if (state.activeBotId !== active.id) {
            state.activeBotId = active.id;
            await saveUi();
        }
        return active;
    };

    const snapshot = async (): Promise<ChatSnapshot> => {
        const configs = await botStore.list();
        const bots = await Promise.all(configs.map(botView));
        const selectedModel = keyOf(catalog()[0] ?? null) || null;
        const active = configs.length === 0 ? null : ((await activeConfig()) ?? configs[0]!);
        if (active === null) {
            return {
                bots: [],
                bot: null,
                models: choices(),
                activeId: null,
                messages: [],
                metrics: null,
                selectedModel,
            };
        }
        // 存量 bot 没选过模型（##497）：UI 要先拦到配置页 —— 这里也不能替它开会话
        if (active.needsModel === true || active.model.trim() === "") {
            return {
                bots,
                bot: await botView(active),
                models: choices(),
                activeId: null,
                messages: [],
                metrics: null,
                selectedModel,
            };
        }
        // 长期会话：第一次进来才建（幂等；建过就一直是它 —— 判据 3/4）
        const ref = await handleOf(active).primary();
        const current = await opened(ref.id);
        const messages: readonly WireMessage[] = wireOf(current.session.messages);
        return {
            bots,
            bot: await botView(active),
            models: choices(),
            activeId: ref.id,
            messages,
            metrics: metricsOf(active, ref.id, current.session.usage),
            selectedModel,
        };
    };

    /** 模型必须是目录里的（##497：没有「跟随宿主缺省」这条路） */
    const checkModel = (model: string): string => {
        if (model.trim() === "") throw new Error("必须先选一个模型（bot 的 model 必填）");
        const found = catalog().some((entry) => keyOf(entry) === model);
        if (!found) throw new Error(`模型目录里没有 ${model}`);
        return model;
    };

    const focus = async (id: string): Promise<void> => {
        const state = await loadUi();
        state.activeBotId = id;
        await saveUi();
    };

    return {
        snapshot,

        /** 首启建 bot（##497：必须有 model；已存在则报错） */
        createFirstBot(input: FirstBotInput): Promise<ChatSnapshot> {
            return act(async () => {
                const config = await createFirstBotIn(botStore, {
                    id: FIRST_BOT_DRAFT.id,
                    name: input.name?.trim() || FIRST_BOT_DRAFT.name,
                    instructions: input.instructions ?? FIRST_BOT_DRAFT.instructions,
                    model: checkModel(input.model),
                });
                await focus(config.id);
                return snapshot();
            });
        },

        /** `+ 新 bot`：建好即选中（点进去就是它的长期会话） */
        createBot(input: BotDraftInput): Promise<ChatSnapshot> {
            return act(async () => {
                const name = input.name.trim();
                if (name === "") throw new Error("新 bot 必须有个名字");
                const existing = await botStore.list();
                if (existing.some((config) => config.name === name)) {
                    throw new Error(`已经有同名 bot「${name}」`);
                }
                const model = checkModel(input.model);
                const at = localISOString();
                const config: BotConfig = {
                    id: nextBotId(existing.map((item) => item.id)),
                    name,
                    instructions: input.instructions ?? "",
                    model,
                    ...(input.reasoningEffort === undefined || input.reasoningEffort === ""
                        ? {}
                        : { reasoningEffort: input.reasoningEffort }),
                    createdAt: at,
                    updatedAt: at,
                };
                await botStore.save(config);
                await focus(config.id);
                return snapshot();
            });
        },

        /** 改配置：模型 / 指令变了 ⇒ 把打开中的会话丢掉重开（llm 与 system 都要重新装配） */
        updateBot(input: BotUpdateInput): Promise<ChatSnapshot> {
            return act(async () => {
                const current = await botStore.load(input.id);
                if (current === null) throw new Error(`没有 bot ${input.id}`);
                const name = (input.name ?? current.name).trim();
                if (name === "") throw new Error("名字不能为空");
                const model = input.model === undefined ? current.model : checkModel(input.model);
                const instructions = input.instructions ?? current.instructions;
                const effort =
                    input.reasoningEffort === undefined
                        ? current.reasoningEffort
                        : input.reasoningEffort.trim() === ""
                          ? undefined
                          : input.reasoningEffort;
                const next: BotConfig = {
                    id: current.id,
                    name,
                    instructions,
                    model,
                    ...(current.primarySessionId === undefined
                        ? {}
                        : { primarySessionId: current.primarySessionId }),
                    ...(effort === undefined ? {} : { reasoningEffort: effort }),
                    ...(current.maxOutputTokens === undefined ? {} : { maxOutputTokens: current.maxOutputTokens }),
                    createdAt: current.createdAt,
                    updatedAt: localISOString(),
                };
                await botStore.save(next);
                if (model !== current.model || instructions !== current.instructions) {
                    if (current.primarySessionId !== undefined) open.delete(current.primarySessionId);
                }
                return snapshot();
            });
        },

        /** 删 bot（##498 判据 7：它的**会话一并删除**）—— 级联是应用策略，bot 包本身只删身份 */
        removeBot(id: string): Promise<ChatSnapshot> {
            return act(async () => {
                const refs = await botStore.sessionsOf(id);
                for (const ref of refs) {
                    await rm(join(root, ref.id), { recursive: true, force: true });
                    open.delete(ref.id);
                    lastStep.delete(ref.id);
                    messageQueues.delete(ref.id);
                }
                await botStore.remove(id);
                const state = await loadUi();
                if (state.activeBotId === id) {
                    delete state.activeBotId;
                    await saveUi();
                }
                return snapshot();
            });
        },

        /** 切 bot = 打开它的长期会话（只改「上次选中」，也走队列） */
        selectBot(id: string): Promise<ChatSnapshot> {
            return act(async () => {
                const config = await botStore.load(id);
                if (config === null) throw new Error(`没有 bot ${id}`);
                await focus(id);
                return snapshot();
            });
        },

        send(text, onDelta): Promise<ChatSnapshot> {
            // 消息也串行 —— 但**按会话**排：同一会话两条 send 不并发（否则 session 直接 busy），
            // 不同会话 / bot 增删改 互不阻塞（LLM 回复可能几十秒，不该把整个 UI 卡住）
            return (async () => {
                const active = await activeConfig();
                if (active === null) throw new Error("还没有 bot —— 先建一个（首启引导）");
                const ref = await handleOf(active).primary();
                return queueFor(ref.id)(async () => {
                const { session, meta } = await opened(ref.id);
                const before = session.messages.length;
                const usageBefore = session.usage;
                for await (const delta of session.send(text)) {
                    if (delta.type === "text") onDelta(wireOf(session.messages));
                }
                const messages = wireOf(session.messages);
                onDelta(messages);

                // 上一步的桶 = 累计值的差（底部指标条要的是「这一步」，不是「这条会话」）
                const usageAfter = session.usage;
                lastStep.set(ref.id, {
                    inputTokens: usageAfter.inputTokens - usageBefore.inputTokens,
                    outputTokens: usageAfter.outputTokens - usageBefore.outputTokens,
                    ...(usageAfter.cacheReadTokens === undefined
                        ? {}
                        : { cacheReadTokens: usageAfter.cacheReadTokens - (usageBefore.cacheReadTokens ?? 0) }),
                });

                const grown = session.messages.length - before;
                const next: SessionMeta = {
                    ...meta,
                    title: meta.title === "新会话" && messages.length > 0 ? titleFrom(text) : meta.title,
                    updatedAt: localISOString(),
                    messageCount: meta.messageCount + Math.max(grown, 0),
                };
                await writeMeta(next);
                open.set(ref.id, { store: open.get(ref.id)!.store, session, meta: next });
                return { ...(await snapshot()), messages, activeId: ref.id };
                });
            })();
        },
    };
}

/** 上一步花费（USD）：目录价目 × tokens（无价目 ⇒ undefined，不编 0） */
function stepCost(cost: ModelCatalogCost | undefined, step: StepUsage): number | undefined {
    if (cost === undefined) return undefined;
    const cacheRead = step.cacheReadTokens ?? 0;
    const input = step.inputTokens - cacheRead;
    const total =
        (input * cost.input + step.outputTokens * cost.output) / 1_000_000 +
        (cacheRead * (cost.cacheRead ?? cost.input)) / 1_000_000;
    return total;
}

function newSessionId(): string {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleFrom(text: string): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > 20 ? `${oneLine.slice(0, 20)}…` : oneLine || "新会话";
}

async function readMeta(dir: string): Promise<SessionMeta | null> {
    try {
        const raw = await readFile(join(dir, "meta.json"), "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return null;
        const meta = parsed as Partial<Record<keyof SessionMeta, unknown>>;
        if (typeof meta.id !== "string" || typeof meta.title !== "string" || typeof meta.model !== "string")
            return null;
        return {
            id: meta.id,
            title: meta.title,
            model: meta.model,
            createdAt: typeof meta.createdAt === "string" ? meta.createdAt : localISOString(new Date(0)),
            updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : localISOString(new Date(0)),
            messageCount: typeof meta.messageCount === "number" ? meta.messageCount : 0,
        };
    } catch {
        return null;
    }
}
