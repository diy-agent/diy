import { beforeEach, describe, expect, it } from "vitest";
import { getPage, registerPage, registeredPages, resetPages } from "../src/registry.js";
import type { PageView } from "../src/contract.js";

const view = (id: string, title = id): PageView => ({ id, title, render: () => undefined });

beforeEach(() => resetPages());

describe("registerPage", () => {
    it("注册后按 id 取得", () => {
        registerPage(view("a", "甲"));
        expect(getPage("a")?.title).toBe("甲");
        expect(registeredPages().map((p) => p.id)).toEqual(["a"]);
    });

    it("id 重复即抛", () => {
        registerPage(view("a"));
        expect(() => registerPage(view("a"))).toThrow(/重复/);
    });

    it("缺 render 即抛", () => {
        expect(() => registerPage({ id: "x", title: "X" } as unknown as PageView)).toThrow(/缺 render/);
    });
});
