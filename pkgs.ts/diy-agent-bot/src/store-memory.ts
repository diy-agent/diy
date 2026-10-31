// store-memory.ts — 纯内存 BotStore：createBot 的**缺省**存储（##480）
//
// 同 session 的方向：bot 的身份 / 会话归属默认活在内存里；装配器要落盘就传
// `createFileBotStore({ home, sessionsDir })` 实例。**没有策略枚举** —— 装配器直接构造调用。
//
// 本文件不碰文件系统（不 import node:*）：零落盘是编译期就能看出来的事实。

import type { BotConfig, BotId, BotSessionRef, BotStore } from "./types.js";

/** 建一个纯内存 BotStore（进程退出即消失；多个 bot / 会话归属各存一张表） */
export function createMemoryBotStore(): BotStore {
    const bots = new Map<BotId, BotConfig>();
    /** sessionId → botId（方案 B 的归属表） */
    const owners = new Map<string, BotId>();

    return {
        load(id: BotId): Promise<BotConfig | null> {
            return Promise.resolve(bots.get(id) ?? null);
        },

        save(config: BotConfig): Promise<void> {
            bots.set(config.id, { ...config });
            return Promise.resolve();
        },

        list(): Promise<readonly BotConfig[]> {
            return Promise.resolve([...bots.values()].sort((a, b) => a.id.localeCompare(b.id)));
        },

        remove(id: BotId): Promise<void> {
            // 只删 bot 自己；归属不动（与文件实现同一判据：删 bot 不丢会话）
            bots.delete(id);
            return Promise.resolve();
        },

        ownerOf(sessionId: string): Promise<BotId | null> {
            return Promise.resolve(owners.get(sessionId) ?? null);
        },

        assign(sessionId: string, botId: BotId): Promise<void> {
            owners.set(sessionId, botId);
            return Promise.resolve();
        },

        sessionsOf(botId: BotId): Promise<readonly BotSessionRef[]> {
            const out: BotSessionRef[] = [];
            for (const [id, owner] of owners) {
                if (owner === botId) out.push({ id, botId });
            }
            return Promise.resolve(out);
        },
    };
}
