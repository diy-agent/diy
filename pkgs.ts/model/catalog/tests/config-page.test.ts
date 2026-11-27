// config-page.test.ts —— 配置页要的两件事：**可用清单**（含还没接的）与**写侧新动词**。
//
// 为什么单独一个文件：`catalog.test.ts` 测的是「目录里能选什么」（已配置的投影），
// 这里测的是「目录里还有什么、为什么被关掉」—— 后者是配置页存在的理由，
// 两者的判据不同（前者的红线是不含未接入的，后者必须包含）。
//
// 硬边界照旧：**任何回包里都没有 key 值**，账号只有名字 / 填没填 / 字符数。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
    availableProviders,
    removeAccount,
    renameAccount,
    saveAccount,
    saveProvider,
} from "../src/index.js";

function makeHome(files: { model?: string; custom?: string; snapshot?: unknown } = {}): string {
    const home = mkdtempSync(join(tmpdir(), "model-catalog-config-"));
    if (files.model !== undefined) writeFileSync(join(home, "model.yaml"), files.model, "utf-8");
    if (files.custom !== undefined) writeFileSync(join(home, "providers.custom.yaml"), files.custom, "utf-8");
    if (files.snapshot !== undefined) {
        mkdirSync(join(home, "data"), { recursive: true });
        writeFileSync(join(home, "data", "models.dev.json"), JSON.stringify(files.snapshot), "utf-8");
    }
    return home;
}

const SNAPSHOT = {
    acme: {
        id: "acme",
        name: "Acme",
        npm: "@ai-sdk/openai-compatible",
        api: "https://acme.example/v1",
        env: ["ACME_API_KEY"],
        doc: "https://acme.example/docs",
        models: {
            "small-1": { name: "Small 1", limit: { context: 128000, output: 4096 } },
            "big-1": { name: "Big 1", limit: { context: 1000000 } },
            "legacy-1": { name: "Legacy 1" },
        },
    },
    /** 没有 api 的一家：models.dev 里的 openai 就是这样（走 SDK 内置 endpoint） */
    sdkbuiltin: {
        id: "sdkbuiltin",
        name: "SDK Builtin",
        npm: "@ai-sdk/openai",
        env: ["OPENAI_API_KEY"],
        models: { "gpt-x": { name: "GPT X" } },
    },
};

const CUSTOM = `goat:
  id: goat
  npm: '@ai-sdk/openai-compatible'
  api: https://goat.example/v1
  models:
    m1:
      id: m1
      name: Model One
`;

const MODEL = `defaultModel: main@acme/small-1
stdProviders:
  acme:
    accounts:
      - type: apiKey
        name: main
        data:
          value: sk-SECRET-ACME-1234
    filter:
      exclude: [legacy-1]
`;

describe("availableProviders", () => {
    it("把「目录里有、还没接」的也列出来（configured: false），否则配置页无从添加", () => {
        const home = makeHome({ model: MODEL, custom: CUSTOM, snapshot: SNAPSHOT });
        const providers = availableProviders(home);
        const byId = new Map(providers.map((provider) => [provider.providerId, provider]));

        expect([...byId.keys()].sort()).toEqual(["acme", "goat", "sdkbuiltin"]);
        expect(byId.get("acme")?.configured).toBe(true);
        expect(byId.get("goat")?.configured).toBe(false);
        expect(byId.get("sdkbuiltin")?.configured).toBe(false);
        // 自定义 spec 的那家虽然没接，规格照样要能看见（不然不知道它是什么）
        expect(byId.get("goat")?.api).toBe("https://goat.example/v1");
        expect(byId.get("goat")?.models.map((model) => model.id)).toEqual(["m1"]);
    });

    it("模型带上 enabled：被 filter.exclude 关掉的仍在列表里，只是勾掉", () => {
        const home = makeHome({ model: MODEL, snapshot: SNAPSHOT });
        const acme = availableProviders(home).find((provider) => provider.providerId === "acme")!;
        expect(acme.models.map((model) => [model.id, model.enabled])).toEqual([
            ["small-1", true],
            ["big-1", true],
            ["legacy-1", false],
        ]);
        // 目录（能选什么）里没有 legacy-1 —— 这就是两份视图的差别
        expect(acme.models).toHaveLength(3);
    });

    it("名称 / 环境变量 / 文档来自快照；没有 api 的那家 api 缺省（界面据它报「发不出去」）", () => {
        const home = makeHome({ model: MODEL, snapshot: SNAPSHOT });
        const providers = availableProviders(home);
        const acme = providers.find((provider) => provider.providerId === "acme")!;
        expect(acme.name).toBe("Acme");
        expect(acme.envKeys).toEqual(["ACME_API_KEY"]);
        expect(acme.doc).toBe("https://acme.example/docs");
        expect(providers.find((provider) => provider.providerId === "sdkbuiltin")?.api).toBeUndefined();
    });

    it("账号只有名字 / 填没填 / 字符数 —— **没有 key 值**", () => {
        const home = makeHome({ model: MODEL, snapshot: SNAPSHOT });
        const acme = availableProviders(home).find((provider) => provider.providerId === "acme")!;
        expect(acme.accounts).toEqual([{ name: "main", configured: true, env: false, chars: "sk-SECRET-ACME-1234".length }]);
        expect(JSON.stringify(acme)).not.toContain("sk-SECRET-ACME");
    });
});

