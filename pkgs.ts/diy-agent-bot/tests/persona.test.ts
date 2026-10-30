// tests/persona.test.ts — ##470 判据 3：旧格式（personas.yaml 的 instructions / bot.json 的 persona）
// 与 bot 新格式都能被解析。
//
// 两种输入各自是什么：
//   · personas.yaml：`{ default, personas: { <id>: { name, model, reasoningEffort, instructions } } }`
//     —— schema 原样搬进本包（PersonasFileSchema），语义一个字没改
//   · bot.json：BotConfig（= 人设 + id + 时间）。##469 写的存量文件里行为指令叫 `persona`，
//     读兼容映射到 `instructions`；写出去一律用新字段名
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    PersonaDefSchema,
    PersonaSchema,
    PersonasFileSchema,
    createFileBotStore,
    type BotConfig,
    type PersonaDef,
    ensureBot,
} from "../src/index.js";

function makeHome(): string {
    return mkdtempSync(join(tmpdir(), "diy-bot-persona-"));
}

describe("persona schema（唯一源在 bot 包）", () => {
    it("旧 personas.yaml 形状照旧能解析（instructions / reasoningEffort 语义不变）", () => {
        const file = PersonasFileSchema.parse({
            default: "persona/1",
            personas: {
                "persona/1": { name: "大副", model: "mimo-v2.6-flash", reasoningEffort: "high", instructions: "先给结论。" },
                "persona/2": {
                    name: "密探",
                    model: "mimo-v2.6-flash",
                    reasoningEffort: "low",
                    maxOutputTokens: 2048,
                    instructions: "",
                },
            },
        });
        expect(file.personas["persona/1"]?.instructions).toBe("先给结论。");
        expect(file.personas["persona/2"]?.maxOutputTokens).toBe(2048);
        // 非法输入仍被拦住（schema 是唯一判据，不靠调用方自觉）
        expect(PersonaDefSchema.safeParse({ name: "甲", model: "m" }).success).toBe(false);
        expect(PersonaSchema.parse({ id: "persona/1", ...file.personas["persona/1"] }).id).toBe("persona/1");
    });

    it("BotConfig 是人设 + id + 时间（字段与 PersonaDef 对齐，编译期即可判定）", () => {
        // 类型层断言：BotConfig 的行为指令字段叫 instructions；PersonaDef 的字段都能落进 BotConfig
        const def: PersonaDef = { name: "甲", model: "m", reasoningEffort: "low", instructions: "短" };
        const config: BotConfig = {
            id: "bot-1",
            name: def.name,
            model: def.model,
            reasoningEffort: def.reasoningEffort,
            instructions: def.instructions,
            createdAt: "2026-10-30T08:00:00.000Z",
            updatedAt: "2026-10-30T08:00:00.000Z",
        };
        expect(config.instructions).toBe("短");
    });
});

describe("store-fs 读兼容（##470）", () => {
    it("存量 bot.json 用旧字段名 persona：load 出来是 instructions，文件不动", async () => {
        const home = makeHome();
        mkdirSync(join(home, "bots", "bot-1"), { recursive: true });
        const legacy = {
            id: "bot-1",
            name: "大王助手",
            persona: "旧字段写的行为指令",
            model: "deepseek/deepseek-chat",
            createdAt: "2026-10-30T08:00:00.000Z",
            updatedAt: "2026-10-30T08:00:00.000Z",
        };
        writeFileSync(join(home, "bots", "bot-1", "bot.json"), `${JSON.stringify(legacy, null, 4)}\n`);

        const store = createFileBotStore({ home });
        const config = await store.load("bot-1");
        expect(config?.instructions).toBe("旧字段写的行为指令");
        expect(config).not.toHaveProperty("persona");
    });

    it("新字段 reasoningEffort / maxOutputTokens 往返落盘", async () => {
        const home = makeHome();
        const store = createFileBotStore({ home });
        const config = await ensureBot(store, {
            id: "bot-1",
            name: "甲",
            instructions: "只回要点",
            model: "deepseek/deepseek-chat",
            reasoningEffort: "low",
            maxOutputTokens: 1024,
        });
        expect(await store.load("bot-1")).toEqual(config);
        expect(config.reasoningEffort).toBe("low");
        expect(config.maxOutputTokens).toBe(1024);
    });
});
