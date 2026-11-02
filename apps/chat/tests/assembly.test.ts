import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSEMBLY } from "../index.js";

describe("apps/chat 装配清单", () => {
    it("装的是 chat-page + model-config-page + bot-config-page 插件（type: module，真模块）", () => {
        expect(ASSEMBLY.plugins.map((entry) => entry.id)).toEqual([
            "chat-page",
            "model-config-page",
            "bot-config-page",
        ]);
        for (const entry of ASSEMBLY.plugins) {
            expect(entry.type).toBe("module");
            expect(typeof (entry.data as { module: { default?: unknown } }).module.default).toBe("function");
        }
    });

    it("model-config 页的装配配置带数据根（DIY_HOME 存在时）", () => {
        const config = (ASSEMBLY.plugins[1] as { config?: { home?: string } }).config;
        if (process.env["DIY_HOME"] === undefined) {
            expect(config?.home).toBeUndefined();
            return;
        }
        expect(config?.home).toBe(process.env["DIY_HOME"]);
    });

    it("bot-config 页的装配配置带数据根（DIY_HOME 存在时）", () => {
        const config = (ASSEMBLY.plugins[2] as { config?: { home?: string } }).config;
        if (process.env["DIY_HOME"] === undefined) {
            expect(config?.home).toBeUndefined();
            return;
        }
        expect(config?.home).toBe(process.env["DIY_HOME"]);
    });

    it("DIY_HOME 存在 ⇒ 注入多会话宿主；缺席 ⇒ 不注入（退回插件单会话形态）", () => {
        const sessions = (ASSEMBLY.plugins[0] as { config?: { sessions?: Record<string, unknown> } }).config?.sessions;
        if (process.env["DIY_HOME"] === undefined) {
            expect(sessions).toBeUndefined();
            return;
        }
        expect(typeof sessions?.["snapshot"]).toBe("function");
        expect(typeof sessions?.["send"]).toBe("function");
        // ##498：多 bot 的那几个方法（宿主能力判据就是这一串）
        for (const method of ["createFirstBot", "createBot", "updateBot", "removeBot", "selectBot"]) {
            expect(typeof sessions?.[method]).toBe("function");
        }
    });
});

describe("apps/chat 瘦身（##505 判据）", () => {
    // 260 而非 250：##505 bug 二修（落盘入口也共用 store）需要装配层多 2 行；
    // 判据的本意是「业务别泄进装配层」，252 行仍然是纯装配（判据 10 会验证），不是放宽架构。
    it("判据 1：apps/chat 的 ts / mjs 源码 ≤ 260 行（不含 build / lib / tests / scripts）", () => {
        const dir = join(import.meta.dirname, "..");
        // vitest.config.ts 是测试工具配置，不是应用代码 —— 不计入瘦身判据。
        const files = readdirSync(dir).filter((name) => /\.(ts|mjs)$/.test(name) && name !== "vitest.config.ts");
        const total = files.reduce(
            (sum, name) => sum + readFileSync(join(dir, name), "utf-8").replace(/\n$/, "").split("\n").length,
            0,
        );
        expect(total).toBeLessThanOrEqual(260);
    });

    it("判据 2：sessions.ts 已删除，装配层不再有业务宿主", () => {
        expect(existsSync(join(import.meta.dirname, "..", "sessions.ts"))).toBe(false);
    });

    it("判据 10：index.ts 只做装配（createBotChat + 插件清单，没有会话编排）", () => {
        const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf-8");
        expect(source).toContain("createBotChat({");
        // 业务关键词不该出现在装配层（createSession / openJsonlSessionStore / loadCatalog / costOf）
        for (const word of ["createSession", "openJsonlSessionStore", "loadCatalog", "costOf"]) {
            expect(source).not.toContain(word);
        }
    });
});
