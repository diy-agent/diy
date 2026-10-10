// tests/core/model-runtime.test.ts
// 🎯 provider 配置 → 运行时模型目录的装配契约（##184）。
// 覆盖：完全限定名切分、custom provider 接入、API 面（chat/responses）、$VAR 展开 fail-fast、
// 可见性 filter。真实 snapshot（models.dev 产物）参与装配 —— 不做假数据。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitQualified } from "../../src/shared/model-config";
import { effectiveMaxOutputTokens, findModel, getModelCatalog, maxOutputTokensOf } from "../../src/shared/models";
import { refreshModelRuntime, resolveModelKey } from "../../src/main/core/model-runtime";

describe("splitQualified：account@provider/model", () => {
    it("模型 id 自带 / → 按第一个 / 切（provider 段不受影响）", () => {
        expect(splitQualified("0@custom:goat/xiaomi/mimo-v2.6-flash")).toEqual({
            account: "0",
            provider: "custom:goat",
            model: "xiaomi/mimo-v2.6-flash",
        });
    });
    it("account 名带点/下划线（最后一个 @ 切）", () => {
        expect(splitQualified("work_a-1@opencode-go/deepseek-v4.1-flash")).toEqual({
            account: "work_a-1",
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
        });
    });
    it("缺 / 或缺 @ → null（调用方报错，不猜）", () => {
        expect(splitQualified("mimo-v2.6-flash")).toBeNull();
        expect(splitQualified("opencode-go/mimo-v2.6-flash")).toBeNull();
    });
});

describe("refreshModelRuntime（装配 snapshot ⊕ custom ⊕ model.yaml）", () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "diy-model-rt-"));
    });
    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    it("无配置 → 空目录（**没有内置 provider**）", () => {
        const n = refreshModelRuntime(home);
        expect(n).toBe(0);
        expect(getModelCatalog()).toEqual([]);
        expect(findModel("mimo-v2.6-flash")).toBeUndefined();
        expect(findModel("0@opencode-go/mimo-v2.6-flash")).toBeUndefined();
    });

    it("custom provider（goat）+ $VAR 展开 + 模型 id 自带 /", () => {
        writeFileSync(
            join(home, "providers.custom.yaml"),
            `goat:
  id: goat
  name: CommandCode Goat
  npm: "@ai-sdk/openai-compatible"
  api: "https://api.commandcode.ai/provider/v1"
  env: [GOAT_KEY]
  models:
    xiaomi/mimo-v2.6-flash:
      name: MiMo V2.6 Flash
      limit: { context: 200000, output: 32768 }
      reasoning: true
`,
        );
        writeFileSync(
            join(home, "model.yaml"),
            `customProviders:
  goat:
    accounts:
      - type: apiKey
        name: work
        data: { value: "$GOAT_TEST_KEY" }
    filter: { include: [], exclude: [] }
`,
        );
        process.env["GOAT_TEST_KEY"] = "sk-goat-xyz";
        const n = refreshModelRuntime(home);
        expect(n).toBe(1);
        const m = findModel("work@custom:goat/xiaomi/mimo-v2.6-flash");
        expect(m).toBeTruthy();
        expect(m!.api).toBe("chat");
        expect(m!.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
        expect(m!.contextLimit).toBe(200000);
        expect(resolveModelKey(m!)).toBe("sk-goat-xyz");
        delete process.env["GOAT_TEST_KEY"];
    });

    it("spec/override 的 cost（snake）→ ModelCost（camel），缓存价不丢", () => {
        writeFileSync(
            join(home, "providers.custom.yaml"),
            `goat:
  id: goat
  npm: "@ai-sdk/openai-compatible"
  api: "https://x/v1"
  models:
    a/b:
      limit: { context: 1000, output: 100 }
      cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.5 }
`,
        );
        writeFileSync(
            join(home, "model.yaml"),
            `customProviders:
  goat:
    accounts: [{ type: apiKey, data: { value: "k" } }]
`,
        );
        refreshModelRuntime(home);
        const m = findModel("0@custom:goat/a/b")!;
        expect(m.cost).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 });
    });

    it("std provider（opencode-go）+ filter exclude 生效", () => {
        writeFileSync(
            join(home, "model.yaml"),
            `stdProviders:
  opencode-go:
    accounts:
      - type: apiKey
        data: { value: "plain-key" }
    filter:
      include: []
      exclude: [mimo-v2.6-pro]
`,
        );
        process.env["OPENCODE_API_KEY"] = "plain"; // 内置账号不读它，仅为不 fail
        refreshModelRuntime(home);
        expect(findModel("0@opencode-go/mimo-v2.6-pro")).toBeUndefined();
        expect(findModel("0@opencode-go/gpt-5.6-luna")?.api).toBe("responses");
        delete process.env["OPENCODE_API_KEY"];
    });

    it("spec 未给 limit（如 commandcode /models 无输出上限）→ undefined 而非 0", () => {
        // 回归 ##184「goat mimo 报 maxOutputTokens must be >= 1」：
        // 旧实现 m.output ?? 0 把缺失输出上限写成 0，SDK 直接拒。缺失必须留 undefined。
        writeFileSync(
            join(home, "providers.custom.yaml"),
            `goat:
  id: goat
  npm: "@ai-sdk/openai-compatible"
  api: "https://api.commandcode.ai/provider/v1"
  models:
    xiaomi/mimo-v2.6-flash:
      name: MiMo V2.6 Flash
`,
        );
        writeFileSync(
            join(home, "model.yaml"),
            `customProviders:
  goat:
    accounts: [{ type: apiKey, data: { value: "k" } }]
`,
        );
        refreshModelRuntime(home);
        const m = findModel("0@custom:goat/xiaomi/mimo-v2.6-flash")!;
        expect(m.maxOutputTokens).toBeUndefined();
        expect(m.contextLimit).toBeUndefined();
        expect(maxOutputTokensOf("0@custom:goat/xiaomi/mimo-v2.6-flash")).toBeUndefined();
        // 生效值必须 >= 1（SDK 硬约束），缺省走 fallback
        expect(effectiveMaxOutputTokens("0@custom:goat/xiaomi/mimo-v2.6-flash", 4000)).toBe(4000);
    });

    it("$VAR 未定义 → resolveModelKey fail-fast", () => {
        writeFileSync(
            join(home, "providers.custom.yaml"),
            `goat:
  id: goat
  npm: "@ai-sdk/openai-compatible"
  api: "https://api.commandcode.ai/provider/v1"
  models:
    xiaomi/mimo-v2.6-flash: { name: MiMo }
`,
        );
        writeFileSync(
            join(home, "model.yaml"),
            `customProviders:
  goat:
    accounts:
      - type: apiKey
        data: { value: "$THIS_VAR_DOES_NOT_EXIST" }
`,
        );
        refreshModelRuntime(home);
        const m = findModel("0@custom:goat/xiaomi/mimo-v2.6-flash");
        expect(m).toBeTruthy();
        expect(() => resolveModelKey(m!)).toThrow(/\$THIS_VAR_DOES_NOT_EXIST/);
    });
});
