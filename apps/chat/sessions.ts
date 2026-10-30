// sessions.ts — 多会话宿主（apps/chat 的实现，注入给 @diy-agent/chat-page 的 config.sessions）。
//
// 一个会话 = `$DIY_HOME/sessions/chat/<id>/`：
//   meta.json                 标题 / 模型 / 时间（列表用；不含任何 key）
//   index.json + log-*.jsonl  @diy-agent/session-store-jsonl 的桶（消息正文）
//
// 边界（##465）：
//   · 模型目录由 @diy-agent/model-catalog 投影（只有名字，无 key）
//   · key 只在建 provider 的那一刻从 readAccountValue 取，**不打印、不落盘**
//   · 真 provider 走 @diy-agent/llm-provider；provider 表没有的（custom）直接用 catalog 的 baseURL

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSession, type AgentSession, type ChatMessage, type LlmPort } from "@diy-agent/session";
import { openJsonlSessionStore, type JsonlSessionStore } from "@diy-agent/session-store-jsonl";
import { createOpenAiCompatible, resolveProviderConfig } from "@diy-agent/llm-provider";
import { loadCatalog, readAccountValue, type ModelCatalogEntry } from "@diy-agent/model-catalog";
import { wireOf, type ChatSessionHost, type ChatSnapshot, type ModelChoice, type SessionSummary } from "@diy-agent/chat-page";

/** `meta.json` 的形状（会话列表的全部信息；消息正文在桶里） */
interface SessionMeta {
    readonly id: string;
    readonly title: string;
    /** 模型限定名 `providerId/modelId` */
    readonly model: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly messageCount: number;
}

export interface ChatSessionsOptions {
    /** 数据根（`$DIY_HOME`） */
    readonly home: string;
    /** 打开桶存储（测试可注入临时 maxBucketBytes） */
    readonly openStore?: (dir: string) => Promise<JsonlSessionStore>;
    /** 建 LLM 端口（测试注入假实现；缺省 = 真 provider，key 从 readAccountValue 取） */
    readonly llmFor?: (modelKey: string) => LlmPort;
}

/** 把 `providerId/modelId` 切开（模型 id 自身可含 `/`，按第一个 `/` 切） */
export function splitModelKey(key: string): { providerId: string; modelId: string } {
    const at = key.indexOf("/");
    if (at <= 0 || at === key.length - 1) return { providerId: key, modelId: "" };
    return { providerId: key.slice(0, at), modelId: key.slice(at + 1) };
}

