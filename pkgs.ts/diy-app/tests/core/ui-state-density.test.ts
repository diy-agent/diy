// tests/core/ui-state-density.test.ts — 聊天信息密度（三档语义）的缓存契约
//
// 2026-10-04 重定义：四级（outline/read/audit/forensic）→ 三级，取消「全开」档。
// 这里锁定两件容易回退的事：
//   ① 枚举顺序 = ☷ 单键循环的切换次序（L1 → L2 → L3 → 回 L1）；
//   ② 旧存储值的归并方向 —— 已落盘的 "4" 与原枚举 forensic 都必须归到 L3（信息不减），
//      不能悄悄回默认（那会让老用户重启后"过程凭空消失"）。
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

const { Caches, DENSITY_LEVEL, DENSITY_VALUES, DENSITY_LABEL } = await import(
    "../../src/renderer_solid/lib/ui-state"
);

describe("聊天信息密度（三档语义）", () => {
    beforeEach(() => store.clear());

    it("恰好三档、顺序 = 由简到繁（单键循环的次序）", () => {
        expect(DENSITY_VALUES).toEqual([
            DENSITY_LEVEL.OUTLINE,
            DENSITY_LEVEL.READ,
            DENSITY_LEVEL.AUDIT,
        ]);
        expect(DENSITY_VALUES).toHaveLength(3);
    });

    it("每档都有中文短名（单键按钮要显示当前档，不能再靠数字/位置猜）", () => {
        for (const d of DENSITY_VALUES) expect(DENSITY_LABEL[d]).toBeTruthy();
    });

    it("默认 = 阅读（L2）", () => {
        expect(Caches.diy_chat_density.get()).toBe(DENSITY_LEVEL.READ);
    });

    it("旧数字兼容：1/2/3 顺延，4（含已取消的 forensic）归并到审计 L3", () => {
        for (const raw of ["1", "2", "3", "4", "forensic"]) {
            store.set("diy_chat_density", raw);
            const got = Caches.diy_chat_density.get();
            expect(got, raw).not.toBeUndefined();
            expect(DENSITY_VALUES, raw).toContain(got);
        }
        store.set("diy_chat_density", "1");
        expect(Caches.diy_chat_density.get()).toBe(DENSITY_LEVEL.OUTLINE);
        store.set("diy_chat_density", "4");
        expect(Caches.diy_chat_density.get()).toBe(DENSITY_LEVEL.AUDIT);
        store.set("diy_chat_density", "forensic");
        expect(Caches.diy_chat_density.get()).toBe(DENSITY_LEVEL.AUDIT);
    });

    it("非法值回默认（不崩、不臆断）", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        for (const bad of ["", "nope", "5", "0"]) {
            store.set("diy_chat_density", bad);
            expect(Caches.diy_chat_density.get(), bad).toBe(DENSITY_LEVEL.READ);
        }
        warn.mockRestore();
    });

    it("写入即持久化（存语义值，不是数字）", () => {
        Caches.diy_chat_density.set(DENSITY_LEVEL.AUDIT);
        expect(store.get("diy_chat_density")).toBe("audit");
        expect(Caches.diy_chat_density.get()).toBe(DENSITY_LEVEL.AUDIT);
    });
});
