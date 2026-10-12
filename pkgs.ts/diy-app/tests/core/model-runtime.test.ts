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
import { calendars } from "../../src/main/core/calendars";
import { refreshModelRuntime, resolveModelKey, toTierWhens } from "../../src/main/core/model-runtime";
import { ratesOf } from "../../src/shared/usage";

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

describe("toTierWhens（档触发条件的最后一道哨：models.dev 快照路径无 zod）", () => {
    /** 无时段表（快照路径的常态：上游不表达时段） */
    const NO_WINDOWS = {};
    it("context：顶层 size 与 data.size 都认（models.dev 原生 / diy 自相似两处）", () => {
        expect(toTierWhens({ type: "context", size: 272_000 }, "m", NO_WINDOWS)).toEqual([{ kind: "context", size: 272_000 }]);
        expect(toTierWhens({ type: "context", data: { size: 128_000 } }, "m", NO_WINDOWS)).toEqual([{ kind: "context", size: 128_000 }]);
    });
    it("context：size 非数字 / 缺失 / ≤0 → 丢档（放过就是「永远比不过」的死档，静默少收钱）", () => {
        for (const t of [
            { type: "context", data: { size: "272000" } },
            { type: "context", size: Number.NaN },
            { type: "context", size: Number.POSITIVE_INFINITY },
            { type: "context", size: 0 },
            { type: "context", size: -1 },
            { type: "context" },
        ]) expect(toTierWhens(t, "m", NO_WINDOWS)).toEqual([]);
    });
    it("utc-range：合法 → 归一成分钟 + 偏移（日历/标签可选）；缺偏移/偏移不一致 → 丢档", () => {
        expect(toTierWhens({ type: "utc-range", data: { start: "01:00:00+08:00", end: "04:00:00+08:00", calendar: "CN-business-day", label: "peak" } }, "m", NO_WINDOWS))
            .toEqual([{ kind: "utc-range", startMin: 60, endMin: 240, offsetMs: 8 * 3600_000, calendar: "CN-business-day", label: "peak" }]);
        expect(toTierWhens({ type: "utc-range", data: { start: "01:00", end: "04:00" } }, "m", NO_WINDOWS)).toEqual([]); // 无偏移 = 歧义
        expect(toTierWhens({ type: "utc-range", data: { start: "01:00:00+08:00", end: "04:00:00+09:00" } }, "m", NO_WINDOWS)).toEqual([]); // 两端不一致
    });
    it("utc-range + 具名时段表：一张表**多段 → 多条**窗（DeepSeek 峰就是两段）", () => {
        const windows = {
            "ds-peak": {
                label: "peak",
                calendar: "CN-mon-fri-ex-holiday",
                ranges: [
                    { start: "01:00:00Z", end: "04:00:00Z" },
                    { start: "06:00:00Z", end: "10:00:00Z" },
                ],
            },
        };
        expect(toTierWhens({ type: "utc-range", data: { window: "ds-peak" } }, "m", windows)).toEqual([
            { kind: "utc-range", startMin: 60, endMin: 240, offsetMs: 0, calendar: "CN-mon-fri-ex-holiday", label: "peak" },
            { kind: "utc-range", startMin: 360, endMin: 600, offsetMs: 0, calendar: "CN-mon-fri-ex-holiday", label: "peak" },
        ]);
    });
    it("utc-range + 具名时段表：表里没这个 id → 丢档（退 base 价，绝不静默按错档收）", () => {
        expect(toTierWhens({ type: "utc-range", data: { window: "nope" } }, "m", NO_WINDOWS)).toEqual([]);
    });
    it("utc-range + 具名时段表：坏段丢该段，好段照留（一张表坏一段不拖死其余）", () => {
        const windows = {
            mixed: {
                ranges: [
                    { start: "01:00", end: "04:00" }, // 无偏移 → 丢
                    { start: "06:00:00Z", end: "10:00:00Z" },
                ],
            },
        };
        expect(toTierWhens({ type: "utc-range", data: { window: "mixed" } }, "m", windows)).toEqual([
            { kind: "utc-range", startMin: 360, endMin: 600, offsetMs: 0 },
        ]);
    });
    it("未知 type / 缺 type → 丢档（上游加新档型时宁可不认，也不按错的价收）", () => {
        expect(toTierWhens({ type: "moon-phase" }, "m", NO_WINDOWS)).toEqual([]);
        expect(toTierWhens(undefined, "m", NO_WINDOWS)).toEqual([]);
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

    it("档引用**具名时段表** → 展开成多档（用真实 models.dev.diy.json，不造假数据）", () => {
        writeFileSync(
            join(home, "providers.custom.yaml"),
            `goat:
  id: goat
  npm: "@ai-sdk/openai-compatible"
  api: "https://x/v1"
  models:
    deepseek-v4.1-flash:
      limit: { context: 1000000, output: 384000 }
      cost:
        input: 0.15
        output: 0.6
        cache_read: 0.003
        baseLabel: off-peak
        tiers:
          - input: 0.3
            output: 1.2
            cache_read: 0.006
            tier: { type: utc-range, data: { window: deepseek-peak } }
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
        const m = findModel("0@custom:goat/deepseek-v4.1-flash")!;
        // 谷价（models.dev 收录的就是谷价）不动；峰档 = 表里两段各一条，价与标签由表带下来
        expect(m.cost).toEqual({
            input: 0.15,
            output: 0.6,
            cacheRead: 0.003,
            baseLabel: "off-peak",
            tiers: [
                { when: { kind: "utc-range", startMin: 60, endMin: 240, offsetMs: 0, calendar: "CN-mon-fri-ex-holiday", label: "peak" }, input: 0.3, output: 1.2, cacheRead: 0.006 },
                { when: { kind: "utc-range", startMin: 360, endMin: 600, offsetMs: 0, calendar: "CN-mon-fri-ex-holiday", label: "peak" }, input: 0.3, output: 1.2, cacheRead: 0.006 },
            ],
        });
        // 实际计费：2026-10-14（周三）02:00Z 落**峰段①**（01:00–04:00Z）→ 峰价；
        // 13:00Z 落谷 → models.dev 收录的 base 价（谷价）+ off-peak 标签
        const rates = (ms: number) => ratesOf(m.cost, 1000, ms, calendars())!;
        expect(rates(Date.UTC(2026, 9, 14, 2))).toMatchObject({ window: "peak", input: 0.3, output: 1.2 });
        expect(rates(Date.UTC(2026, 9, 14, 13))).toMatchObject({ window: "off-peak", input: 0.15 });
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

    it("cost 只填一半（缺 output）→ 无价（不按 0 静默低估）", () => {
        // UI 允许 in/out 分开填（编辑中途），runtime 只认两者齐全的价：半填 = cost 缺失，
        // 金额显示 n/a，绝不把缺失的 output 当 0 计（##281）。
        writeFileSync(
            join(home, "providers.custom.yaml"),
            `goat:
  id: goat
  npm: "@ai-sdk/openai-compatible"
  api: "https://x/v1"
  models:
    a/b:
      limit: { context: 1000, output: 100 }
      cost: { input: 1 }
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
        expect(m.cost).toBeUndefined();
    });

    it("custom spec 的**时段档**（utc-range）→ 运行时 TierWhen；baseLabel 带过", () => {
        writeFileSync(
            join(home, "providers.custom.yaml"),
            `goat:
  id: goat
  npm: "@ai-sdk/openai-compatible"
  api: "https://x/v1"
  models:
    a/b:
      limit: { context: 1000, output: 100 }
      cost:
        input: 0.15
        output: 0.6
        baseLabel: off-peak
        tiers:
          - input: 0.5
            output: 3
            cache_read: 0.1
            tier: { type: utc-range, data: { start: "01:00:00+08:00", end: "04:00:00+08:00", calendar: CN-business-day, label: peak } }
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
        const c = findModel("0@custom:goat/a/b")!.cost!;
        expect(c.baseLabel).toBe("off-peak");
        expect(c.tiers).toEqual([
            {
                when: { kind: "utc-range", startMin: 60, endMin: 240, offsetMs: 8 * 3600_000, calendar: "CN-business-day", label: "peak" },
                input: 0.5,
                output: 3,
                cacheRead: 0.1,
                cacheWrite: undefined,
            },
        ]);
    });

    it("custom YAML 里 context 档 `data.size` 非数字 → **写侧 zod 即拒**（整份配置报错，不静默吞）", () => {
        writeFileSync(
            join(home, "providers.custom.yaml"),
            `goat:
  id: goat
  npm: "@ai-sdk/openai-compatible"
  api: "https://x/v1"
  models:
    a/b:
      limit: { context: 1000, output: 100 }
      cost:
        input: 0.15
        output: 0.6
        tiers:
          - input: 9
            output: 9
            tier: { type: context, data: { size: "272000" } }
`,
        );
        writeFileSync(
            join(home, "model.yaml"),
            `customProviders:
  goat:
    accounts: [{ type: apiKey, data: { value: "k" } }]
`,
        );
        expect(() => refreshModelRuntime(home)).toThrow(/size/);
    });

    it("时段档 start/end **缺偏移** → **读配置即 fail-fast**（不默认本地时区，歧义不接受）", () => {
        writeFileSync(
            join(home, "providers.custom.yaml"),
            `goat:
  id: goat
  npm: "@ai-sdk/openai-compatible"
  api: "https://x/v1"
  models:
    a/b:
      limit: { context: 1000, output: 100 }
      cost:
        input: 1
        output: 2
        tiers:
          - input: 5
            output: 5
            tier: { type: utc-range, data: { start: "01:00", end: "04:00" } }
`,
        );
        writeFileSync(
            join(home, "model.yaml"),
            `customProviders:
  goat:
    accounts: [{ type: apiKey, data: { value: "k" } }]
`,
        );
        expect(() => refreshModelRuntime(home)).toThrow(/ISO 8601/);
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
