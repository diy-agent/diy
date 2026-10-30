import { describe, expect, it } from "vitest";
import { createPage } from "../src/main.js";
import { FAKE_REPLY } from "../src/main.js";
import type { SendResult } from "../src/shared.js";

describe("createPage（主进程侧）", () => {
    it("交付 id / title / methods", () => {
        const page = createPage();
        expect(page.id).toBe("chat");
        expect(page.title).toBe("聊天");
        expect(typeof page.methods?.["send"]).toBe("function");
    });

    it("send 回一条固定回复，消息线 = user + assistant", async () => {
        const page = createPage();
        const result = (await page.methods!["send"]!("在吗")) as SendResult;
        expect(result.messages).toEqual([
            { role: "user", text: "在吗" },
            { role: "assistant", text: FAKE_REPLY },
        ]);
    });

    it("第二条消息追加在消息线后面", async () => {
        const page = createPage();
        await page.methods!["send"]!("第一条");
        const result = (await page.methods!["send"]!("第二条")) as SendResult;
        expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    });

    it("空正文即抛", async () => {
        const page = createPage();
        await expect(page.methods!["send"]!("   ")).rejects.toThrow(/正文为空/);
    });

    it("config.store 注入即落盘（宿主给端口，插件不碰文件系统）", async () => {
        const appended: unknown[] = [];
        const store = {
            append: (messages: readonly unknown[]) => void appended.push(...messages),
            readFrom: () => [],
            readRange: () => [],
            latestSeq: () => 0,
        };
        const page = createPage({ store });
        await page.methods!["send"]!("要落盘的话");
        // 假模型这条路带一条 system 话术，也一并在内（真 provider 那条不写 system）
        expect(appended.map((m) => (m as { role: string }).role)).toEqual(["system", "user", "assistant"]);
    });

    it("store 形状不对 ⇒ 退回纯内存（不炸，也不静默丢半条）", async () => {
        const page = createPage({ store: { append: "不是函数" } });
        const result = (await page.methods!["send"]!("在吗")) as SendResult;
        expect(result.messages).toHaveLength(2);
    });

    it("config.reply 可以换固定文本（装配层用）", async () => {
        const page = createPage({ reply: "另一句" });
        const result = (await page.methods!["send"]!("嗨")) as SendResult;
        expect(result.messages[1]).toEqual({ role: "assistant", text: "另一句" });
    });
});
