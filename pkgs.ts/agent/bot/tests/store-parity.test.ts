// tests/store-parity.test.ts — 同一份用例跑「文件 store」与「内存 store」（##505 bug 回归）
//
// 用户 2026-11-02：「用参数测试切换测试 bot 流程，保证文件存储和内存都保证行为的一致性」。
// 两个 store 只在「数据活在哪」上不同；**宿主的行为（列表 / 选中 / 发消息）必须一模一样**。

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openMemorySessionStore, type LlmPort } from "@diy-agent/session";
import { createBotChat, createMemoryBotStore, type BotChatHost } from "../src/index.js";

interface Harness {
    readonly home: string;
    readonly chat: BotChatHost;
    /** 再开一个同一数据根的宿主（内存模式 = 重启，数据清空） */
    reopen(): BotChatHost;
}

/** 数据根 + 模型目录（key 是假值；llmFor 注入假模型，不会真发请求） */
function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "bot-parity-"));
    writeFileSync(
        join(home, "model.yaml"),
        `customProviders:
  test:
    accounts:
      - type: apiKey
        name: main
        data:
          value: fake-key
`,
        "utf-8",
    );
    writeFileSync(
        join(home, "providers.custom.yaml"),
        `test:
  id: test
  npm: "@ai-sdk/openai-compatible"
  api: http://127.0.0.1:1/v1
  models:
    echo-1: { name: Echo 1 }
    echo-2: { name: Echo 2 }
`,
        "utf-8",
    );
    return home;
}

const fakeLlm: LlmPort = {
    async *chat(messages) {
        const last = [...messages].reverse().find((message) => message.role === "user");
        yield { type: "text", text: `收到：${last?.text ?? ""}` };
        yield { type: "usage", inputTokens: 10, outputTokens: 2 };
        yield { type: "done", stopReason: "stop" };
    },
};

const CASES: readonly (readonly [string, () => Harness])[] = [
    [
        "file",
        () => {
            const home = makeHome();
            // 文件版场景：「重启后记得住」要求会话/ meta 也落盘 —— 缺省内存做不到
            const make = (): BotChatHost => createBotChat({ home, llmFor: () => fakeLlm, persist: true });
            return { home, chat: make(), reopen: make };
        },
    ],
    [
        "memory",
        () => {
            const home = makeHome();
            const make = (): BotChatHost =>
                createBotChat({
                    home,
                    llmFor: () => fakeLlm,
                    botStore: createMemoryBotStore(),
                    openSessionStore: () => openMemorySessionStore(),
                    persistMeta: false,
                });
            return { home, chat: make(), reopen: make };
        },
    ],
];

describe.each(CASES)("%s store", (_kind, setup) => {
    it("createFirstBot 之后列表里就有它", async () => {
        const { chat } = setup();
        const snap = await chat.createFirstBot({ name: "大王助手", model: "test/echo-1" });
        expect(snap.bots.map((bot) => bot.name)).toEqual(["大王助手"]);
        expect(snap.bot?.name).toBe("大王助手");
        // 再取一次快照（UI 的 refresh 就是这么干的）
        expect((await chat.snapshot()).bots.map((bot) => bot.name)).toEqual(["大王助手"]);
    });

    it("##505 bug：创建 bot 后列表里有它，且被选中（不是回到了旧列表）", async () => {
        const { chat } = setup();
        await chat.createFirstBot({ name: "大王助手", model: "test/echo-1" });
        const created = await chat.createBot({ name: "史蒂夫", model: "test/echo-2" });
        expect(created.bots.map((bot) => bot.name)).toEqual(["大王助手", "史蒂夫"]);
        expect(created.bot?.name).toBe("史蒂夫");
        // UI 创建后 **重新取快照**：必须仍是 2 个、仍选中新建的那个
        const refreshed = await chat.snapshot();
        expect(refreshed.bots.map((bot) => bot.name)).toEqual(["大王助手", "史蒂夫"]);
        expect(refreshed.bot?.name).toBe("史蒂夫");
    });

    it("连续创建 3 个 bot：列表 3 个、id 不撞", async () => {
        const { chat } = setup();
        await chat.createFirstBot({ name: "一号", model: "test/echo-1" });
        await chat.createBot({ name: "二号", model: "test/echo-1" });
        await chat.createBot({ name: "三号", model: "test/echo-2" });
        const snap = await chat.snapshot();
        expect(snap.bots.map((bot) => bot.name)).toEqual(["一号", "二号", "三号"]);
        expect(new Set(snap.bots.map((bot) => bot.id)).size).toBe(3);
    });

    it("切 bot 后 snapshot 对得上（选中项 / 消息线都是那个 bot 的）", async () => {
        const { chat } = setup();
        await chat.createFirstBot({ name: "一号", model: "test/echo-1" });
        const [first] = (await chat.snapshot()).bots;
        await chat.createBot({ name: "二号", model: "test/echo-1" });
        await chat.send("这是二号的", () => {});

        const back = await chat.selectBot(first!.id);
        expect(back.bot?.id).toBe(first!.id);
        expect(back.messages).toEqual([]);
        // 来回切两次都不丢
        const other = back.bots.find((bot) => bot.id !== first!.id)!;
        const there = await chat.selectBot(other.id);
        expect(there.bot?.id).toBe(other.id);
        expect(there.messages).toHaveLength(2);
        expect((await chat.selectBot(first!.id)).bot?.id).toBe(first!.id);
    });

    it("发消息后 bot 列表不变（只动会话，不动身份）", async () => {
        const { chat } = setup();
        await chat.createFirstBot({ name: "一号", model: "test/echo-1" });
        await chat.createBot({ name: "二号", model: "test/echo-1" });
        const before = (await chat.snapshot()).bots;
        const after = await chat.send("列表别动", () => {});
        expect(after.bots).toEqual(before);
        expect(after.bot?.id).toBe(before[1]!.id);
    });

    it("改配置 / 删 bot 后列表同步", async () => {
        const { chat } = setup();
        await chat.createFirstBot({ name: "一号", model: "test/echo-1" });
        const [first] = (await chat.snapshot()).bots;
        await chat.updateBot({ id: first!.id, name: "改名了" });
        const renamed = await chat.snapshot();
        expect(renamed.bots.map((bot) => bot.name)).toEqual(["改名了"]);
        expect(renamed.bot?.name).toBe("改名了");

        const gone = await chat.removeBot(first!.id);
        expect(gone.bots).toEqual([]);
        expect(gone.bot).toBeNull();
    });

    it("重启语义：文件 store 记得住，内存 store 全丢（两种都是有意的）", async () => {
        const { chat, reopen } = setup();
        await chat.createFirstBot({ name: "一号", model: "test/echo-1" });
        const after = await reopen().snapshot();
        if (_kind === "file") expect(after.bots.map((bot) => bot.name)).toEqual(["一号"]);
        else expect(after.bots).toEqual([]);
    });
});
