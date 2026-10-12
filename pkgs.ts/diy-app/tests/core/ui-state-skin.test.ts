// tests/core/ui-state-skin.test.ts — 界面样式（皮肤）这个视图 cache 字段
//
// 皮肤是**系统整体样式**偏好（不是聊天页私有开关）：两套 = rail 竖栏 / card 卡片。
// 这里钉三件事：默认值、只收白名单值（脏值回默认）、随 clearUiCache 一起清干净。
import { beforeEach, describe, expect, it } from "vitest";

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
const { SKINS } = await import("../../src/renderer_solid/lib/skin");

describe("界面样式（diy_app_skin）", () => {
    beforeEach(() => {
        store.clear();
        Caches.diy_app_skin.reset();
    });

    it("默认是 card（卡片）：草图 v4 里先落地的那一套", () => {
        expect(Caches.diy_app_skin.get()).toBe("card");
    });

    it("两套皮肤都能存能取，且 SKINS 清单覆盖全部合法值", () => {
        for (const s of SKINS) {
            Caches.diy_app_skin.set(s.key);
            expect(Caches.diy_app_skin.get()).toBe(s.key);
        }
        expect(SKINS.map((s) => s.key).sort()).toEqual(["card", "rail"]);
    });

    it("脏值 / 未知皮肤名 → 回默认，不把界面带进未定义样式", () => {
        store.set("diy_app_skin", "3d");
        expect(Caches.diy_app_skin.get()).toBe("card");
        store.set("diy_app_skin", "");
        expect(Caches.diy_app_skin.get()).toBe("card");
    });

    it("clearUiCache 一并清走（它是可丢的视图 cache，不是配置数据）", () => {
        Caches.diy_app_skin.set("rail");
        clearUiCache();
        expect(store.get("diy_app_skin")).toBeUndefined();
    });
});