describe("write：filter / 账号", () => {
    it("saveProvider 写 filter（include null = 删键，空数组 = 也删，不留空 filter: {}）", () => {
        const home = makeHome({ model: MODEL, snapshot: SNAPSHOT });
        saveProvider(home, { providerId: "acme", filter: { include: null, exclude: ["big-1"] } });
        let doc = loadYaml(readFileSync(join(home, "model.yaml"), "utf-8")) as Record<string, never>;
        expect(doc["stdProviders"]).toEqual({
            acme: { accounts: [{ type: "apiKey", name: "main", data: { value: "sk-SECRET-ACME-1234" } }], filter: { exclude: ["big-1"] } },
        });

        // 全放行：两个键都空 ⇒ filter 整个消失（不是留一个 `filter: {}`）
        saveProvider(home, { providerId: "acme", filter: { include: null, exclude: null } });
        doc = loadYaml(readFileSync(join(home, "model.yaml"), "utf-8")) as Record<string, never>;
        expect((doc["stdProviders"] as Record<string, Record<string, unknown>>)["acme"]!["filter"]).toBeUndefined();

        const acme = availableProviders(home).find((provider) => provider.providerId === "acme")!;
        expect(acme.models.every((model) => model.enabled)).toBe(true);
    });

    it("0 字节 / 只有注释的 model.yaml 是**空配置**，不是坏配置（读与写都要能用）", () => {
        for (const content of ["", "# 还没写内容\n"]) {
            const home = makeHome({ model: content, snapshot: SNAPSHOT });
            // 读侧：目录空但不报错，全部 provider 都是「还没接」
            const providers = availableProviders(home);
            expect(providers.every((provider) => !provider.configured)).toBe(true);
            // 写侧：能往里写第一段
            saveAccount(home, { providerId: "acme", name: "main", value: "sk-first", kind: "std" });
            expect(
                availableProviders(home).find((provider) => provider.providerId === "acme")?.accounts,
            ).toHaveLength(1);
        }
    });

    it("saveAccount 带 kind 能给「还没接」的 provider 建段（界面的「连接」）", () => {
        const home = makeHome({ model: "", snapshot: SNAPSHOT });
        const saved = saveAccount(home, {
            providerId: "acme",
            name: "main",
            value: "sk-new-key",
            kind: "std",
        });
        expect(saved).toEqual({ providerId: "acme", name: "main", chars: 10 });
        const acme = availableProviders(home).find((provider) => provider.providerId === "acme")!;
        expect(acme.configured).toBe(true);
        expect(acme.accounts).toEqual([{ name: "main", configured: true, env: false, chars: 10 }]);
        // 不带 kind 的老语义不变：未知 provider 直接报错
        expect(() => saveAccount(home, { providerId: "nope", name: "x", value: "y" })).toThrow(/没有 provider/);
    });

    it("renameAccount 只改名字（key 原样留在文件里），removeAccount 连 key 一起删", () => {
        const home = makeHome({ model: MODEL, snapshot: SNAPSHOT });
        saveAccount(home, { providerId: "acme", name: "other", value: "sk-other-key" });

        renameAccount(home, "acme", "main", "primary");
        expect(readFileSync(join(home, "model.yaml"), "utf-8")).toContain("sk-SECRET-ACME-1234");
        const afterRename = availableProviders(home).find((p) => p.providerId === "acme");
        expect(afterRename?.accounts.map((account) => account.name)).toEqual(["primary", "other"]);

        // 重名要拒：两个同名账号之后再也定位不到是哪一个
        expect(() => renameAccount(home, "acme", "primary", "other")).toThrow(/已有账号/);

        removeAccount(home, "acme", "primary");
        const afterRemove = availableProviders(home).find((p) => p.providerId === "acme");
        expect(afterRemove?.accounts.map((account) => account.name)).toEqual(["other"]);
        expect(readFileSync(join(home, "model.yaml"), "utf-8")).not.toContain("sk-SECRET-ACME-1234");
        // 删不存在的账号要报错（静默成功的「删了但还留着」最难排）
        expect(() => removeAccount(home, "acme", "primary")).toThrow(/没有账号/);
    });

    it("删掉最后一个账号 = 这家整段摘掉，不留 `accounts: []`（否则它继续挂在已接入里却没 key）", () => {
        // 用一份**没有 filter** 的配置：那种配置删完账号就真的什么都不剩了
        const home = makeHome({
            model: `stdProviders:\n  acme:\n    accounts:\n      - type: apiKey\n        name: main\n        data:\n          value: sk-SECRET-ACME-1234\n`,
            snapshot: SNAPSHOT,
        });
        saveAccount(home, { providerId: "acme", name: "second", value: "sk-second-key" });
        removeAccount(home, "acme", "main");
        removeAccount(home, "acme", "second");

        const text = readFileSync(join(home, "model.yaml"), "utf-8");
        expect(text).not.toContain("accounts: []");
        const acme = availableProviders(home).find((provider) => provider.providerId === "acme");
        expect(acme?.configured).toBe(false);
        expect(acme?.accounts).toEqual([]);
    });

    it("只删了账号、还留着模型开关的那家要保住（用户先勾好模型再填 key 是合法状态）", () => {
        const home = makeHome({ model: MODEL, snapshot: SNAPSHOT });
        saveProvider(home, { providerId: "acme", filter: { include: null, exclude: ["small-1"] } });
        removeAccount(home, "acme", "main");

        const acme = availableProviders(home).find((provider) => provider.providerId === "acme");
        expect(acme?.configured).toBe(true);
        expect(acme?.accounts).toEqual([]);
        // 勾掉的仍然在表里（enabled: false）—— 换个 key 回来不用重新勾
        expect(acme?.models.filter((model) => !model.enabled).map((model) => model.id)).toEqual(["small-1"]);
    });
});
