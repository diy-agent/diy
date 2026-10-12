// tests/core/llm-cost.test.ts
// 🎯 价目登记的服务端实现（src/main/core/llm-cost.ts）—— CLI `llmConfig costs/setCost/setTiers` 的落地层。
//
// 需求定义（本文件即契约）：
//   1. 落点判定：custom → providers.custom.yaml 的 spec；std → model.yaml 的**覆盖**（裸 id 先认 snapshot）
//   2. **覆盖不是补丁**：首次写覆盖以 spec 价为基线（否则「只填 output」会静默丢掉 models.dev 的缓存价）
//   3. 合并语义 + 清字段 + 删整块；空 cost / 空覆盖条目不落噪声
//   4. 时段档：replace 只动 utc-range（context 档原位保留）· append · drop（0-based）· clear
//   5. 回执：`cost`（该落点）与 `effective`（override > spec）分开 + 预警
//   6. 误用要**出声**：std 用 --target spec / 未配置 provider 写 override / 模型不在 spec / 三模式冲突 / 越界
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { providerCosts, setModelCost, setModelTiers } from "../../src/main/core/llm-cost";
import { loadCustomSpecs, loadModelConfig } from "../../src/main/core/model-config";

/** 独立 HOME：每个用例自建，互不影响（绝不碰 setup.ts 的共享临时根） */
function tmpHome(): string {
    return mkdtempSync(join(tmpdir(), "diy-llm-cost-"));
}

/** 写一个 custom provider（spec 层）+ 一份 model.yaml（std 的 opencode-go 已配置） */
function seedHome(opts: { withGoatConfig?: boolean } = {}): string {
    const home = tmpHome();
    writeFileSync(
        join(home, "providers.custom.yaml"),
        yaml.dump({
            goat: {
                id: "goat",
                npm: "@ai-sdk/openai-compatible",
                api: "https://api.commandcode.ai/provider/v1",
                models: {
                    "gpt-6-astra": { id: "gpt-6-astra", name: "GPT-6 Astra", limit: { context: 1050000 } },
                    "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5", limit: { context: 400000 } },
                },
            },
        }),
    );
    writeFileSync(
        join(home, "model.yaml"),
        yaml.dump({
            stdProviders: { "opencode-go": { accounts: [{ type: "apiKey", data: { value: "sk-x" } }] } },
            ...(opts.withGoatConfig ? { customProviders: { goat: { accounts: [{ type: "apiKey", data: { value: "sk-y" } }] } } } : {}),
        }),
    );
    return home;
}

describe("providerCosts（发现入口）", () => {
    it("custom provider 未配置在 model.yaml 也列出 model id（否则 agent 无从填价）", () => {
        const home = seedHome();
        const v = providerCosts(home, "custom:goat");
        expect(v.provider).toBe("custom:goat");
        expect(v.kind).toBe("custom");
        expect(v.configured).toBe(false);
        expect(v.target).toBe("spec");
        expect(v.models.map((m) => m.id).sort()).toEqual(["gpt-5.5", "gpt-6-astra"]);
        expect(v.models.every((m) => m.cost === null && m.costSource === "none")).toBe(true);
        // 未配置 → override 落不了（无账号），只有 spec 可写
        expect(v.models.every((m) => m.writable.join() === "spec")).toBe(true);
    });

    it("裸 id 先认 snapshot（opencode-go = std）；配置过的 provider 两个落点都可写", () => {
        const home = seedHome({ withGoatConfig: true });
        const std = providerCosts(home, "opencode-go");
        expect(std.kind).toBe("std");
        expect(std.target).toBe("override");
        const flash = std.models.find((m) => m.id === "deepseek-v4.1-flash");
        expect(flash?.costSource).toBe("spec"); // models.dev 有价
        expect(flash?.cost?.input).toBe(0.15);
        expect(flash?.writable).toEqual(["override"]);

        const goat = providerCosts(home, "custom:goat");
        expect(goat.configured).toBe(true);
        expect(goat.models[0]?.writable).toEqual(["spec", "override"]);
    });

    it("日历清单随行下发（时段档的 calendar 取值真源）", () => {
        const v = providerCosts(seedHome(), "custom:goat");
        expect(v.calendars.map((c) => c.id)).toContain("CN-business-day");
    });
});

