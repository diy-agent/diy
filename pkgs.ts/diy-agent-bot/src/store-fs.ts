// store-fs.ts — BotStore 的文件实现（唯一碰 IO 的文件）
//
//   <home>/bots/<id>/bot.json           bot 身份（BotConfig）
//   <sessionsDir>/<sessionId>/bot.json  会话归属（{ botId }，方案 B）
//
// 会话归属记在**会话自己的目录**里：删 bot 只删 `bots/<id>/`，会话数据原样保留。
// `sessionsDir` 由宿主指定（apps/chat 是 `<home>/sessions/chat`；缺省 `<home>/sessions`）。

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BotError } from "./errors.js";
import type { BotConfig, BotId, BotSessionRef, BotStore } from "./types.js";

export interface FileBotStoreOptions {
    /** 数据根（`$DIY_HOME`） */
    readonly home: string;
    /** bot 目录；缺省 `<home>/bots` */
    readonly botsDir?: string;
    /** 会话目录（归属文件落在它的子目录里）；缺省 `<home>/sessions` */
    readonly sessionsDir?: string;
}

/** 会话归属文件 `{ botId }` */
interface OwnerRecord {
    readonly botId: BotId;
}

const ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

function checkId(kind: "bot" | "session", id: string): void {
    if (!ID_PATTERN.test(id) || id === "." || id === "..") {
        throw new BotError("bot/invalid-id", `${kind} id 非法：${JSON.stringify(id)}`);
    }
}

function compareUpdated(a: BotSessionRef, b: BotSessionRef): number {
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

/** 建一个文件型 BotStore（懒 IO：构造不碰磁盘） */
export function createFileBotStore(options: FileBotStoreOptions): BotStore {
    const home = options.home;
    const botsDir = options.botsDir ?? join(home, "bots");
    const sessionsDir = options.sessionsDir ?? join(home, "sessions");

    const botPath = (id: BotId): string => join(botsDir, id, "bot.json");
    const ownerPath = (sessionId: string): string => join(sessionsDir, sessionId, "bot.json");

    const readBot = async (id: BotId): Promise<BotConfig | null> => {
        checkId("bot", id);
        let raw: string;
        try {
            raw = await readFile(botPath(id), "utf-8");
        } catch {
            return null;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;
        }
        return parseConfig(parsed);
    };

    const readOwner = async (sessionId: string): Promise<BotId | null> => {
        checkId("session", sessionId);
        let raw: string;
        try {
            raw = await readFile(ownerPath(sessionId), "utf-8");
        } catch {
            return null;
        }
        try {
            const parsed = JSON.parse(raw) as Partial<OwnerRecord> | null;
            return typeof parsed?.botId === "string" ? parsed.botId : null;
        } catch {
            return null;
        }
    };

    const sessionUpdatedAt = async (sessionId: string): Promise<string | undefined> => {
        try {
            const raw = await readFile(join(sessionsDir, sessionId, "meta.json"), "utf-8");
            const parsed = JSON.parse(raw) as { readonly updatedAt?: unknown };
            return typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;
        } catch {
            return undefined;
        }
    };

    return {
        load: readBot,

        async save(config): Promise<void> {
            checkId("bot", config.id);
            validateConfig(config);
            await mkdir(join(botsDir, config.id), { recursive: true });
            await writeFile(botPath(config.id), `${JSON.stringify(config, null, 4)}\n`, "utf-8");
        },

        async list(): Promise<readonly BotConfig[]> {
            let items: Dirent[];
            try {
                items = await readdir(botsDir, { withFileTypes: true });
            } catch {
                return [];
            }
            const out: BotConfig[] = [];
            for (const item of items) {
                if (!item.isDirectory()) continue;
                const config = await readBot(item.name);
                if (config !== null) out.push(config);
            }
            out.sort((a, b) => a.id.localeCompare(b.id));
            return out;
        },

        async remove(id): Promise<void> {
            checkId("bot", id);
            // 只删 bot 自己；会话目录不碰（删 bot 不该丢数据）
            await rm(join(botsDir, id), { recursive: true, force: true });
        },

        ownerOf: readOwner,

        async assign(sessionId, botId): Promise<void> {
            checkId("session", sessionId);
            checkId("bot", botId);
            await mkdir(join(sessionsDir, sessionId), { recursive: true });
            const record: OwnerRecord = { botId };
            await writeFile(ownerPath(sessionId), `${JSON.stringify(record, null, 4)}\n`, "utf-8");
        },

        async sessionsOf(botId): Promise<readonly BotSessionRef[]> {
            checkId("bot", botId);
            let items: Dirent[];
            try {
                items = await readdir(sessionsDir, { withFileTypes: true });
            } catch {
                return [];
            }
            const out: BotSessionRef[] = [];
            for (const item of items) {
                if (!item.isDirectory()) continue;
                const owner = await readOwner(item.name);
                if (owner !== botId) continue;
                const updatedAt = await sessionUpdatedAt(item.name);
                out.push({ id: item.name, botId, ...(updatedAt === undefined ? {} : { updatedAt }) });
            }
            out.sort(compareUpdated);
            return out;
        },
    };
}

function validateConfig(config: BotConfig): void {
    if (typeof config.name !== "string" || typeof config.persona !== "string") {
        throw new BotError("bot/invalid-config", "bot 配置缺 name / persona");
    }
    if (typeof config.createdAt !== "string" || typeof config.updatedAt !== "string") {
        throw new BotError("bot/invalid-config", "bot 配置缺 createdAt / updatedAt");
    }
}

function parseConfig(value: unknown): BotConfig | null {
    if (value === null || typeof value !== "object") return null;
    const config = value as Partial<Record<keyof BotConfig, unknown>>;
    if (
        typeof config.id !== "string" ||
        typeof config.name !== "string" ||
        typeof config.persona !== "string" ||
        typeof config.createdAt !== "string" ||
        typeof config.updatedAt !== "string"
    ) {
        return null;
    }
    return {
        id: config.id,
        name: config.name,
        persona: config.persona,
        ...(typeof config.model === "string" ? { model: config.model } : {}),
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
    };
}
