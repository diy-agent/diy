import { describe, expect, it } from "vitest";
import { loadPages, orderPlugins, type PluginEntry } from "../src/loader.js";
import { WorkbenchError } from "../src/errors.js";

describe("orderPlugins", () => {
    it("依赖先加载，与传入顺序无关", () => {
        const entries: PluginEntry[] = [
            { id: "b", type: "module", data: { module: { pages: [] } }, inject: ["a"] },
            { id: "a", type: "module", data: { module: { pages: [] } } },
        ];
        expect(orderPlugins(entries).map((e) => e.id)).toEqual(["a", "b"]);
    });

    it("成环即抛", () => {
        const entries: PluginEntry[] = [
            { id: "a", type: "module", data: { module: {} }, inject: ["b"] },
            { id: "b", type: "module", data: { module: {} }, inject: ["a"] },
        ];
        expect(() => orderPlugins(entries)).toThrow(WorkbenchError);
    });

    it("依赖缺失即抛", () => {
        expect(() => orderPlugins([{ id: "a", type: "module", data: { module: {} }, inject: ["nope"] }])).toThrow(/nope/);
    });
});

describe("loadPages", () => {
    it("归一 default 函数 / pages 数组 / 裸数组三种写法", async () => {
        const pages = await loadPages([
            {
                id: "fn",
                type: "module",
                data: { module: { default: (config: unknown) => ({ id: "from-fn", title: String(config) }) } },
                config: "标题",
            },
            { id: "array", type: "module", data: { module: { pages: [{ id: "from-array", title: "数组" }] } } },
            { id: "bare", type: "module", data: { module: [{ id: "from-bare", title: "裸数组" }] } },
        ]);
        expect(pages.map((p) => p.id)).toEqual(["from-fn", "from-array", "from-bare"]);
        expect(pages[0]?.title).toBe("标题");
    });

    it("load 式是 module 式的懒加载等价物", async () => {
        const pages = await loadPages([
            { id: "lazy", type: "load", data: { load: async () => [{ id: "from-load", title: "懒" }] } },
        ]);
        expect(pages.map((p) => p.id)).toEqual(["from-load"]);
    });

    it("页面 id 重复即抛", async () => {
        await expect(
            loadPages([
                { id: "a", type: "module", data: { module: [{ id: "same", title: "A" }] } },
                { id: "b", type: "module", data: { module: [{ id: "same", title: "B" }] } },
            ]),
        ).rejects.toThrow(/页面 id 重复/);
    });

    it("形状不对即抛（缺 id / title）", async () => {
        await expect(loadPages([{ id: "x", type: "module", data: { module: [{ title: "没有 id" }] } }])).rejects.toThrow(/缺 id/);
    });
});
