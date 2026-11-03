// tests/core/models-sync.test.ts
// 🎯 模型目录**应用内刷新**的契约（##385 §3.4）：失败绝不写半成品 / 无 diff 不写 / 有 diff 才落盘。
//
// 依赖注入（home / origin / fetchText / now）：不碰真网络、不睡、不看生产数据根。
// 「本地文件逐字不变」比「写没写」更严格 —— mtime 也断言，否则「内容相同但重写一遍」
// 会掩盖「其实每次都写盘」这个噪音问题（§3.2 的判据）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODELS_DEV_FILE } from "../../src/shared/model-config";
import { activeSnapshot, refreshModelsOnce } from "../../src/main/core/models-sync";

let HOME: string;
const NOW = () => new Date("2026-10-22T08:00:00.000Z");

/** 一份合法上游（两家白名单 provider） */
const upstream = (extra: Record<string, unknown> = {}) => ({
    alpha: { id: "alpha", name: "Alpha", npm: "@ai-sdk/openai-compatible", api: "https://a.example/v1", models: { m1: { id: "m1", name: "M1" } } },
    beta: { id: "beta", name: "Beta", npm: "@ai-sdk/openai", api: "https://b.example/v1", models: { m2: { id: "m2" }, m3: { id: "m3" } } },
    ...extra,
});

const dataFile = () => join(HOME, "data", MODELS_DEV_FILE);

beforeEach(() => {
    HOME = mkdtempSync(join(tmpdir(), "t385-sync-"));
});
afterEach(() => {
    rmSync(HOME, { recursive: true, force: true });
});

describe("refreshModelsOnce", () => {
    it("有 diff → 原子写 $DIY_HOME/data/models.dev.json，报新增/下线数", async () => {
        const r = await refreshModelsOnce({ home: HOME, fetchText: async () => JSON.stringify(upstream()), now: NOW });
        expect(r.ok).toBe(true);
        expect(r.changed).toBe(true);
        expect(r.checkedAt).toBe("2026-10-22T08:00:00.000Z");
        expect(r.path).toBe(dataFile());
        expect(r.providers).toBe(2);
        expect(r.models).toBe(3);
        // 落盘内容是**过滤后的快照**（与构建期产物同一形状）
        const written = JSON.parse(readFileSync(dataFile(), "utf-8")) as Record<string, unknown>;
        expect(Object.keys(written).sort()).toEqual(["alpha", "beta"]);
        // previous：首次刷新时 DIY_HOME 还没有文件 → 读到的是仓库源树那份（可能就是 null）
        expect(r.previous === null || r.previous.source !== "diy-home").toBe(true);
    });

    it("无 diff → changed=false 且**不写盘**（内容与 mtime 都不动）", async () => {
        await refreshModelsOnce({ home: HOME, fetchText: async () => JSON.stringify(upstream()), now: NOW });
        const before = { body: readFileSync(dataFile(), "utf-8"), mtime: statSync(dataFile()).mtimeMs };
        const r = await refreshModelsOnce({
            home: HOME,
            fetchText: async () => JSON.stringify(upstream()),
            now: () => new Date("2026-10-23T08:00:00.000Z"),
        });
        expect(r.ok).toBe(true);
        expect(r.changed).toBe(false);
        expect(r.checkedAt).toBe("2026-10-23T08:00:00.000Z");
        expect(r.previous?.source).toBe("diy-home");
        expect(readFileSync(dataFile(), "utf-8")).toBe(before.body);
        expect(statSync(dataFile()).mtimeMs).toBe(before.mtime);
    });

    it("上游非 JSON → 保留旧文件（内容与 mtime 逐字不变）+ 给原因", async () => {
        await refreshModelsOnce({ home: HOME, fetchText: async () => JSON.stringify(upstream()), now: NOW });
        const before = { body: readFileSync(dataFile(), "utf-8"), mtime: statSync(dataFile()).mtimeMs };
        const r = await refreshModelsOnce({ home: HOME, fetchText: async () => "<html>502 Bad Gateway</html>", now: NOW });
        expect(r.ok).toBe(false);
        expect(r.changed).toBe(false);
        expect(r.error).toMatch(/JSON|Unexpected/i);
        expect(readFileSync(dataFile(), "utf-8")).toBe(before.body);
        expect(statSync(dataFile()).mtimeMs).toBe(before.mtime);
    });

    it("上游结构非法（白名单 provider 缺 models）→ 不写盘", async () => {
        await refreshModelsOnce({ home: HOME, fetchText: async () => JSON.stringify(upstream()), now: NOW });
        const before = readFileSync(dataFile(), "utf-8");
        const bad = { alpha: { id: "alpha", npm: "@ai-sdk/openai-compatible", api: "u" } };
        const r = await refreshModelsOnce({ home: HOME, fetchText: async () => JSON.stringify(bad), now: NOW });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/models/);
        expect(readFileSync(dataFile(), "utf-8")).toBe(before);
    });

    it("抓取抛错（断网 / 5xx / 超时）→ ok=false + 原因，旧文件不变", async () => {
        const r = await refreshModelsOnce({
            home: HOME,
            fetchText: async () => {
                throw new Error("getaddrinfo ENOTFOUND models.dev");
            },
            now: NOW,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/ENOTFOUND/);
        expect(() => statSync(dataFile())).toThrow(); // 没有产生新文件
    });

    it("origin 是本地文件路径也能刷新（离线源 / 意图测试走这条路）", async () => {
        const src = join(HOME, "upstream.json");
        writeFileSync(src, JSON.stringify(upstream()), "utf-8");
        const r = await refreshModelsOnce({ home: HOME, origin: src, now: NOW });
        expect(r.ok).toBe(true);
        expect(r.changed).toBe(true);
        expect(r.origin).toBe(src);
    });

    it("旧快照本身坏了不挡刷新（更该被覆盖），且仍不写半成品", async () => {
        mkdirSync(join(HOME, "data"), { recursive: true });
        writeFileSync(dataFile(), "{ broken", "utf-8");
        const r = await refreshModelsOnce({ home: HOME, fetchText: async () => JSON.stringify(upstream()), now: NOW });
        expect(r.ok).toBe(true);
        expect(r.changed).toBe(true);
        expect(r.previous).toBe(null);
        expect(JSON.parse(readFileSync(dataFile(), "utf-8"))).toHaveProperty("alpha");
    });
});

describe("activeSnapshot（诊断出口的真源）", () => {
    it("DIY_HOME 有快照时压过发行/源树，并报该绝对路径与来源", async () => {
        await refreshModelsOnce({ home: HOME, fetchText: async () => JSON.stringify(upstream()), now: NOW });
        const cur = activeSnapshot(HOME);
        expect(cur?.hit.source).toBe("diy-home");
        expect(cur?.info).toEqual({ path: dataFile(), source: "diy-home", providers: 2, models: 3 });
    });
});
