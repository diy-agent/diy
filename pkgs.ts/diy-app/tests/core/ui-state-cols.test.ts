// tests/core/ui-state-cols.test.ts — 试验场表格列宽的缓存契约
//
// 列宽必须**持久化且可校验**：坏数据（手改 localStorage / 旧版本残留）不能把界面搞崩，
// 一律回默认值。这里用内存 stub 代替 localStorage（测试环境是 node，无 jsdom）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
} as Storage;

const { Caches, clearUiCache } = await import("../../src/renderer_solid/lib/ui-state");

describe("试验场表格列宽（Caches 字段）", () => {
    beforeEach(() => store.clear());

    it("默认值：三张表的列数正确，且默认总和能放进默认左栏宽（336）", () => {
        expect(Caches.diy_lab_cols_vars.defaultValue).toHaveLength(2);
        expect(Caches.diy_lab_cols_vals.defaultValue).toHaveLength(2);
        expect(Caches.diy_lab_cols_trace.defaultValue).toHaveLength(4);
        for (const f of [Caches.diy_lab_cols_vars, Caches.diy_lab_cols_vals, Caches.diy_lab_cols_trace]) {
            expect(f.get().reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(326);
        }
    });

    it("写入即持久化：重新 get 拿到的是改过的列宽", () => {
        Caches.diy_lab_cols_trace.set([200, 96, 84, 48]);
        expect(Caches.diy_lab_cols_trace.get()).toEqual([200, 96, 84, 48]);
        expect(store.get("diy_lab_cols_trace")).toBe("[200,96,84,48]");
    });

    it("坏数据一律回默认：长度不对 / 数值越界 / 非数组 / 非法 JSON", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const def = Caches.diy_lab_cols_trace.defaultValue;
        for (const bad of ["[200,96]", "[200,96,84,9999]", "[200,96,84,0]", '{"a":1}', "不是 JSON", "[]"]) {
            store.set("diy_lab_cols_trace", bad);
            expect(Caches.diy_lab_cols_trace.get(), bad).toEqual(def);
        }
        warn.mockRestore();
    });

    it("「重置界面状态」把列宽也复位（清缓存枚举自动覆盖新字段）", () => {
        Caches.diy_lab_cols_vals.set([300, 300]);
        expect(Caches.diy_lab_cols_vals.get()).toEqual([300, 300]);
        clearUiCache();
        expect(Caches.diy_lab_cols_vals.get()).toEqual(Caches.diy_lab_cols_vals.defaultValue);
    });
});
