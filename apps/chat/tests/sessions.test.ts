import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmPort } from "@diy-agent/session";
import { createChatSessions, splitModelKey } from "../sessions.js";

/** 临时数据根：一个 custom provider（test/echo-1），key 是假值（不会被用，llmFor 注入假模型） */
function makeHome(model = true): string {
    const home = mkdtempSync(join(tmpdir(), "app-chat-"));
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
        yield { type: "usage", inputTokens: 1, outputTokens: 1 };
        yield { type: "done", stopReason: "stop" };
    },
};

const host = (home: string) => createChatSessions({ home, llmFor: () => fakeLlm });

describe("apps/chat 多会话宿主", () => {
    it("模型目录来自 model.yaml / providers.custom.yaml（provider×model）", async () => {
        const sessions = host(makeHome());
        const snapshot = await sessions.snapshot();
        expect(snapshot.models.map((choice) => `${choice.providerId}/${choice.modelId}`)).toEqual([
            "test/echo-1",
            "test/echo-2",
        ]);
        expect(snapshot.sessions).toEqual([]);
    });

    it("新建 → 发消息 → 列表出现标题，消息线是 user + assistant", async () => {
        const sessions = host(makeHome());
        let snapshot = await sessions.create({});
        expect(snapshot.sessions).toHaveLength(1);
        const id = snapshot.activeId!;
        snapshot = await sessions.send(id, "你好呀", () => {});
        expect(snapshot.messages).toEqual([
            { role: "user", text: "你好呀" },
            { role: "assistant", text: "收到：你好呀" },
        ]);
        expect(snapshot.sessions[0]?.title).toBe("你好呀");
        expect(snapshot.sessions[0]?.messageCount).toBe(2);
    });

    it("多会话隔离：第二个会话的消息不出现在第一个里（判据 2）", async () => {
        const sessions = host(makeHome());
        const first = (await sessions.create({})).activeId!;
        await sessions.send(first, "会话一的暗号：ALPHA", () => {});
        const second = (await sessions.create({})).activeId!;
        await sessions.send(second, "会话二的暗号：BETA", () => {});

        const secondView = await sessions.select(second);
        expect(secondView.messages.map((message) => message.text)).toEqual([
            "会话二的暗号：BETA",
            "收到：会话二的暗号：BETA",
        ]);
        const firstView = await sessions.select(first);
        expect(firstView.messages.map((message) => message.text)).toEqual([
            "会话一的暗号：ALPHA",
            "收到：会话一的暗号：ALPHA",
        ]);
    });

    it("落盘：会话目录有 meta.json + 桶文件（判据 3）", async () => {
        const home = makeHome();
        const sessions = host(home);
        const id = (await sessions.create({})).activeId!;
        await sessions.send(id, "写盘", () => {});
        const files = readdirSync(join(home, "sessions", "chat", id)).sort();
        expect(files).toContain("index.json");
        expect(files).toContain("meta.json");
        // ##469 判据 2：会话目录里的 bot.json 标归属（方案 B）
        expect(files).toContain("bot.json");
        expect(JSON.parse(readFileSync(join(home, "sessions", "chat", id, "bot.json"), "utf-8"))).toEqual({
            botId: "bot-1",
        });
        // 桶名以 store 的契约为准（##464 后为 `<序号>-<本地时间>.jsonl`，旧 `log-…` 仍认；
        // 这里只认「一个桶」——两套命名都算）
        expect(files.filter((file) => /^(log-|\d{4,}-).+\.jsonl$/.test(file))).toHaveLength(1);
    });

    it("重启后会话还在：新宿主实例仍能列出并恢复消息（判据 4）", async () => {
        const home = makeHome();
        const before = host(home);
        const id = (await before.create({})).activeId!;
        await before.send(id, "重启前的话", () => {});

        const after = host(home);
        const snapshot = await after.snapshot();
        expect(snapshot.sessions.map((session) => session.id)).toEqual([id]);
        const reopened = await after.select(id);
        expect(reopened.messages).toEqual([
            { role: "user", text: "重启前的话" },
            { role: "assistant", text: "收到：重启前的话" },
        ]);
    });

    it("##469 判据 1：默认 bot「大王助手」落 ~/.diy/bots/bot-1/bot.json，字段完整", async () => {
        const home = makeHome();
        await host(home).create({});
        const config = JSON.parse(readFileSync(join(home, "bots", "bot-1", "bot.json"), "utf-8"));
        expect(config.id).toBe("bot-1");
        expect(config.name).toBe("大王助手");
        expect(typeof config.instructions).toBe("string"); // ##470：行为指令改名 instructions
        expect(typeof config.createdAt).toBe("string");
        expect(typeof config.updatedAt).toBe("string");
    });

    it("没有模型配置 ⇒ 新建时报错（不静默建空会话）", async () => {
        const sessions = host(makeHome(false));
        await expect(sessions.create({})).rejects.toThrow(/没有可用模型/);
    });

    it("splitModelKey 按第一个 / 切（模型 id 自身可含 /）", () => {
        expect(splitModelKey("goat/gpt-5.5")).toEqual({ providerId: "goat", modelId: "gpt-5.5" });
        expect(splitModelKey("goat/deepseek/v4")).toEqual({ providerId: "goat", modelId: "deepseek/v4" });
    });

    it("##480 判据 3/5：装配器直接构造 jsonl store 并注入（session 缺省是内存，不注入就不落盘）", () => {
        const source = readFileSync(join(import.meta.dirname, "..", "sessions.ts"), "utf-8");
        // 直接构造调用，不是 if (strategy === ...) / switch 枚举分派（禁止的字面量拼着写，免得自己命中判据）
        expect(source).not.toMatch(new RegExp(`${'Store'}${'Strategy'}`));
        expect(source).toContain("openJsonlSessionStore({ dir })");
        // createSession 的入参里必须带 store（从装配器传进去的那个实例）
        expect(source).toMatch(/createSession\(\{[\s\S]{0,300}?\n\s+store,/);
    });
});
