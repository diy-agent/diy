import { describe, expect, it } from "vitest";
import { loadPages, orderPlugins, type ModuleLoader, type PluginEntry } from "../src/loader.js";
import { WorkbenchError } from "../src/errors.js";

const fake = (modules: Record<string, unknown>): ModuleLoader => async (name) => {
    if (!(name in modules)) throw new Error(`没有模块 ${name}`);
    return modules[name];
};

describe("orderPlugins", () => {
    it("依赖先加载，与传入顺序无关", () => {
        const entries: PluginEntry[] = [
            { id: "b", name: "pkg-b", inject: ["a"] },
            { id: "a", name: "pkg-a" },
        ];
        expect(orderPlugins(entries).map((e) => e.id)).toEqual(["a", "b"]);
    });

    it("成环即抛", () => {
        const entries: PluginEntry[] = [
            { id: "a", name: "pkg-a", inject: ["b"] },
            { id: "b", name: "pkg-b", inject: ["a"] },
        ];
        expect(() => orderPlugins(entries)).toThrow(WorkbenchError);
    });

    it("依赖缺失即抛", () => {
        expect(() => orderPlugins([{ id: "a", name: "pkg-a", inject: ["nope"] }])).toThrow(/nope/);
    });
});

describe("loadPages", () => {
    it("归一 default 函数 / pages 数组 / 裸数组三种写法", async () => {
        const load = fake({
            "pkg-fn": { default: (config: unknown) => ({ id: "from-fn", title: String(config) }) },
            "pkg-array": { pages: [{ id: "from-array", title: "数组" }] },
            "pkg-bare": [{ id: "from-bare", title: "裸数组" }],
        });
        const pages = await loadPages(
            [
                { id: "fn", name: "pkg-fn", config: "标题" },
                { id: "array", name: "pkg-array" },
                { id: "bare", name: "pkg-bare" },
            ],
            load,
        );
        expect(pages.map((p) => p.id)).toEqual(["from-fn", "from-array", "from-bare"]);
        expect(pages[0]?.title).toBe("标题");
    });

    it("页面 id 重复即抛", async () => {
        const load = fake({
            a: [{ id: "same", title: "A" }],
            b: [{ id: "same", title: "B" }],
        });
        await expect(
            loadPages(
                [
                    { id: "a", name: "a" },
                    { id: "b", name: "b" },
                ],
                load,
            ),
        ).rejects.toThrow(/页面 id 重复/);
    });

    it("形状不对即抛（缺 id / title）", async () => {
        await expect(loadPages([{ id: "x", name: "x" }], fake({ x: [{ title: "没有 id" }] }))).rejects.toThrow(
            /缺 id/,
        );
    });
});