describe("setCost — custom spec 落点", () => {
    it("填价落 providers.custom.yaml，回执给落点/生效价/文件", () => {
        const home = seedHome();
        const r = setModelCost(home, {
            provider: "custom:goat",
            model: "gpt-5.5",
            target: "auto",
            input: 0.15,
            output: 0.6,
            cacheRead: 0.003,
            baseLabel: "off-peak",
        });
        expect(r.target).toBe("spec");
        expect(r.file).toBe(join(home, "providers.custom.yaml"));
        expect(r.cost).toEqual({ input: 0.15, output: 0.6, cache_read: 0.003, baseLabel: "off-peak" });
        expect(r.effective).toEqual(r.cost);
        expect(r.seededFromSpec).toBe(false);
        expect(r.warnings).toEqual([]);
        // 落盘可被写侧 zod 读回
        expect(loadCustomSpecs(home)["goat"]?.models?.["gpt-5.5"]?.cost?.input).toBe(0.15);
    });

    it("合并语义：只改给的字段，其余保持", () => {
        const home = seedHome();
        setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", input: 1, output: 2, cacheRead: 0.1 });
        const r = setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", output: 3 });
        expect(r.cost).toEqual({ input: 1, output: 3, cache_read: 0.1 });
    });

    it("--clear-fields 清字段；全清后整个 cost 块删除（不留 cost: {}）", () => {
        const home = seedHome();
        setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", input: 1, output: 2, baseLabel: "x" });
        let r = setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", clearFields: ["cache_read"] });
        expect(r.cost).toEqual({ input: 1, output: 2, baseLabel: "x" });
        r = setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", clearFields: ["input", "output", "baseLabel"] });
        expect(r.cost).toBeNull();
        expect(r.effective).toBeNull();
        expect(loadCustomSpecs(home)["goat"]?.models?.["gpt-5.5"]?.cost).toBeUndefined();
    });

    it("--clear 删整块（含时段档）", () => {
        const home = seedHome();
        setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", input: 1, output: 2 });
        setModelTiers(home, {
            provider: "custom:goat", model: "gpt-5.5", target: "auto",
            tiers: [{ input: 5, output: 6, tier: { type: "utc-range", data: { start: "01:00:00+08:00", end: "04:00:00+08:00", calendar: "CN-business-day", label: "peak" } } }],
        });
        const r = setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", clear: true });
        expect(r.cost).toBeNull();
        expect(r.tierCount).toBe(0);
        expect(loadCustomSpecs(home)["goat"]?.models?.["gpt-5.5"]?.cost).toBeUndefined();
    });

    it("没给任何字段 → 拒绝（不静默成功）", () => {
        const home = seedHome();
        expect(() => setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto" })).toThrow(/没有要改的字段/);
    });
});

describe("setCost — std 覆盖落点", () => {
    it("首次写覆盖以 spec 价为基线（只填 input 不丢 models.dev 的输出/缓存价）", () => {
        const home = seedHome();
        const r = setModelCost(home, { provider: "opencode-go", model: "deepseek-v4.1-flash", target: "auto", input: 0.9 });
        expect(r.target).toBe("override");
        expect(r.file).toBe(join(home, "model.yaml"));
        expect(r.seededFromSpec).toBe(true);
        expect(r.cost?.input).toBe(0.9);
        expect(r.cost?.output).toBe(0.6); // ← models.dev 的输出价被保住
        expect(r.cost?.cache_read).toBe(0.003);
        const cfg = loadModelConfig(home);
        expect(cfg.stdProviders["opencode-go"]?.models?.["deepseek-v4.1-flash"]?.cost?.input).toBe(0.9);
    });

    it("--clear 后回退 spec 价（effective 看得到回退，cost 为 null）", () => {
        const home = seedHome();
        setModelCost(home, { provider: "opencode-go", model: "deepseek-v4.1-flash", target: "auto", input: 0.9 });
        const r = setModelCost(home, { provider: "opencode-go", model: "deepseek-v4.1-flash", target: "auto", clear: true });
        expect(r.cost).toBeNull();
        expect(r.effective?.input).toBe(0.15);
        expect(loadModelConfig(home).stdProviders["opencode-go"]?.models).toBeUndefined();
    });

    it("override 存在时写 spec：effective 仍报 override 价（回执不许说谎 —— 生效的是覆盖）", () => {
        const home = seedHome({ withGoatConfig: true }); // 两个落点都可写
        setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "override", input: 9 });
        const r = setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "spec", input: 1, output: 2 });
        expect(r.target).toBe("spec");
        expect(r.cost?.input).toBe(1); // 该落点写进去了
        expect(r.effective?.input).toBe(9); // 但生效的仍是 override（override > spec）
    });

    it("std 用 --target spec → 出声拒绝（models.dev 的价在 snapshot 里，改不了 spec）", () => {
        const home = seedHome();
        expect(() => setModelCost(home, { provider: "opencode-go", model: "deepseek-v4.1-flash", target: "spec", input: 1 })).toThrow(/--target override/);
    });
});

