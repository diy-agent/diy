// tests/bot.test.ts — ##469 判据：身份落盘 / 会话归属（方案 B）/ 删 bot 不丢数据 / 源码零 room
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localISOString } from "@diy-agent/time";
import { describe, expect, it } from "vitest";
import {
    BotError,
    createBot,
    createFileBotStore,
    createMemoryBotStore,
    ensureBot,
    newSessionId,
    openBot,
} from "../src/index.js";

function makeHome(): string {
    return mkdtempSync(join(tmpdir(), "diy-bot-"));
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf-8"));
}

/** 假宿主建会话：只建目录 + meta.json（桶 / 消息不归本包） */
function fakeCreateSession(home: string, sessionsSub = "sessions") {
    return async (): Promise<string> => {
        const id = newSessionId();
        const dir = join(home, sessionsSub, id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "meta.json"), `${JSON.stringify({ id, updatedAt: new Date().toISOString() })}\n`);
        return id;
    };
}

describe("BotStore 文件实现", () => {
    it("判据 1：ensureBot 落 ~/.diy/bots/bot-1/bot.json，字段完整", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const at = new Date("2026-10-30T08:00:00.000Z");
        const config = await ensureBot(
            store,
            { id: "bot-1", name: "大王助手", instructions: "你是谁", model: "deepseek/deepseek-chat" },
            () => at,
        );
        const raw = readJson(join(home, "bots", "bot-1", "bot.json")) as Record<string, unknown>;
        expect(raw).toEqual({
            id: "bot-1",
            name: "大王助手",
            instructions: "你是谁",
            model: "deepseek/deepseek-chat",
            // 时间戳口径 = 本地时区 + 偏移（##483）
            createdAt: localISOString(at),
            updatedAt: localISOString(at),
        });
        expect(config).toEqual(raw);
        // 再 ensure 不覆盖（存在即返回）
        expect(await ensureBot(store, { id: "bot-1", name: "改名了", instructions: "x" })).toEqual(config);
    });

    it("load / list / save / remove 走 bots 目录", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const a = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "a" });
        const b = await ensureBot(store, { id: "bot-2", name: "乙", instructions: "b" });
        expect((await store.list()).map((item) => item.id)).toEqual(["bot-1", "bot-2"]);
        expect(await store.load("bot-1")).toEqual(a);
        expect(await store.load("nope")).toBeNull();

        await store.save({ ...b, name: "乙二", updatedAt: "2026-10-31T00:00:00.000Z" });
        expect((await store.load("bot-2"))?.name).toBe("乙二");

        await store.remove("bot-1");
        expect(await store.load("bot-1")).toBeNull();
        expect((await store.list()).map((item) => item.id)).toEqual(["bot-2"]);
    });

    it("非法 id 报 bot/invalid-id（不许穿越目录）", async () => {
        const store = createFileBotStore({ home: makeHome() });
        for (const id of ["..", "../x", "a/b", ""]) {
            await expect(store.load(id)).rejects.toMatchObject({ code: "bot/invalid-id" });
        }
    });
});

