import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogError, listAccounts, loadCatalog, readAccountValue } from "../src/index.js";
import type { ModelCatalogEntry } from "../src/index.js";

/** 造一个临时 home：model.yaml / providers.custom.yaml / data/models.dev.json 按需写 */
function makeHome(files: {
    model?: string;
    custom?: string;
    snapshot?: unknown;
}): string {
    const home = mkdtempSync(join(tmpdir(), "model-catalog-"));
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
        models: {
            "small-1": { name: "Small 1", limit: { context: 128000 }, cost: { input: 0.1, output: 0.4 } },
            "big-1": { name: "Big 1", limit: { context: 1000000 }, cost: { input: 2, output: 8 } },
        },
    },
};

const MODEL_YAML = `stdProviders:
  acme:
    accounts:
      - type: apiKey
        name: main
        data:
          value: sk-SECRET-ACME
    filter:
      include: [small-1]
`;

describe("loadCatalog", () => {
    it("std provider：快照给 spec，目录四条字段齐全且**不含 key 值**", () => {
        const home = makeHome({ model: MODEL_YAML, snapshot: SNAPSHOT });
        const entries = loadCatalog(home, { snapshotPath: join(home, "data", "models.dev.json") });
        expect(entries).toHaveLength(1); // filter.include 只放 small-1
        expect(entries[0]).toEqual({
            providerId: "acme",
            modelId: "small-1",
            name: "Small 1",
            baseURL: "https://acme.example/v1",
            npm: "@ai-sdk/openai-compatible",
            contextWindow: 128000,
            cost: { input: 0.1, output: 0.4 },
        });
        // 硬边界：目录里没有任何账号 / key 字段
        expect(JSON.stringify(entries)).not.toContain("SECRET");
        expect(entries[0]).not.toHaveProperty("accounts");
    });

    it("custom provider：spec 来自 providers.custom.yaml（无需快照）", () => {
        const home = makeHome({
            model: `customProviders:
  goat:
    accounts:
      - type: apiKey
        name: chen56
        data:
          value: $GOAT_KEY
`,
            custom: `goat:
  id: goat
  npm: "@ai-sdk/openai-compatible"
  api: https://api.goat.example/v1
  models:
    gpt-x:
      name: GPT X
      limit:
        context: 200000
`,
        });
        const entries = loadCatalog(home);
        expect(entries.map((entry) => [entry.providerId, entry.modelId, entry.name, entry.baseURL])).toEqual([
            ["goat", "gpt-x", "GPT X", "https://api.goat.example/v1"],
        ]);
        expect(entries[0]?.contextWindow).toBe(200000);
    });

    it("model.yaml 的 models 覆盖 name / limit / cost（含新增模型）", () => {
        const home = makeHome({
            model: `stdProviders:
  acme:
    accounts:
      - type: apiKey
        data:
          value: x
    models:
      big-1:
        name: 大的一号
        limit:
          context: 2000000
        cost:
          input: 1
          output: 3
      extra-1:
        name: 额外模型
`,
            snapshot: SNAPSHOT,
        });
        const entries = loadCatalog(home);
        const big = entries.find((entry) => entry.modelId === "big-1") as ModelCatalogEntry;
        expect(big.name).toBe("大的一号");
        expect(big.contextWindow).toBe(2000000);
        expect(big.cost).toEqual({ input: 1, output: 3 });
        const extra = entries.find((entry) => entry.modelId === "extra-1") as ModelCatalogEntry;
        expect([extra.name, extra.baseURL, extra.contextWindow]).toEqual(["额外模型", "https://acme.example/v1", undefined]);
    });

    it("filter.exclude 优先于 include；两者都空 = 全开", () => {
        const home = makeHome({
            model: `stdProviders:
  acme:
    accounts:
      - type: apiKey
        data:
          value: x
    filter:
      exclude: [big-1]
`,
            snapshot: SNAPSHOT,
        });
        expect(loadCatalog(home).map((entry) => entry.modelId)).toEqual(["small-1"]);
    });

    it("没有 spec 的 provider 不进目录（配置里只有账号、模型无法列出）", () => {
        const home = makeHome({
            model: `stdProviders:
  ghost:
    accounts:
      - type: apiKey
        data:
          value: x
`,
        });
        expect(loadCatalog(home).filter((entry) => entry.providerId === "ghost")).toEqual([]);
    });

    it("model.yaml 不存在 ⇒ 空目录（不炸）", () => {
        expect(loadCatalog(makeHome({}))).toEqual([]);
    });
});

describe("listAccounts", () => {
    it("只给账号名（含缺省序号名），不含任何 key 值", () => {
        const home = makeHome({
            model: `stdProviders:
  acme:
    accounts:
      - type: apiKey
        name: main
        data:
          value: sk-SECRET-ACME
      - type: apiKey
        data:
          value: sk-SECRET-SECOND
customProviders:
  goat:
    accounts:
      - type: apiKey
        name: mine
        data:
          value: $GOAT_KEY
`,
        });
        const accounts = listAccounts(home);
        expect(accounts).toEqual([
            { providerId: "acme", kind: "std", names: ["main", "1"] },
            { providerId: "goat", kind: "custom", names: ["mine"] },
        ]);
        expect(JSON.stringify(accounts)).not.toContain("SECRET");
        expect(JSON.stringify(accounts)).not.toContain("GOAT_KEY");
    });
});

describe("readAccountValue", () => {
    const home = makeHome({
        model: `stdProviders:
  acme:
    accounts:
      - type: apiKey
        name: main
        data:
          value: sk-literal
      - type: apiKey
        name: env
        data:
          value: $ACME_KEY
      - type: apiKey
        name: empty
        data:
          value: ""
`,
    });

    it("字面量原样返回", () => {
        expect(readAccountValue(home, "acme", "main")).toBe("sk-literal");
    });

    it("$VAR 按注入环境展开", () => {
        expect(readAccountValue(home, "acme", "env", { env: { ACME_KEY: "sk-from-env" } })).toBe("sk-from-env");
    });

    it("未定义的环境变量 ⇒ account-unresolved", () => {
        try {
            readAccountValue(home, "acme", "env", { env: {} });
            throw new Error("应当抛错");
        } catch (cause) {
            expect(cause).toBeInstanceOf(CatalogError);
            expect((cause as CatalogError).code).toBe("catalog/account-unresolved");
        }
    });

    it("空 key ⇒ account-empty；未知 provider / 账号各有机器码", () => {
        expect(() => readAccountValue(home, "acme", "empty")).toThrow(/没有填 key/);
        expect(() => readAccountValue(home, "nope")).toThrow(/没有 provider/);
        expect(() => readAccountValue(home, "acme", "nobody")).toThrow(/没有账号/);
    });

    it("不指定账号 ⇒ 取第一个展开后非空的", () => {
        expect(readAccountValue(home, "acme", undefined, { env: { ACME_KEY: "sk-x" } })).toBe("sk-literal");
    });
});
