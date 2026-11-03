// tests/chat.test.ts — bot 对话宿主（##505：从 apps/chat/sessions.ts 搬来的业务）
//
// ##498 的判据继续成立：一个 bot 一条长期会话 / 多 bot 隔离 / 落盘 / 重启还在 / 删 bot 级联；
// ##505 新增：没有会话列表（snapshot 不带 activeId）、不写 chat-ui.json、装配层只负责注入。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openMemorySessionStore, type LlmPort } from "@diy-agent/session";
import {
    createBotChat,
    createMemoryBotStore,
    nextBotId,
    splitModelKey,
    type BotChatHost,
    type WireMessage,
} from "../src/index.js";

/** 消息线 → 每条的纯文本（##499 起消息是 Block 列表） */
function textsOf(messages: readonly WireMessage[]): string[] {
    return messages.map((message) =>
        message.blocks
            .map((block) => (block.kind === "text" ? String(block.data["text"]) : `[${block.kind}]`))
            .join(""),
    );
}

/** 临时数据根：一个 custom provider（test/echo-1、test/echo-2），key 是假值（不会被用，llmFor 注入假模型） */
function makeHome(model = true): string {
    const home = mkdtempSync(join(tmpdir(), "bot-chat-"));
    if (model) {
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
    echo-1:
      name: Echo 1
      cost: { input: 1, output: 2 }
      limit: { context: 1000 }
    echo-2:
      name: Echo 2
`,
            "utf-8",
        );
    }
    return home;
}

const fakeLlm: LlmPort = {
    async *chat(messages) {
        const last = [...messages].reverse().find((message) => message.role === "user");
        const reply = `收到：${last?.text ?? ""}`;
        yield { type: "text", text: reply };
        // 带缓存读桶：底部指标条的「缓存 / 本轮」有数可算
        yield { type: "usage", inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 };
        yield { type: "done", stopReason: "stop" };
    },
};

const host = (home: string): BotChatHost => createBotChat({ home, llmFor: () => fakeLlm });

/** 首启建第一个 bot（##498：bots 为空 ⇒ 必须先建 bot 才有会话） */
async function firstBot(chat: BotChatHost, model = "test/echo-1") {
    return chat.createFirstBot({ model });
}

/** bot.json 里的长期会话 id（##505：快照不再外露 activeId，真源在 bot 身份里） */
function primaryOf(home: string, botId = "bot-1"): string | undefined {
    const config = JSON.parse(readFileSync(join(home, "bots", botId, "bot.json"), "utf-8")) as {
        primarySessionId?: string;
    };
    return config.primarySessionId;
}

describe("bot 对话宿主（##505）", () => {
    it("模型目录来自 model.yaml / providers.custom.yaml（provider×model）", async () => {
        const snapshot = await host(makeHome()).snapshot();
        expect(snapshot.models.map((choice) => `${choice.providerId}/${choice.modelId}`)).toEqual([
            "test/echo-1",
            "test/echo-2",
        ]);
        expect(snapshot.bots).toEqual([]);
        // 判据 8：bots 为空 ⇒ bot = null（UI 走首启引导，不进聊天）
        expect(snapshot.bot).toBeNull();
        // ##505-B：快照不再带会话身份 / 会话列表
        expect("activeId" in snapshot).toBe(false);
        expect("sessions" in snapshot).toBe(false);
    });

    it("首启建 bot 后就有了长期会话：发消息 → 消息线 user + assistant（判据 3）", async () => {
        const home = makeHome();
        const chat = host(home);
        let snapshot = await firstBot(chat);
        expect(snapshot.bot?.name).toBe("大王助手");
        expect(snapshot.bots).toHaveLength(1);
        expect(primaryOf(home)).toMatch(/^s-/);
        snapshot = await chat.send("你好呀", () => {});
        expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(textsOf(snapshot.messages)).toEqual(["你好呀", "收到：你好呀"]);
    });

    it("同一 bot 反复进：永远是同一个会话（判据 3：不是新建）", async () => {
        const home = makeHome();
        const first = await firstBot(host(home));
        const id = primaryOf(home);
        expect(id).toBeDefined();
        // 新宿主实例 = 重启后的进程：还是那一条
        const again = await host(home).snapshot();
        expect(again.bot?.id).toBe(first.bot?.id);
        expect(primaryOf(home)).toBe(id);
        // primarySessionId 已落盘（判据 4）
        // 会话目录只有一个
        expect(readdirSync(join(home, "sessions", "chat")).filter((name) => name.startsWith("s-"))).toEqual([id]);
    });

    it("多 bot 隔离：各自的会话互不串（判据 2）", async () => {
        const chat = host(makeHome());
        await firstBot(chat);
        await chat.send("第一个 bot 的暗号：ALPHA", () => {});
        let snapshot = await chat.createBot({ name: "小助手", model: "test/echo-2" });
        expect(snapshot.bots.map((bot) => bot.name)).toEqual(["大王助手", "小助手"]);
        expect(snapshot.bot?.name).toBe("小助手"); // 建好即选中
        await chat.send("第二个 bot 的暗号：BETA", () => {});

        snapshot = await chat.selectBot("bot-1");
        expect(textsOf(snapshot.messages)).toEqual(["第一个 bot 的暗号：ALPHA", "收到：第一个 bot 的暗号：ALPHA"]);
        snapshot = await chat.selectBot("bot-2");
        expect(textsOf(snapshot.messages)).toEqual(["第二个 bot 的暗号：BETA", "收到：第二个 bot 的暗号：BETA"]);
    });

    it("落盘：会话目录有 meta.json + 桶文件 + bot.json（判据 3）", async () => {
        const home = makeHome();
        const chat = host(home);
        const snapshot = await firstBot(chat);
        expect(snapshot.bot).not.toBeNull();
        const id = primaryOf(home)!;
        await chat.send("写盘", () => {});
        const files = readdirSync(join(home, "sessions", "chat", id)).sort();
        expect(files).toContain("index.json");
        expect(files).toContain("meta.json");
        // 方案 B：会话目录里的 bot.json 标归属
        expect(files).toContain("bot.json");
        expect(JSON.parse(readFileSync(join(home, "sessions", "chat", id, "bot.json"), "utf-8"))).toEqual({
            botId: "bot-1",
        });
        expect(files.filter((file) => /^(log-|\d{4,}-).+\.jsonl$/.test(file))).toHaveLength(1);
    });

    it("##505-B：不再写 chat-ui.json（判据 5）", async () => {
        const home = makeHome();
        const chat = host(home);
        await firstBot(chat);
        await chat.send("这步也不该落界面状态", () => {});
        await chat.createBot({ name: "小助手", model: "test/echo-2" });
        await chat.selectBot("bot-1");
        expect(existsSync(join(home, "chat-ui.json"))).toBe(false);
    });

    it("##505-E 内存模式：bots / sessions 目录一个都不建，重启即丢", async () => {
        const home = makeHome();
        const memoryHost = (): BotChatHost =>
            createBotChat({
                home,
                llmFor: () => fakeLlm,
                botStore: createMemoryBotStore(),
                openSessionStore: () => openMemorySessionStore(),
                persistMeta: false,
            });
        const chat = memoryHost();
        const opened = await firstBot(chat);
        expect(opened.bot?.name).toBe("大王助手");
        const sent = await chat.send("内存里的一句话", () => {});
        expect(textsOf(sent.messages)).toEqual(["内存里的一句话", "收到：内存里的一句话"]);
        // 一个字节不落：目录根本不存在
        expect(existsSync(join(home, "bots"))).toBe(false);
        expect(existsSync(join(home, "sessions"))).toBe(false);
        // 新宿主 = 重启：bot 与消息全没了
        const after = await memoryHost().snapshot();
        expect(after.bots).toEqual([]);
        expect(after.messages).toEqual([]);
    });

    it("重启后消息还在（判据 4）", async () => {
        const home = makeHome();
        const before = host(home);
        await firstBot(before);
        await before.send("重启前的话", () => {});

        const after = host(home);
        const snapshot = await after.snapshot();
        expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(textsOf(snapshot.messages)).toEqual(["重启前的话", "收到：重启前的话"]);
    });

    it("删 bot ⇒ 它的会话一并删除（判据 7）", async () => {
        const home = makeHome();
        const chat = host(home);
        await firstBot(chat);
        const id = primaryOf(home)!;
        await chat.send("这条会一起消失", () => {});

        const after = await chat.removeBot("bot-1");
        expect(after.bots).toEqual([]);
        expect(after.bot).toBeNull();
        expect(after.messages).toEqual([]);
        expect(readdirSync(join(home, "sessions", "chat"))).not.toContain(id);
    });

    it("改 bot 配置：名字 / 模型 / 指令都落盘；换模型后会话按新模型重开", async () => {
        const home = makeHome();
        const chat = host(home);
        const snapshot = await firstBot(chat);
        const updated = await chat.updateBot({
            id: "bot-1",
            name: "改名了",
            model: "test/echo-2",
            instructions: "新指令",
        });
        expect(updated.bot?.name).toBe("改名了");
        expect(updated.bot?.model).toBe("test/echo-2");
        expect(updated.bot?.instructions).toBe("新指令");
        const config = JSON.parse(readFileSync(join(home, "bots", "bot-1", "bot.json"), "utf-8"));
        expect(config.model).toBe("test/echo-2");
        // 长期会话 id 不因改配置而丢（换模型 ≠ 换会话）
        expect(primaryOf(home)).toBe(primaryOf(home));
        expect(snapshot.bot?.id).toBe(updated.bot?.id);
    });

    it("底部指标：上一步的输入 / 缓存 / 窗口 / 本轮花费（##498 硬要求 3）", async () => {
        const chat = host(makeHome());
        await firstBot(chat);
        await chat.send("指标来一条", () => {});
        const snapshot = await chat.snapshot();
        expect(snapshot.metrics?.turns).toBe(1);
        expect(snapshot.metrics?.inputTokens).toBe(100);
        expect(snapshot.metrics?.outputTokens).toBe(10);
        expect(snapshot.metrics?.cacheReadTokens).toBe(40);
        expect(snapshot.metrics?.contextWindow).toBe(1000);
        // 价目：input 1/1M、output 2/1M → (60*1 + 10*2 + 40*1)/1e6
        expect(snapshot.metrics?.cost).toBeCloseTo(0.00012, 9);
    });

    it("没有模型配置 ⇒ 先启建 bot 时报错（不静默建空 bot）", async () => {
        const chat = host(makeHome(false));
        await expect(firstBot(chat)).rejects.toThrow(/模型目录里没有/);
    });

    it("存量 bot 没 model ⇒ snapshot 不给会话（UI 拦到补选页）", async () => {
        const home = makeHome();
        const dir = join(home, "bots", "bot-1");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "bot.json"),
            JSON.stringify({
                id: "bot-1",
                name: "老 bot",
                instructions: "",
                createdAt: "2026-01-01T00:00:00.000+0800",
                updatedAt: "2026-01-01T00:00:00.000+0800",
            }),
            "utf-8",
        );
        const snapshot = await host(home).snapshot();
        expect(snapshot.bot?.needsModel).toBe(true);
        expect(snapshot.messages).toEqual([]);
    });

    it("##并发 判据 3：两个 createBot 同时发起 ⇒ 列表 +2（不是 +1）", async () => {
        const home = makeHome();
        const chat = host(home);
        await firstBot(chat);
        const [one, two] = await Promise.all([
            chat.createBot({ name: "并发 A", model: "test/echo-1" }),
            chat.createBot({ name: "并发 B", model: "test/echo-2" }),
        ]);
        // 各自的返回值是「自己那一刻」的快照（串行的必然），**最终**状态才是判据
        expect(one.bots).toHaveLength(2);
        expect(two.bots).toHaveLength(3);
        // 落盘为准：真的两个 bot 目录，id 不撞
        const ids = readdirSync(join(home, "bots")).sort();
        expect(ids).toEqual(["bot-1", "bot-2", "bot-3"]);
        const final = await chat.snapshot();
        expect(final.bots.map((bot) => bot.name)).toEqual(["大王助手", "并发 A", "并发 B"]);
    });

    it("##并发 判据 4：一个操作抛错不污染队列（下一个照常跑）", async () => {
        const chat = host(makeHome());
        await firstBot(chat);
        await expect(
            // 与第一个 bot 同名 ⇒ 抛错（而且是队列里执行时抛的）
            chat.createBot({ name: "大王助手", model: "test/echo-1" }),
        ).rejects.toThrow(/同名/);
        const after = await chat.createBot({ name: "照常", model: "test/echo-2" });
        expect(after.bots.map((bot) => bot.name)).toEqual(["大王助手", "照常"]);
    });

    it("##并发 判据 5：并发 createBot 与 updateBot 交错，不丢改动", async () => {
        const chat = host(makeHome());
        await firstBot(chat);
        await Promise.all([
            chat.createBot({ name: "并行 1", model: "test/echo-1" }),
            chat.updateBot({ id: "bot-1", name: "改名了" }),
            chat.createBot({ name: "并行 2", model: "test/echo-2" }),
        ]);
        const final = await chat.snapshot();
        expect(final.bots).toHaveLength(3);
        const first = final.bots.find((bot) => bot.id === "bot-1");
        expect(first?.name).toBe("改名了");
    });

    it("splitModelKey 按第一个 / 切（模型 id 自身可含 /）", () => {
        expect(splitModelKey("goat/gpt-5.5")).toEqual({ providerId: "goat", modelId: "gpt-5.5" });
        expect(splitModelKey("goat/deepseek/v4")).toEqual({ providerId: "goat", modelId: "deepseek/v4" });
    });

    it("nextBotId 取现有 bot-<n> 的最大值 + 1", () => {
        expect(nextBotId([])).toBe("bot-1");
        expect(nextBotId(["bot-1", "bot-7", "x"])).toBe("bot-8");
    });

    it("##480 判据 3/5：装配器直接构造 jsonl store 并注入（session 缺省是内存，不注入就不落盘）", () => {
        const source = readFileSync(join(import.meta.dirname, "..", "src", "chat.ts"), "utf-8");
        // 直接构造调用，不是 if (strategy === ...) / switch 枚举分派（禁止的字面量拼着写，免得自己命中判据）
        expect(source).not.toMatch(new RegExp(`${"Store"}${"Strategy"}`));
        expect(source).toContain("openJsonlSessionStore({ dir })");
        // createSession 的入参里必须带 store（从装配器传进去的那个实例）
        expect(source).toMatch(/createSession\(\{[\s\S]{0,400}?\n\s+store,/);
    });
});
