// tests/core/models-snapshot.test.ts
// 🎯 models.dev 快照的**纯函数契约**（##385）：白名单过滤 + 结构自洽校验 + 前后对比。
//
// 为什么穷举校验边界：这份快照会写进**用户数据根**并直接决定价格/上下文上限，
// 「上游改版 / 半截 JSON」若被放过，症状是模型页整页空、或价格静默变 0 ——
// 比「刷新失败」严重得多（§3.4 fail-soft 的判据就在这里）。
import { describe, it, expect } from "vitest";
import {
    MODELS_DEV_NPM_ALLOW,
    ModelsSnapshotInvalidError,
    buildModelsSnapshot,
    diffSnapshot,
    snapshotCounts,
} from "../../src/main/core/models-snapshot";
import type { SpecProvider } from "../../src/shared/model-config";

const provider = (id: string, npm: string, models: string[]) => ({
    id,
    name: id,
    npm,
    api: "https://example.com/v1",
    models: Object.fromEntries(models.map((m) => [m, { id: m, name: m }])),
});

describe("buildModelsSnapshot", () => {
    it("只保留 npm 白名单内的 provider，原字段原样", () => {
        const built = buildModelsSnapshot({
            ok: provider("ok", "@ai-sdk/openai-compatible", ["a", "b"]),
            resp: provider("resp", "@ai-sdk/openai", ["c"]),
            drop: provider("drop", "@ai-sdk/anthropic", ["x", "y", "z"]),
        });
        expect(Object.keys(built.snapshot)).toEqual(["ok", "resp"]);
        expect(built.providers).toBe(2);
        expect(built.models).toBe(3);
        // 原字段原样：不是「挑几个字段重建」，而是整个 provider 条目带过去
        expect(built.snapshot.ok!.name).toBe("ok");
    });

    it("可选字段可缺省：models.dev 真实数据里 openai 就没有 api（校验不许比真数据严）", () => {
        const built = buildModelsSnapshot({
            openai: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", models: { gpt: { id: "gpt" } } },
        });
        expect(built.providers).toBe(1);
        expect(built.snapshot.openai!.api).toBeUndefined();
    });

    it("白名单是唯一真源：常量与运行时面一致（两家）", () => {
        expect([...MODELS_DEV_NPM_ALLOW]).toEqual(["@ai-sdk/openai-compatible", "@ai-sdk/openai"]);
    });

    it.each([
        ["非对象（数组）", [] as unknown],
        ["非对象（null）", null],
        ["非对象（字符串）", "{}"],
        ["空映射", {}],
        ["provider 不是对象", { a: 1 }],
        ["白名单 provider 缺 models", { a: { id: "a", npm: MODELS_DEV_NPM_ALLOW[0], api: "u" } }],
        ["白名单 provider 缺 id", { a: { npm: MODELS_DEV_NPM_ALLOW[0], api: "u", models: {} } }],
        ["白名单 provider 的 api 不是字符串", { a: { id: "a", npm: MODELS_DEV_NPM_ALLOW[0], api: 1, models: {} } }],
        ["白名单过滤后一家不剩", { a: provider("a", "@ai-sdk/anthropic", ["x"]) }],
    ])("结构非法 → 抛 ModelsSnapshotInvalidError：%s", (_name, raw) => {
        expect(() => buildModelsSnapshot(raw)).toThrow(ModelsSnapshotInvalidError);
    });

    it("非法异常的 code 符合命名约定（错误分类靠它）", () => {
        try {
            buildModelsSnapshot({});
        } catch (e) {
            expect((e as { code?: string }).code).toBe("llm/models-snapshot-invalid");
        }
    });
});

describe("snapshotCounts", () => {
    it("provider / 模型计数", () => {
        const snap = {
            a: provider("a", MODELS_DEV_NPM_ALLOW[0], ["m1", "m2"]),
            b: provider("b", MODELS_DEV_NPM_ALLOW[1], ["m3"]),
        } as unknown as Record<string, SpecProvider>;
        expect(snapshotCounts(snap)).toEqual({ providers: 2, models: 3 });
    });
});

describe("diffSnapshot", () => {
    const p = (id: string, models: string[]) => provider(id, MODELS_DEV_NPM_ALLOW[0], models) as unknown as SpecProvider;
    const prev = { a: p("a", ["m1", "m2"]), b: p("b", ["m3"]) } as Record<string, SpecProvider>;

    it("无变化 → changed=false 且没有增删", () => {
        const d = diffSnapshot(prev, structuredClone(prev));
        expect(d).toEqual({ changed: false, addedProviders: [], removedProviders: [], addedModels: 0, removedModels: 0 });
    });

    it("provider 上/下线 + 模型增删都数清", () => {
        const next = { a: p("a", ["m1", "m4"]), c: p("c", ["m5"]) } as Record<string, SpecProvider>;
        const d = diffSnapshot(prev, next);
        expect(d.changed).toBe(true);
        expect(d.addedProviders).toEqual(["c"]);
        expect(d.removedProviders).toEqual(["b"]);
        expect(d.addedModels).toBe(2); // a/m4 + c/m5
        expect(d.removedModels).toBe(2); // a/m2 + b/m3
    });

    it("只在价目等元数据上变化也算 changed（刷新就是要落这类变化）", () => {
        const next = structuredClone(prev) as Record<string, SpecProvider>;
        (next.a!.models!.m1 as unknown as { cost?: unknown }).cost = { input: 1, output: 2 };
        expect(diffSnapshot(prev, next).changed).toBe(true);
    });

    it("无旧快照 → 全算新增", () => {
        const d = diffSnapshot(null, prev);
        expect(d.changed).toBe(true);
        expect(d.addedProviders).toEqual(["a", "b"]);
        expect(d.addedModels).toBe(3);
    });
});
