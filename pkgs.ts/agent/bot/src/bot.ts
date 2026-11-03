// bot.ts — bot 句柄与「存在即返回」的 ensure
//
// 本文件不碰文件系统：会话归属 / 身份读写全走注入的 BotStore。

import { localISOString } from "@diy-agent/time";
import { BotError } from "./errors.js";
import { createMemoryBotStore } from "./store-memory.js";
import type { Bot, BotConfig, BotDraft, BotSessionRef, BotStore, CreateBotOptions } from "./types.js";

/** 建一个 bot 句柄（config 已在手；要按 id 打开用 `openBot`）
 *
 * store 不传 = 内存实现（##480）：句柄照常工作，只是重启即消失。
 * 要落盘由装配器传实例（`createFileBotStore(...)`），本包不分派策略。
 */
export function createBot(options: CreateBotOptions): Bot {
    // `config` 会因为 primary() 写回而变（primarySessionId）：句柄对外始终是**当前**那一份
    let config = options.config;
    const store = options.store ?? createMemoryBotStore();

    const openSession = async (): Promise<string> => {
        const id = options.createSession === undefined ? newSessionId() : await options.createSession(config);
        if (typeof id !== "string" || id === "") {
            throw new BotError("bot/invalid-id", "createSession 返回了空 id");
        }
        await store.assign(id, config.id);
        return id;
    };

    /** 把长期会话 id 写回 bot.json（只有变了才写：幂等路径零 IO 写入） */
    const rememberPrimary = async (id: string): Promise<void> => {
        if (config.primarySessionId === id) return;
        const next: BotConfig = { ...config, primarySessionId: id };
        await store.save(next);
        config = next;
    };

    const refOf = async (id: string): Promise<BotSessionRef> => {
        const hit = (await store.sessionsOf(config.id)).find((item) => item.id === id);
        return hit ?? { id, botId: config.id };
    };

    return {
        get config() {
            return config;
        },

        sessions() {
            return store.sessionsOf(config.id);
        },

        async primary(): Promise<BotSessionRef> {
            const id = config.primarySessionId;
            // 幂等：写回过的那个还在（归属仍是本 bot）就直接用
            if (id !== undefined && id !== "" && (await store.ownerOf(id)) === config.id) {
                return refOf(id);
            }
            const created = await openSession();
            await rememberPrimary(created);
            return refOf(created);
        },

        async newSession(): Promise<string> {
            return openSession();
        },
    };
}

/** 按 id 打开 bot；不存在则 `bot/not-found` */
export async function openBot(
    store: BotStore,
    id: string,
    createSession?: CreateBotOptions["createSession"],
): Promise<Bot> {
    const config = await store.load(id);
    if (config === null) throw new BotError("bot/not-found", `没有 bot ${id}`);
    return createBot({ store, config, ...(createSession === undefined ? {} : { createSession }) });
}

/**
 * 存在就返回，不存在就按草案建一个（`createdAt` / `updatedAt` 取 clock，缺省现在）。
 * 第一刀「单 bot」模式靠它拿到「大王助手」。
 */
export async function ensureBot(
    store: BotStore,
    draft: BotDraft,
    clock: () => Date = () => new Date(),
): Promise<BotConfig> {
    const existing = await store.load(draft.id);
    if (existing !== null) return existing;
    const config = fromDraft(draft, localISOString(clock()));
    await store.save(config);
    return config;
}

/** 有没有任何一个 bot（首启判断：空 ⇒ 必须先选模型建 bot，##497） */
export async function hasAnyBot(store: BotStore): Promise<boolean> {
    return (await store.list()).length > 0;
}

/**
 * 建**第一个** bot（##497 首启引导）：已经有 bot 就抛 `bot/exists`。
 *
 * 与 `ensureBot` 的差别：后者是「存在即返回」的幂等建，前者是**一次性**的 ——
 * 首启引导只该走一次，重入就是状态搞错了（不要静默覆盖用户改过的身份）。
 */
export async function createFirstBot(
    store: BotStore,
    draft: BotDraft,
    clock: () => Date = () => new Date(),
): Promise<BotConfig> {
    if (await hasAnyBot(store)) {
        throw new BotError("bot/exists", "已经有 bot —— 首启引导不该再走一次");
    }
    const config = fromDraft(draft, localISOString(clock()));
    await store.save(config);
    return config;
}

/**
 * 给存量 bot 补选模型（##497：旧数据 `bot.json` 里没有 model）。
 *
 * 只改 `model` + `updatedAt`：名字 / 指令 / 创建时间一字不动，也不新建 bot。
 * 补选后 `needsModel` 不再出现在写回的文件里（store 本来就不落它）。
 */
export async function setBotModel(
    store: BotStore,
    id: string,
    model: string,
    clock: () => Date = () => new Date(),
): Promise<BotConfig> {
    const current = await store.load(id);
    if (current === null) throw new BotError("bot/not-found", `没有 bot ${id}`);
    if (typeof model !== "string" || model.trim() === "") {
        throw new BotError("bot/invalid-config", "model 不能为空（##497：bot 必须有默认模型）");
    }
    const next: BotConfig = {
        id: current.id,
        name: current.name,
        instructions: current.instructions,
        model,
        // ##498：长期会话不因补选模型而丢（旧数据也可能已经有 primarySessionId）
        ...(current.primarySessionId === undefined ? {} : { primarySessionId: current.primarySessionId }),
        ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
        ...(current.maxOutputTokens === undefined ? {} : { maxOutputTokens: current.maxOutputTokens }),
        createdAt: current.createdAt,
        updatedAt: localISOString(clock()),
    };
    await store.save(next);
    return next;
}

/** 草案 → 完整配置（id / 时间由调用方补） */
function fromDraft(draft: BotDraft, now: string): BotConfig {
    if (typeof draft.model !== "string" || draft.model.trim() === "") {
        throw new BotError("bot/invalid-config", "model 不能为空（##497：bot 必须有默认模型）");
    }
    return {
        id: draft.id,
        name: draft.name,
        instructions: draft.instructions,
        model: draft.model,
        ...(draft.reasoningEffort === undefined ? {} : { reasoningEffort: draft.reasoningEffort }),
        ...(draft.maxOutputTokens === undefined ? {} : { maxOutputTokens: draft.maxOutputTokens }),
        createdAt: now,
        updatedAt: now,
    };
}

/** 新会话 id（与 apps/chat 的既有形态一致：`s-<时间36>-<随机6>`） */
export function newSessionId(): string {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
