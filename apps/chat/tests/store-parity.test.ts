// tests/store-parity.test.ts — **装配层**的参数化回归（##505 bug）
//
// 用户实测：内存模式下从「Bot 配置」页建了 2 个 bot，聊天页列表还是空的；
// 文件模式却正常。根因 = 两个页面各建各的 bot 存储（配置页写文件、聊天页写内存）。
//
// 判据（用户原话）：「用参数测试切换测试 bot 流程，保证文件存储和内存都保证行为的一致性」。
// 所以这里**不测单个宿主**，测的是**整份装配**：同一个 bot 在两个页面里必须互相看得见。

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBotChat, createMemoryBotStore, type BotChatHost } from "@diy-agent/bot";
import { loadPages } from "@diy-agent/workbench/loader";
import { openMemorySessionStore, type LlmPort } from "@diy-agent/session";
import { createAssembly } from "../index.js";

interface BotRow {
    readonly id: string;
    readonly name: string;
}

interface ChatSnap {
    readonly bots: readonly BotRow[];
    readonly models: readonly { providerId: string; modelId: string }[];
}

interface Harness {
    readonly home: string;
    /** 整份装配起来的页面方法（chat / bot-config） */
    invoke(page: "chat" | "bot-config", method: string, args?: unknown): Promise<unknown>;
    snapshot(page: "chat" | "bot-config"): Promise<ChatSnap>;
}

const fakeLlm: LlmPort = {
    async *chat(messages) {
        const last = [...messages].reverse().find((message) => message.role === "user");
        yield { type: "text", text: `收到：${last?.text ?? ""}` };
        yield { type: "usage", inputTokens: 10, outputTokens: 2 };
        yield { type: "done", stopReason: "stop" };
    },
};

function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "chat-parity-"));
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

async function setup(kind: "file" | "memory"): Promise<Harness> {
    const home = makeHome();
    const memory = kind === "memory";
    // 内存入口的装配：一个 store，聊天宿主与配置页共用（main-memory.mjs 就是这么接的）
    const botStore = memory ? createMemoryBotStore() : undefined;
    const chat: BotChatHost = createBotChat({
        home,
        llmFor: () => fakeLlm,
        ...(botStore === undefined ? {} : { botStore }),
        ...(memory
            ? { openSessionStore: () => openMemorySessionStore(), persistMeta: false }
            : {}),
    });
    const pages = await loadPages(
        createAssembly({
            home,
            sessions: chat,
            ...(botStore === undefined ? {} : { botStore }),
        }).plugins,
    );
    const byId = new Map(pages.map((page) => [page.id, page]));
    const invoke = async (page: "chat" | "bot-config", method: string, args?: unknown): Promise<unknown> => {
        const fn = byId.get(page)?.methods?.[method];
        if (typeof fn !== "function") throw new Error(`${page}.${method} 不存在`);
        return fn(args);
    };
    const snapshot = async (page: "chat" | "bot-config"): Promise<ChatSnap> =>
        (await invoke(page, "snapshot")) as ChatSnap;
    return { home, invoke, snapshot };
}

describe.each([["file"], ["memory"]] as const)("%s store（整份装配）", (kind) => {
    it("##505 bug：从「Bot 配置」页建 bot，聊天页列表里看得到", async () => {
        const { invoke, snapshot } = await setup(kind);
        const { models } = await snapshot("bot-config");
        const model = `${models[0].providerId}/${models[0].modelId}`;

        await invoke("bot-config", "createBot", { name: "大王助手", model });
        await invoke("bot-config", "createBot", { name: "史蒂夫", model });

        const chat = await snapshot("chat");
        expect(chat.bots.map((bot) => bot.name)).toEqual(["大王助手", "史蒂夫"]);
    });

    it("反向：聊天页建 bot，配置页也看得到", async () => {
        const { invoke, snapshot } = await setup(kind);
        const { models } = await snapshot("chat");
        const model = `${models[0].providerId}/${models[0].modelId}`;

        await invoke("chat", "createFirstBot", { name: "大王助手", model });
        await invoke("chat", "createBot", { name: "史蒂夫", model });

        const config = await snapshot("bot-config");
        expect(config.bots.map((bot) => bot.name)).toEqual(["大王助手", "史蒂夫"]);
    });

    it("删除在两侧都生效", async () => {
        const { invoke, snapshot } = await setup(kind);
        const { models } = await snapshot("chat");
        const model = `${models[0].providerId}/${models[0].modelId}`;
        await invoke("chat", "createFirstBot", { name: "大王助手", model });
        const [bot] = (await snapshot("chat")).bots;

        await invoke("bot-config", "removeBot", { id: bot.id });
        expect((await snapshot("chat")).bots).toEqual([]);
        expect((await snapshot("bot-config")).bots).toEqual([]);
    });

    it("内存模式一个字节不落盘（bots / sessions 目录都不存在）", async () => {
        const { home, invoke, snapshot } = await setup(kind);
        const { models } = await snapshot("chat");
        const model = `${models[0].providerId}/${models[0].modelId}`;
        await invoke("bot-config", "createBot", { name: "大王助手", model });
        await invoke("chat", "send", { text: "你好" });

        if (kind === "file") {
            expect(existsSync(join(home, "bots"))).toBe(true);
        } else {
            expect(existsSync(join(home, "bots"))).toBe(false);
            expect(existsSync(join(home, "sessions"))).toBe(false);
        }
    });
});