/** 建一个多会话宿主（懒打开：第一次调用才读目录 / 建目录） */
export function createChatSessions(options: ChatSessionsOptions): ChatSessionHost {
    const home = options.home;
    const root = join(home, "sessions", "chat");
    const openStore = options.openStore ?? ((dir: string) => openJsonlSessionStore({ dir }));

    let catalogCache: ModelCatalogEntry[] | null = null;
    let metas: SessionMeta[] | null = null;
    let activeId: string | null = null;
    let selectedModel: string | null = null;

    /** 打开中的会话（桶 + session 都缓存；切换不回退消息线） */
    const open = new Map<string, { store: JsonlSessionStore; session: AgentSession; meta: SessionMeta }>();

    const catalog = (): ModelCatalogEntry[] => {
        return (catalogCache ??= loadCatalog(home));
    };

    const choices = (): ModelChoice[] =>
        catalog().map((entry) => ({
            providerId: entry.providerId,
            modelId: entry.modelId,
            name: entry.name,
        }));

    const keyOf = (entry: ModelCatalogEntry | null): string => (entry === null ? "" : `${entry.providerId}/${entry.modelId}`);

    const loadMetas = async (): Promise<SessionMeta[]> => {
        if (metas !== null) return metas;
        await mkdir(root, { recursive: true });
        const out: SessionMeta[] = [];
        for (const item of await readdir(root, { withFileTypes: true })) {
            if (!item.isDirectory()) continue;
            const meta = await readMeta(join(root, item.name));
            if (meta !== null) out.push(meta);
        }
        out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        metas = out;
        return out;
    };

    const writeMeta = async (meta: SessionMeta): Promise<void> => {
        const dir = join(root, meta.id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 4)}\n`, "utf-8");
    };

    const remember = (meta: SessionMeta): void => {
        const list = metas ?? [];
        const index = list.findIndex((item) => item.id === meta.id);
        if (index >= 0) list[index] = meta;
        else list.unshift(meta);
        metas = list;
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

    const opened = async (id: string): Promise<{ store: JsonlSessionStore; session: AgentSession; meta: SessionMeta }> => {
        const hit = open.get(id);
        if (hit !== undefined) return hit;
        const dir = join(root, id);
        const meta = await readMeta(dir);
        if (meta === null) throw new Error(`没有会话 ${id}`);
        const store = await openStore(dir);
        const initialMessages: readonly ChatMessage[] = await store.readFrom(0);
        const { modelId } = splitModelKey(meta.model);
        const session = createSession({
            id,
            llm: llmFor(meta.model),
            store,
            initialMessages,
            ...(modelId === "" ? {} : { model: modelId }),
        });
        const value = { store, session, meta };
        open.set(id, value);
        return value;
    };

    const snapshot = async (): Promise<ChatSnapshot> => {
        const list = await loadMetas();
        if (selectedModel === null) selectedModel = keyOf(catalog()[0] ?? null) || null;
        // 重启后默认打开最近的会话（判据 4：列表在，点开就完整；这里连点都不用点）
        activeId ??= list[0]?.id ?? null;
        let messages: readonly { role: "user" | "assistant"; text: string }[] = [];
        const current = activeId === null ? null : await opened(activeId).catch(() => null);
        if (current !== null) messages = wireOf(current.session.messages);
        return {
            sessions: list.map(summaryOf),
            models: choices(),
            activeId,
            messages,
            selectedModel,
        };
    };

    return {
        snapshot,

        async create(input): Promise<ChatSnapshot> {
            const requested = input.model ?? selectedModel;
            const entry =
                catalog().find((item) => keyOf(item) === requested) ?? catalog()[0] ?? null;
            if (entry === null) {
                throw new Error("model.yaml 里没有可用模型 —— 检查 $DIY_HOME/model.yaml 与 providers.custom.yaml");
            }
            const now = new Date().toISOString();
            const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const meta: SessionMeta = {
                id,
                title: "新会话",
                model: keyOf(entry),
                createdAt: now,
                updatedAt: now,
                messageCount: 0,
            };
            await writeMeta(meta);
            remember(meta);
            selectedModel = meta.model;
            activeId = id;
            return snapshot();
        },

        async select(id): Promise<ChatSnapshot> {
            await opened(id);
            activeId = id;
            return snapshot();
        },

        async remove(id): Promise<ChatSnapshot> {
            await rm(join(root, id), { recursive: true, force: true });
            open.delete(id);
            metas = (metas ?? []).filter((item) => item.id !== id);
            if (activeId === id) activeId = null;
            return snapshot();
        },

        async send(id, text, onDelta): Promise<ChatSnapshot> {
            const { session, meta } = await opened(id);
            activeId = id;
            const before = session.messages.length;
            for await (const delta of session.send(text)) {
                if (delta.type === "text") onDelta(wireOf(session.messages));
            }
            const messages = wireOf(session.messages);
            onDelta(messages);
            const grown = session.messages.length - before;
            const next: SessionMeta = {
                ...meta,
                title: meta.title === "新会话" && messages.length > 0 ? titleFrom(text) : meta.title,
                updatedAt: new Date().toISOString(),
                messageCount: meta.messageCount + Math.max(grown, 0),
            };
            await writeMeta(next);
            remember(next);
            open.set(id, { store: open.get(id)!.store, session, meta: next });
            return { ...(await snapshot()), messages, activeId: id };
        },
    };
}

function summaryOf(meta: SessionMeta): SessionSummary {
    return {
        id: meta.id,
        title: meta.title,
        model: meta.model,
        updatedAt: meta.updatedAt,
        messageCount: meta.messageCount,
    };
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
        if (typeof meta.id !== "string" || typeof meta.title !== "string" || typeof meta.model !== "string") return null;
        return {
            id: meta.id,
            title: meta.title,
            model: meta.model,
            createdAt: typeof meta.createdAt === "string" ? meta.createdAt : new Date(0).toISOString(),
            updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : new Date(0).toISOString(),
            messageCount: typeof meta.messageCount === "number" ? meta.messageCount : 0,
        };
    } catch {
        return null;
    }
}
