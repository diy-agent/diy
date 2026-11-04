// tests/first-bot.test.ts — ##497 判据 3~7：首启建 bot（模型必填）/ 存量补选 / 只存 id
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileBotStore } from "../src/index.js";
// 包内部实现（A1 后不再从包入口导出）
import { createFirstBot, hasAnyBot, setBotModel } from "../src/bot.js";

function makeHome(): string {
    return mkdtempSync(join(tmpdir(), "diy-bot-first-"));
}

function readJson(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("首启建 bot（createFirstBot）", () => {
    it("bots 为空时 hasAnyBot = false，建完 = true，且 model 落盘", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        expect(await hasAnyBot(store)).toBe(false);

        const config = await createFirstBot(store, {
            id: "bot-1",
            name: "大王助手",
            instructions: "你是谁",
            model: "test/echo-1",
        });
        expect(config.model).toBe("test/echo-1");
        expect(await hasAnyBot(store)).toBe(true);
        expect(readJson(join(home, "bots", "bot-1", "bot.json"))["model"]).toBe("test/echo-1");
    });

    it("已有 bot 再建就抛 bot/exists（首启引导只该走一次）", async () => {
        const store = createFileBotStore({ home: makeHome() });
        await createFirstBot(store, { id: "bot-1", name: "甲", instructions: "", model: "test/echo-1" });
        await expect(
            createFirstBot(store, { id: "bot-2", name: "乙", instructions: "", model: "test/echo-1" }),
        ).rejects.toMatchObject({ code: "bot/exists" });
    });

    it("model 为空就抛（不许建「没有默认模型」的 bot）", async () => {
        const store = createFileBotStore({ home: makeHome() });
        await expect(createFirstBot(store, { id: "bot-1", name: "甲", instructions: "", model: "" })).rejects.toMatchObject(
            { code: "bot/invalid-config" },
        );
        expect(await hasAnyBot(store)).toBe(false);
    });
});

describe("存量数据（bot.json 没有 model）", () => {
    const OLD = {
        id: "bot-1",
        name: "大王助手",
        instructions: "旧身份",
        createdAt: "2026-10-30T08:00:00.000+0800",
        updatedAt: "2026-10-30T08:00:00.000+0800",
    };

    it("读出来带 needsModel（不静默挑模型），model 是空串", async () => {
        const home = makeHome();
        mkdirSync(join(home, "bots", "bot-1"), { recursive: true });
        writeFileSync(join(home, "bots", "bot-1", "bot.json"), `${JSON.stringify(OLD)}\n`, "utf-8");

        const store = createFileBotStore({ home });
        const config = await store.load("bot-1");
        expect(config?.model).toBe("");
        expect(config?.needsModel).toBe(true);
        // list 同样带标记（UI 的启动闸门就用它）
        expect((await store.list())[0]?.needsModel).toBe(true);
    });

    it("setBotModel 只补 model：名字 / 指令 / createdAt 不动，标记消失且不落盘", async () => {
        const home = makeHome();
        mkdirSync(join(home, "bots", "bot-1"), { recursive: true });
        writeFileSync(join(home, "bots", "bot-1", "bot.json"), `${JSON.stringify(OLD)}\n`, "utf-8");

        const store = createFileBotStore({ home });
        const next = await setBotModel(store, "bot-1", "test/echo-1");
        expect(next).toMatchObject({ id: "bot-1", name: "大王助手", instructions: "旧身份", model: "test/echo-1" });
        expect(next.createdAt).toBe(OLD.createdAt);
        expect(next.needsModel).toBeUndefined();

        const raw = readJson(join(home, "bots", "bot-1", "bot.json"));
        expect(raw["model"]).toBe("test/echo-1");
        expect("needsModel" in raw).toBe(false);
        // 再读回来：闸门已开
        expect((await store.load("bot-1"))?.needsModel).toBeUndefined();
    });

    it("setBotModel 空模型 / 不存在的 bot 都抛", async () => {
        const store = createFileBotStore({ home: makeHome() });
        await expect(setBotModel(store, "bot-1", "test/echo-1")).rejects.toMatchObject({ code: "bot/not-found" });
        await createFirstBot(store, { id: "bot-1", name: "甲", instructions: "", model: "test/echo-1" });
        await expect(setBotModel(store, "bot-1", "  ")).rejects.toMatchObject({ code: "bot/invalid-config" });
    });
});

describe("判据 7：只存 id，不存显示字符串", () => {
    it("bot.json 里不出现 ccc@c-mac 这类显示地址", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        await createFirstBot(store, { id: "bot-1", name: "大王助手", instructions: "", model: "test/echo-1" });
        const text = readFileSync(join(home, "bots", "bot-1", "bot.json"), "utf-8");
        expect(text).not.toContain("@");
        expect(text).not.toContain("diy://");
    });
});