describe("setCost — 误用与边界", () => {
    it("override 落点要求 provider 已在 model.yaml（无账号无从落）", () => {
        const home = seedHome(); // goat 未配置
        expect(() => setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "override", input: 1 })).toThrow(/override 要有账号/);
    });

    it("模型不在 spec 里 → 报错并给出可用 id（该走 override）", () => {
        const home = seedHome();
        expect(() => setModelCost(home, { provider: "custom:goat", model: "nope", target: "auto", input: 1 })).toThrow(/gpt-5\.5/);
    });

    it("不存在的 provider → 报错", () => {
        const home = seedHome();
        expect(() => setModelCost(home, { provider: "custom:nope", model: "x", target: "auto", input: 1 })).toThrow(/不在 models.dev 收录里/);
    });
});

describe("setTiers", () => {
    const peak = {
        input: 0.5,
        output: 3,
        cache_read: 0.1,
        tier: { type: "utc-range", data: { start: "01:00:00+08:00", end: "04:00:00+08:00", calendar: "CN-business-day", label: "peak" } },
    } as const;
    const ctx = { input: 1, output: 6, tier: { type: "context", data: { size: 128000 } } } as const;

    it("replace 只动 utc-range：**context 档原位保留**（写在它前面的还在前面）", () => {
        const home = seedHome();
        setModelTiers(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", tiers: [ctx, peak] });
        const again = { ...peak, output: 9, tier: { type: "utc-range", data: { start: "05:00:00+08:00", end: "06:00:00+08:00", label: "peak2" } } } as const;
        const r = setModelTiers(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", tiers: [again] });
        expect(r.tierCount).toBe(1);
        const tiers = loadCustomSpecs(home)["goat"]?.models?.["gpt-5.5"]?.cost?.tiers ?? [];
        expect(tiers.map((t) => t.tier?.type)).toEqual(["context", "utc-range"]);
        expect(tiers[0]).toMatchObject({ input: 1, output: 6 });
        expect(tiers[1]).toMatchObject({ output: 9 });
    });

    it("append 追加（顺序即优先级）；drop 按 utc-range 编号删；clear 只删时段档", () => {
        const home = seedHome();
        setModelTiers(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", tiers: [ctx] });
        setModelTiers(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", tiers: [peak], append: true });
        expect(loadCustomSpecs(home)["goat"]?.models?.["gpt-5.5"]?.cost?.tiers?.map((t) => t.tier?.type)).toEqual(["context", "utc-range"]);

        const dropped = setModelTiers(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", drop: 0 });
        expect(dropped.tierCount).toBe(0);
        expect(loadCustomSpecs(home)["goat"]?.models?.["gpt-5.5"]?.cost?.tiers?.map((t) => t.tier?.type)).toEqual(["context"]);

        setModelTiers(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", tiers: [peak], append: true });
        const cleared = setModelTiers(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", clear: true });
        expect(cleared.tierCount).toBe(0);
        expect(loadCustomSpecs(home)["goat"]?.models?.["gpt-5.5"]?.cost?.tiers?.map((t) => t.tier?.type)).toEqual(["context"]);
    });

    it("三种模式必须给一个：都不给 / 给两个 → 报错", () => {
        const home = seedHome();
        expect(() => setModelTiers(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto" })).toThrow(/三种模式只能给一个/);
        expect(() => setModelTiers(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", tiers: [peak], clear: true })).toThrow(/三种模式只能给一个/);
    });

    it("drop 越界 → 报错（列出实际条数）", () => {
        const home = seedHome();
        expect(() => setModelTiers(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", drop: 0 })).toThrow(/只有 0 条时段档/);
    });
});

describe("回执的 warnings（价会在哪类请求上算不出 / 算错）", () => {
    it("只填了 output（缺 base 的 in）→ 预警；引用了不存在的日历 → 预警（但不阻断保存）", () => {
        const home = seedHome();
        const r = setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", output: 2 });
        expect(r.warnings.join()).toMatch(/base 档缺完整价/);
        const r2 = setModelTiers(home, {
            provider: "custom:goat", model: "gpt-5.5", target: "auto",
            tiers: [{ input: 1, output: 2, tier: { type: "utc-range", data: { start: "01:00:00+08:00", end: "04:00:00+08:00", calendar: "Mars-business-day" } } }],
        });
        expect(r2.warnings.join()).toMatch(/引用日历 Mars-business-day 不存在/);
        expect(r2.tierCount).toBe(1); // 保存仍成功（该窗永不命中，退 base 价）
    });

    it("无价目 → 明说金额为 null（不是 0）", () => {
        const home = seedHome();
        const r = setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", input: 1, output: 2 });
        expect(r.warnings).toEqual([]);
        const cleared = setModelCost(home, { provider: "custom:goat", model: "gpt-5.5", target: "auto", clear: true });
        expect(cleared.warnings.join()).toMatch(/金额为 null/);
    });
});
