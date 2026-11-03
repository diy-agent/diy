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
        expect(await ensureBot(store, { id: "bot-1", name: "改名了", instructions: "x", model: "x/y" })).toEqual(config);
    });

    it("load / list / save / remove 走 bots 目录", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const a = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "a", model: "test/echo" });
        const b = await ensureBot(store, { id: "bot-2", name: "乙", instructions: "b", model: "test/echo" });
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
        const config = await ensureBot(store, { id: "bot-1", name: "大王助手", instructions: "p", model: "test/echo" });
        const bot = createBot({ store, config, createSession: fakeCreateSession(home) });

        const id = await bot.newSession();
        expect(readJson(join(home, "sessions", id, "bot.json"))).toEqual({ botId: "bot-1" });
        expect(readdirSync(join(home, "sessions", id)).sort()).toEqual(["bot.json", "meta.json"]);
    });

    it("判据 3：bot.sessions() 只列自己的会话", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const one = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "a", model: "test/echo" });
        const two = await ensureBot(store, { id: "bot-2", name: "乙", instructions: "b", model: "test/echo" });
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
        const config = await ensureBot(store, { id: "bot-1", name: "大王助手", instructions: "p", model: "test/echo" });
        const bot = createBot({ store, config, createSession: fakeCreateSession(home, "sessions/chat") });

        const id = await bot.newSession();
        expect(readJson(join(home, "sessions", "chat", id, "bot.json"))).toEqual({ botId: "bot-1" });
        expect((await bot.sessions()).map((item) => item.id)).toEqual([id]);
    });

    it("删 bot 不丢会话数据：会话目录与归属文件都还在", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const config = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "a", model: "test/echo" });
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
        const config = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "a", model: "test/echo" });
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

        const config = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "a", model: "test/echo" });
        const id = await createBot({ store, config, createSession: fakeCreateSession(home) }).newSession();
        const reopened = await openBot(store, "bot-1");
        expect(reopened.config).toEqual(config);
        expect((await reopened.sessions()).map((item) => item.id)).toEqual([id]);
    });
});

describe("内存 BotStore（##480 缺省实现）", () => {
    it("createBot 不传 store 也能工作：身份在内存、归属记在内存（零落盘）", async () => {
        const config = await ensureBot(createMemoryBotStore(), { id: "bot-1", name: "甲", instructions: "a", model: "test/echo" });
        const bot = createBot({ config });

        expect(await bot.sessions()).toEqual([]);
        const id = await bot.newSession();
        expect((await bot.sessions()).map((item) => item.id)).toEqual([id]);
    });

    // 「BotStore 的 save / load / list / ownerOf / sessionsOf / remove」已移进
    // tests/store-contract.test.ts（##506：与文件实现跑同一批），这里不再重复。
});

describe("边界（判据 4）", () => {
    it("源码里 grep room = 0（身份 / 存储不依赖 session / electron / task）", () => {
        const dir = join(import.meta.dirname, "..", "src");
        const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
        expect(files.length).toBeGreaterThan(0);
        // ##505：对话编排（chat.ts）与线上形状（protocol.ts）**本来就要**用 session 的消息 / 端口；
        // ##514：工具执行（tools.ts）也要——它产出的就是 session 的 `ToolResultInput`
        // （工具结果必须按 tool_call_id 交回会话，绕开会话就得自己重写一套配对逻辑）。
        // 身份与存储仍在「不认识会话内核」那一侧。
        // ##517：上下文压缩（compaction.ts）也是同一侧 —— 它算的就是会话消息线与摘要调用。
        const conversational = new Set(["chat.ts", "protocol.ts", "tools.ts", "compaction.ts"]);
        for (const name of files) {
            const text = readFileSync(join(dir, name), "utf-8");
            expect(text.toLowerCase()).not.toContain("room");
            expect(text).not.toContain("electron");
            expect(text).not.toContain("@diy-agent/task");
            if (conversational.has(name)) continue;
            expect(text).not.toContain("@diy-agent/session");
        }
    });
});

describe("长期会话 primary()（##498）", () => {
    it("第一次建、之后幂等；id 写回 bot.json（重启后还是同一个）", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const config = await ensureBot(store, { id: "bot-1", name: "大王助手", instructions: "p", model: "test/echo" });
        const bot = createBot({ store, config, createSession: fakeCreateSession(home) });

        const first = await bot.primary();
        const second = await bot.primary();
        expect(second.id).toBe(first.id);
        expect(first.botId).toBe("bot-1");
        // 只建了一个会话目录
        expect(readdirSync(join(home, "sessions")).filter((name) => name.startsWith("s-"))).toEqual([first.id]);
        // 写回 bot.json（重开一个句柄还是它）
        expect((readJson(join(home, "bots", "bot-1", "bot.json")) as { primarySessionId?: string }).primarySessionId).toBe(
            first.id,
        );
        const reopened = await openBot(store, "bot-1", fakeCreateSession(home));
        expect((await reopened.primary()).id).toBe(first.id);
    });

    it("长期会话被外部删掉 ⇒ 下一次 primary() 重建一个（不返回幽灵 id）", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const config = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "p", model: "test/echo" });
        const bot = createBot({ store, config, createSession: fakeCreateSession(home) });
        const first = await bot.primary();

        // 只删会话目录（模拟用户 / 别的工具清掉了）
        const { rmSync } = await import("node:fs");
        rmSync(join(home, "sessions", first.id), { recursive: true, force: true });

        const again = await bot.primary();
        expect(again.id).not.toBe(first.id);
        expect((readJson(join(home, "bots", "bot-1", "bot.json")) as { primarySessionId?: string }).primarySessionId).toBe(
            again.id,
        );
    });

    it("primary() 不碰别的 bot 的会话；newSession() 仍可建（装配层的原语）", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const one = await ensureBot(store, { id: "bot-1", name: "甲", instructions: "a", model: "test/echo" });
        const two = await ensureBot(store, { id: "bot-2", name: "乙", instructions: "b", model: "test/echo" });
        const bot1 = createBot({ store, config: one, createSession: fakeCreateSession(home) });
        const bot2 = createBot({ store, config: two, createSession: fakeCreateSession(home) });

        const primary = await bot1.primary();
        const extra = await bot1.newSession();
        const other = await bot2.primary();
        expect(new Set([primary.id, extra, other.id]).size).toBe(3);
        expect((await bot1.sessions()).map((item) => item.id).sort()).toEqual([primary.id, extra].sort());
        expect((await bot2.sessions()).map((item) => item.id)).toEqual([other.id]);
    });
});
