// bot.ts — bot 句柄与「存在即返回」的 ensure
//
// 本文件不碰文件系统：会话归属 / 身份读写全走注入的 BotStore。

import { BotError } from "./errors.js";
import { createMemoryBotStore } from "./store-memory.js";
import type { Bot, BotConfig, BotDraft, BotStore, CreateBotOptions } from "./types.js";

/** 建一个 bot 句柄（config 已在手；要按 id 打开用 `openBot`）
 *
 * store 不传 = 内存实现（##480）：句柄照常工作，只是重启即消失。
 * 要落盘由装配器传实例（`createFileBotStore(...)`），本包不分派策略。
 */
export function createBot(options: CreateBotOptions): Bot {
    const { config } = options;
    const store = options.store ?? createMemoryBotStore();

    return {
        config,

        sessions() {
            return store.sessionsOf(config.id);
        },

        async newSession(): Promise<string> {
            const id = options.createSession === undefined ? newSessionId() : await options.createSession(config);
            if (typeof id !== "string" || id === "") {
                throw new BotError("bot/invalid-id", "createSession 返回了空 id");
            }
            await store.assign(id, config.id);
            return id;
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
    const now = clock().toISOString();
    const config: BotConfig = {
        id: draft.id,
        name: draft.name,
        instructions: draft.instructions,
        ...(draft.model === undefined ? {} : { model: draft.model }),
        ...(draft.reasoningEffort === undefined ? {} : { reasoningEffort: draft.reasoningEffort }),
        ...(draft.maxOutputTokens === undefined ? {} : { maxOutputTokens: draft.maxOutputTokens }),
        createdAt: now,
        updatedAt: now,
    };
    await store.save(config);
    return config;
}

/** 新会话 id（与 apps/chat 的既有形态一致：`s-<时间36>-<随机6>`） */
export function newSessionId(): string {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
