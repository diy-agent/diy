// tests/cli.intent.llm-cost.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 llmConfig 价目登记 CLI 意图测试 —— agent 用命令行给模型登记单价（含峰谷时段价）
//
// 需求定义（本文件即契约；单测 tests/core/llm-cost.test.ts 覆盖变换逻辑，这里覆盖**真链路**）：
//   1. costs：先能发现（model id / 现价 / 可写落点 / 日历），否则 agent 无从填
//   2. setCost：custom → providers.custom.yaml 的 spec；std → model.yaml 的覆盖（首个用例验 seed）
//   3. setTiers：utc-range 峰谷档（含日历），--drop / --clear / 三选一
//   4. **写后即生效**：`agent local models` 的单价跟着变（refreshModelRuntime 被调到）
//   5. 误用出声：未知模型 / 模式冲突 → 非零退出 + 中文原因（不静默成功）
//
// 隔离：Electron 用一次性 HOME（electron-test），本文件另写 providers.custom.yaml 造一个
// custom provider 当靶子；不碰用户 ~/.diy。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

interface ElectronFixture {
  sh: ShellTest;
  HOME: string;
  electron: ElectronTest;
}

let fx: ElectronFixture;

/**
 * 两个靶子 custom provider（都在 providers.custom.yaml 的 spec 层）：
 *   · goat —— **未配在 model.yaml**（只有 spec 可写；也不会出现在运行时目录里）
 *   · paca —— **已配在 model.yaml**（有账号 → 运行时目录有它，用来验「写后即生效」）
 * 前者对应"刚从 /models 拉回来、还没接账号"的状态；后者对应用户真实配置。
 */
const CUSTOM_SPECS = {
  goat: {
    id: "goat",
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.commandcode.ai/provider/v1",
    models: {
      "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5", limit: { context: 400000 } },
      "gpt-6-astra": { id: "gpt-6-astra", name: "GPT-6 Astra", limit: { context: 1050000 } },
    },
  },
  paca: {
    id: "paca",
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.paca.example/v1",
    models: { "llama-x": { id: "llama-x", name: "Llama X", limit: { context: 131072 } } },
  },
};

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  writeFileSync(join(HOME, "providers.custom.yaml"), yaml.dump(CUSTOM_SPECS));
  // electron-test 已写好 stdProviders.opencode-go；这里补一个**已接账号**的 custom provider
  const cfg = yaml.load(readFileSync(join(HOME, "model.yaml"), "utf-8")) as Record<string, unknown>;
  cfg["customProviders"] = { paca: { accounts: [{ type: "apiKey", data: { value: "sk-paca" } }] } };
  writeFileSync(join(HOME, "model.yaml"), yaml.dump(cfg));
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
});

afterAll(async () => {
  await fx?.electron?.stop();
});

/** spec 落盘内容（直读文件：断言"真写下去了"，而不是只看回执） */
function goatCost(model: string, provider = "goat"): Record<string, unknown> | undefined {
  const file = yaml.load(readFileSync(join(fx.HOME, "providers.custom.yaml"), "utf-8")) as Record<
    string,
    { models?: Record<string, { cost?: Record<string, unknown> }> }
  >;
  return file[provider]?.models?.[model]?.cost;
}

describe("llmConfig costs（发现入口）", () => {
  it("custom provider 未配在 model.yaml 也列出 model id + 可写落点 + 日历", async () => {
    const r = await fx.sh.getJson("./diy.sh llmConfig costs custom:goat");
    const d = r.data as {
      provider: string;
      kind: string;
      configured: boolean;
      target: string;
      calendars: { id: string; label: string }[];
      models: { id: string; cost: unknown; costSource: string; writable: string[] }[];
    };
    expect(d.provider).toBe("custom:goat");
    expect(d.kind).toBe("custom");
    expect(d.configured).toBe(false);
    expect(d.target).toBe("spec");
    expect(d.models.map((m) => m.id).sort()).toEqual(["gpt-5.5", "gpt-6-astra"]);
    expect(d.models.every((m) => m.cost === null && m.costSource === "none")).toBe(true);
    expect(d.models[0]!.writable).toEqual(["spec"]);
    expect(d.calendars.map((c) => c.id)).toContain("CN-business-day");
  });
});

