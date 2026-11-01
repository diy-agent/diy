// tests/uri.test.ts — ##497 判据 1/2：稳定标识与显示地址的拼 / 解，以及「只存稳定标识」
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotError, botUri, isStableBotUri, parseBotUri } from "../src/index.js";

const NODE = "diy-614a1022";
const DISPLAY = "diy://ccc@c-mac/diy-web.lab:8123/bot/bot-1";

describe("botUri（拼稳定标识）", () => {
    it("判据 1：diy://<nodeId>/bot/<botId>", () => {
        expect(botUri({ nodeId: NODE, botId: "bot-1" })).toBe("diy://diy-614a1022/bot/bot-1");
    });

    it("nodeId 不是实例 id 就抛（显示地址不许进存储）", () => {
        for (const nodeId of ["ccc@c-mac", "ccc@c-mac/diy-web.lab:8123", "diy-614A1022", "diy-614a102", ""]) {
            expect(() => botUri({ nodeId, botId: "bot-1" })).toThrow(BotError);
            expect(() => botUri({ nodeId, botId: "bot-1" })).toThrow(/nodeId/);
        }
    });

    it("botId 非法就抛（不许穿越目录）", () => {
        for (const botId of ["", "a/b", "..", ".", "/x"]) {
            expect(() => botUri({ nodeId: NODE, botId })).toThrow(BotError);
        }
    });
});

describe("parseBotUri（反解）", () => {
    it("判据 2：稳定标识原样反解回来", () => {
        const uri = botUri({ nodeId: NODE, botId: "bot-1" });
        const parsed = parseBotUri(uri);
        expect(parsed).toEqual({ kind: "stable", displayOnly: false, nodeId: NODE, botId: "bot-1", uri });
        expect(isStableBotUri(parsed)).toBe(true);
    });

    it("判据 2：显示地址返回 displayOnly: true（node 段自带 / 也能拆对）", () => {
        const parsed = parseBotUri(DISPLAY);
        expect(parsed).toEqual({
            kind: "display",
            displayOnly: true,
            address: "ccc@c-mac/diy-web.lab:8123",
            botId: "bot-1",
            uri: DISPLAY,
        });
        expect(isStableBotUri(parsed)).toBe(false);
    });

    it("形状不对得 null（不抛）", () => {
        for (const bad of ["", "bot-1", "diy://", "diy://diy-614a1022", "diy://diy-614a1022/bot/", "http://x/bot/bot-1"]) {
            expect(parseBotUri(bad)).toBeNull();
        }
    });
});

describe("边界", () => {
    it("uri.ts 是纯函数：不碰 fs / 不认识 node 从哪来", () => {
        const source = readFileSync(join(import.meta.dirname, "..", "src", "uri.ts"), "utf-8");
        expect(source).not.toContain("node:fs");
        expect(source).not.toContain("node:path");
        expect(source).not.toContain("process.env");
    });
});
