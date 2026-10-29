// loader 骨架（##455 #6）：拓扑排序 / 环检测 / apply 约定。
//
// 假包用注入的 load 提供（不打真实 runtime/）：判据是「装配语义」，
// 真实解析链路已由 tests/core/runtime-resolve 之外的 check-runtime-closure 与手工验证覆盖。
import { isInvariantError } from "@diy/context/format/invariant";
import { describe, expect, it } from "vitest";
import { loadAll, orderEntries, type LoaderHost } from "../../src/main/loader";

/** 记录装载顺序的假 runtime：name → 模块（进程内） */
function fakeRuntime(modules: Record<string, unknown>) {
    const loaded: string[] = [];
    return {
        loaded,
        load: async (name: string) => {
            loaded.push(name);
            const mod = modules[name];
            if (mod === undefined) throw new Error(`fake runtime 里没有 ${name}`);
            return mod;
        },
    };
}

/** 内存 host（provide/get 就是一张表） */
function makeHost(): LoaderHost & { values: Map<string, unknown> } {
    const values = new Map<string, unknown>();
    return {
        values,
        provide: (id, value) => void values.set(id, value),
        get: (id) => values.get(id),
    };
}

describe("loadAll", () => {
    it("打乱 entries 顺序仍按 inject 加载（b 在 a 前 ⇒ 仍 a→b）", async () => {
        const runtime = fakeRuntime({
            "pkg-a": { default: (_ctx: LoaderHost) => ({ name: "a" }) },
            "pkg-b": {
                default: (ctx: LoaderHost) => ({ name: "b", sawA: ctx.get("a") }),
            },
        });
        const host = makeHost();

        await loadAll(
            [
                { id: "b", name: "pkg-b", inject: ["a"] },
                { id: "a", name: "pkg-a" },
            ],
            host,
            { load: runtime.load },
        );

        expect(runtime.loaded).toEqual(["pkg-a", "pkg-b"]);
        expect(host.get("a")).toEqual({ name: "a" });
        // b 的 apply 里读到了 a 注册的东西 ⇒ 顺序真的生效
        expect(host.get("b")).toEqual({ name: "b", sawA: { name: "a" } });
    });

    it("config 原样传给 apply；具名 apply 与 default 都认", async () => {
        const seen: unknown[] = [];
        const runtime = fakeRuntime({
            "pkg-a": { apply: (_ctx: LoaderHost, config: unknown) => void seen.push(config) },
            "pkg-b": { default: (_ctx: LoaderHost, config: unknown) => void seen.push(config) },
        });
        const host = makeHost();
        const cfgA = { x: 1 };
        const cfgB = { y: 2 };

        await loadAll(
            [
                { id: "b", name: "pkg-b", config: cfgB, inject: ["a"] },
                { id: "a", name: "pkg-a", config: cfgA },
            ],
            host,
            { load: runtime.load },
        );

        expect(seen).toEqual([cfgA, cfgB]);
    });

    it("环 ⇒ 抛 agent/loader-cycle 并列出环路径 a → b → a", async () => {
        const runtime = fakeRuntime({});
        const host = makeHost();

        await expect(
            loadAll(
                [
                    { id: "a", name: "pkg-a", inject: ["b"] },
                    { id: "b", name: "pkg-b", inject: ["a"] },
                ],
                host,
                { load: runtime.load },
            ),
        ).rejects.toMatchObject({
            code: "agent/loader-cycle",
            detail: expect.stringContaining("a → b → a"),
        });
        // 有环就别装任何东西
        expect(runtime.loaded).toEqual([]);
    });

    it("self-cycle（a inject a）也认", () => {
        expect(() => orderEntries([{ id: "a", name: "pkg-a", inject: ["a"] }])).toThrow(/a → a/);
    });

    it("inject 指向不存在的 id ⇒ agent/loader-missing-dep", () => {
        try {
            orderEntries([{ id: "b", name: "pkg-b", inject: ["a"] }]);
            expect.unreachable("应当抛错");
        } catch (err) {
            expect(isInvariantError(err)).toBe(true);
            if (isInvariantError(err)) {
                expect(err.code).toBe("agent/loader-missing-dep");
                expect(err.detail).toContain("b 依赖 a");
            }
        }
    });

    it("模块没有 apply ⇒ agent/loader-no-apply", async () => {
        const runtime = fakeRuntime({ "pkg-x": { somethingElse: 1 } });
        await expect(
            loadAll([{ id: "x", name: "pkg-x" }], makeHost(), { load: runtime.load }),
        ).rejects.toMatchObject({ code: "agent/loader-no-apply" });
    });

    it("同一层保持传入顺序（稳定拓扑）", () => {
        const ordered = orderEntries([
            { id: "x", name: "pkg-x", inject: ["z"] },
            { id: "y", name: "pkg-y" },
            { id: "z", name: "pkg-z" },
        ]);
        expect(ordered.map((e) => e.id)).toEqual(["z", "x", "y"]);
    });
});