describe("会话归属（方案 B：session 目录里的 bot.json）", () => {
    it("判据 2：newSession 后会话目录里有 bot.json 标 botId", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const config = await ensureBot(store, { id: "bot-1", name: "大王助手", instructions: "p" });
        const bot = createBot({ store, config, createSession: fakeCreateSession(home) });

        const id = await bot.newSession();
        expect(readJson(join(home, "sessions", id, "bot.json"))).toEqual({ botId: "bot-1" });
        expect(readdirSync(join(home, "sessions", id)).sort()).toEqual(["bot.json", "meta.json"]);
    });

    it("判据 3：bot.sessions() 只列自己的会话", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const one = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "a" });
        const two = await ensureBot(store, { id: "bot-2", name: "乙", instructions: "b" });
        const bot1 = createBot({ store, config: one, createSession: fakeCreateSession(home) });
        const bot2 = createBot({ store, config: two, createSession: fakeCreateSession(home) });

        const first = await bot1.newSession();
        const second = await bot1.newSession();
        const other = await bot2.newSession();

        const listed = (await bot1.sessions()).map((item) => item.id);
        expect(listed.sort()).toEqual([first, second].sort());
        expect(listed).not.toContain(other);
        expect((await bot2.sessions()).map((item) => item.id)).toEqual([other]);

        // 直接问 store 也一样
        expect((await store.sessionsOf("bot-1")).map((item) => item.id).sort()).toEqual([first, second].sort());
        expect(await store.ownerOf(other)).toBe("bot-2");
    });

    it("宿主指定 sessionsDir（apps/chat 用 sessions/chat）", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home, sessionsDir: join(home, "sessions", "chat") });
        const config = await ensureBot(store, { id: "bot-1", name: "大王助手", instructions: "p" });
        const bot = createBot({ store, config, createSession: fakeCreateSession(home, "sessions/chat") });

        const id = await bot.newSession();
        expect(readJson(join(home, "sessions", "chat", id, "bot.json"))).toEqual({ botId: "bot-1" });
        expect((await bot.sessions()).map((item) => item.id)).toEqual([id]);
    });

    it("删 bot 不丢会话数据：会话目录与归属文件都还在", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const config = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "a" });
        const bot = createBot({ store, config, createSession: fakeCreateSession(home) });
        const id = await bot.newSession();

        await store.remove("bot-1");
        expect(await store.load("bot-1")).toBeNull();
        expect(readdirSync(join(home, "sessions", id)).sort()).toEqual(["bot.json", "meta.json"]);
        expect(await store.ownerOf(id)).toBe("bot-1");
    });

    it("按 updatedAt 倒序（拿得到 meta.json 就用它）", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const config = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "a" });
        for (const [id, at] of [
            ["old", "2026-10-01T00:00:00.000Z"],
            ["new", "2026-11-01T00:00:00.000Z"],
        ] as const) {
            mkdirSync(join(home, "sessions", id), { recursive: true });
            writeFileSync(join(home, "sessions", id, "meta.json"), JSON.stringify({ id, updatedAt: at }));
            await store.assign(id, config.id);
        }
        expect((await store.sessionsOf("bot-1")).map((item) => item.id)).toEqual(["new", "old"]);
    });

    it("openBot：不存在报 bot/not-found，存在拿得到会话", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        await expect(openBot(store, "nope")).rejects.toBeInstanceOf(BotError);

        const config = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "a" });
        const id = await createBot({ store, config, createSession: fakeCreateSession(home) }).newSession();
        const reopened = await openBot(store, "bot-1");
        expect(reopened.config).toEqual(config);
        expect((await reopened.sessions()).map((item) => item.id)).toEqual([id]);
    });
});

describe("内存 BotStore（##480 缺省实现）", () => {
    it("createBot 不传 store 也能工作：身份在内存、归属记在内存（零落盘）", async () => {
        const config = await ensureBot(createMemoryBotStore(), { id: "bot-1", name: "甲", instructions: "a" });
        const bot = createBot({ config });

        expect(await bot.sessions()).toEqual([]);
        const id = await bot.newSession();
        expect((await bot.sessions()).map((item) => item.id)).toEqual([id]);
    });

    it("BotStore 四个方法：save / load / list / ownerOf / sessionsOf / remove（删 bot 不动归属）", async () => {
        const store = createMemoryBotStore();
        const at = "2026-10-31T00:00:00.000Z";
        await store.save({ id: "bot-2", name: "乙", instructions: "b", createdAt: at, updatedAt: at });
        await store.save({ id: "bot-1", name: "甲", instructions: "a", createdAt: at, updatedAt: at });

        expect((await store.list()).map((item) => item.id)).toEqual(["bot-1", "bot-2"]);
        expect((await store.load("bot-1"))?.name).toBe("甲");
        expect(await store.load("nope")).toBeNull();

        await store.assign("s-a", "bot-1");
        await store.assign("s-b", "bot-2");
        expect(await store.ownerOf("s-a")).toBe("bot-1");
        expect((await store.sessionsOf("bot-1")).map((item) => item.id)).toEqual(["s-a"]);

        await store.remove("bot-1");
        expect(await store.load("bot-1")).toBeNull();
        expect(await store.ownerOf("s-a")).toBe("bot-1"); // 删 bot 不丢会话归属（与文件实现同一判据）
    });
});

describe("边界（判据 4）", () => {
    it("源码里 grep room = 0（也不依赖 session / electron / task）", () => {
        const dir = join(import.meta.dirname, "..", "src");
        const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
        expect(files.length).toBeGreaterThan(0);
        for (const name of files) {
            const text = readFileSync(join(dir, name), "utf-8");
            expect(text.toLowerCase()).not.toContain("room");
            expect(text).not.toContain("@diy-agent/session");
            expect(text).not.toContain("electron");
            expect(text).not.toContain("@diy-agent/task");
        }
    });
});