describe("llmConfig setCost", () => {
  it("custom spec → 落 providers.custom.yaml；写了就**进运行时目录**（refreshModelRuntime 被调到）", async () => {
    const r = await fx.sh.getJson(
      "./diy.sh llmConfig setCost custom:paca llama-x --input 0.15 --output 0.6 --cache-read 0.003 --base-label off-peak",
    );
    const d = r.data as { target: string; file: string; cost: Record<string, unknown>; warnings: string[]; seededFromSpec: boolean };
    expect(d.target).toBe("spec");
    expect(d.file).toBe(join(fx.HOME, "providers.custom.yaml"));
    expect(d.cost).toEqual({ input: 0.15, output: 0.6, cache_read: 0.003, baseLabel: "off-peak" });
    expect(d.warnings).toEqual([]);
    expect(d.seededFromSpec).toBe(false);
    // 落盘（直读真文件）
    expect(goatCost("llama-x", "paca")).toMatchObject({ input: 0.15, output: 0.6, cache_read: 0.003, baseLabel: "off-peak" });

    // 生效：运行时目录（agent local models）里的 cost 就是 usage 计价读的那个对象（camelCase 口径）
    const models = (await fx.sh.getJson("./diy.sh agent local models")).data as {
      ref: string;
      cost: { input: number; output: number; cacheRead?: number } | null;
    }[];
    const m = models.find((x) => x.ref.endsWith("@custom:paca/llama-x"));
    expect(m, `运行时目录里没有 custom:paca/llama-x（现有: ${models.map((x) => x.ref).join(", ")}）`).toBeTruthy();
    expect(m?.cost).toMatchObject({ input: 0.15, output: 0.6, cacheRead: 0.003 });
  });

  it("std → model.yaml 覆盖：首次写入以 models.dev 价为基线（只填 input 不丢输出/缓存价）", async () => {
    const r = await fx.sh.getJson("./diy.sh llmConfig setCost opencode-go deepseek-v4.1-flash --input 0.9");
    const d = r.data as { target: string; seededFromSpec: boolean; cost: Record<string, unknown>; effective: Record<string, unknown> };
    expect(d.target).toBe("override");
    expect(d.seededFromSpec).toBe(true);
    expect(d.cost).toMatchObject({ input: 0.9, output: 0.6, cache_read: 0.003 });

    const costs = (await fx.sh.getJson("./diy.sh llmConfig costs opencode-go")).data as {
      configured: boolean;
      models: { id: string; cost: Record<string, unknown> | null; costSource: string; writable: string[] }[];
    };
    const m = costs.models.find((x) => x.id === "deepseek-v4.1-flash")!;
    expect(costs.configured).toBe(true);
    expect(m.costSource).toBe("override");
    expect(m.cost?.input).toBe(0.9);
    expect(m.writable).toEqual(["override"]);

    // 删掉覆盖 → 回退 models.dev 价（costSource 回到 spec）
    const cleared = await fx.sh.getJson("./diy.sh llmConfig setCost opencode-go deepseek-v4.1-flash --clear");
    expect((cleared.data as { cost: unknown }).cost).toBeNull();
    expect((cleared.data as { effective: { input: number } }).effective.input).toBe(0.15);
    const after = (await fx.sh.getJson("./diy.sh llmConfig costs opencode-go")).data as {
      models: { id: string; costSource: string }[];
    };
    expect(after.models.find((x) => x.id === "deepseek-v4.1-flash")?.costSource).toBe("spec");
  });

  it("只填一个字段即预警（缺 base in/out → 未命中时段的请求算不出金额）", async () => {
    const r = await fx.sh.getJson("./diy.sh llmConfig setCost custom:goat gpt-6-astra --output 2");
    const w = (r.data as { warnings: string[] }).warnings.join("\n");
    expect(w).toContain("base 档缺完整价");
    await fx.sh.run("./diy.sh llmConfig setCost custom:goat gpt-6-astra --clear");
  });
});

describe("llmConfig setTiers（峰谷时段档）", () => {
  const peak =
    '[{"input":0.5,"output":3,"cache_read":0.1,"tier":{"type":"utc-range","data":{"start":"01:00:00+08:00","end":"04:00:00+08:00","calendar":"CN-business-day","label":"peak"}}}]';

  it("登记时段档 → 落盘 + 回执 tierCount；--drop 删（Bash 传 JSON 数组）", async () => {
    // 先给 base 价（峰谷价的前提：未命中时段档的请求要按 base 计价）
    await fx.sh.getJson("./diy.sh llmConfig setCost custom:goat gpt-5.5 --input 0.15 --output 0.6");
    const r = await fx.sh.getJson(`./diy.sh llmConfig setTiers custom:goat gpt-5.5 --tiers '${peak}'`);
    const d = r.data as { tierCount: number; warnings: string[] };
    expect(d.tierCount).toBe(1);
    expect(d.warnings).toEqual([]);
    const cost = goatCost("gpt-5.5") as { tiers: { tier: { type: string; data: Record<string, string> } }[] };
    expect(cost.tiers).toHaveLength(1);
    expect(cost.tiers[0]!.tier.data).toMatchObject({
      start: "01:00:00+08:00",
      end: "04:00:00+08:00",
      calendar: "CN-business-day",
      label: "peak",
    });

    const dropped = await fx.sh.getJson("./diy.sh llmConfig setTiers custom:goat gpt-5.5 --drop 0");
    expect((dropped.data as { tierCount: number }).tierCount).toBe(0);
    expect((goatCost("gpt-5.5") as { tiers?: unknown }).tiers).toBeUndefined();
  });

  it("引用不存在的日历 → 仍保存但预警（该窗永不命中，退 base 价）", async () => {
    const r = await fx.sh.getJson(
      "./diy.sh llmConfig setTiers custom:goat gpt-5.5 --tiers '[{\"input\":1,\"output\":2,\"tier\":{\"type\":\"utc-range\",\"data\":{\"start\":\"01:00:00+08:00\",\"end\":\"04:00:00+08:00\",\"calendar\":\"Mars-business-day\"}}}]'",
    );
    expect((r.data as { tierCount: number }).tierCount).toBe(1);
    expect((r.data as { warnings: string[] }).warnings.join("\n")).toContain("引用日历 Mars-business-day 不存在");
    await fx.sh.run("./diy.sh llmConfig setTiers custom:goat gpt-5.5 --clear");
  });
});

describe("误用必须出声（agent 靠 stderr 判断，不靠猜）", () => {
  it("模型不在 spec → 非零退出 + 中文原因（含可用 id）", async () => {
    const r = await fx.sh.run("./diy.sh llmConfig setCost custom:goat nope --input 1");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("没有模型 nope");
    expect(r.stderr).toContain("gpt-5.5");
  });

  it("setTiers 三个模式都不给 / 给两个 → 非零退出", async () => {
    const r1 = await fx.sh.run("./diy.sh llmConfig setTiers custom:goat gpt-5.5");
    expect(r1.code).not.toBe(0);
    expect(r1.stderr).toContain("三种模式只能给一个");
    const r2 = await fx.sh.run("./diy.sh llmConfig setTiers custom:goat gpt-5.5 --clear --drop 0");
    expect(r2.code).not.toBe(0);
    expect(r2.stderr).toContain("三种模式只能给一个");
  });

  it("--tiers 缺 tier 触发条件 → zod 拒收（不留「写了其实没用」的档）", async () => {
    const r = await fx.sh.run(`./diy.sh llmConfig setTiers custom:goat gpt-5.5 --tiers '[{"input":1,"output":2}]'`);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("tier 触发条件");
  });

  it("help 里选项为 kebab 形态（agent 照 help 拼命令）", async () => {
    const r = await fx.sh.run("./diy.sh llmConfig setCost --help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--cache-read");
    expect(r.stdout).toContain("--base-label");
    expect(r.stdout).toContain("--clear-fields");
  });
});
