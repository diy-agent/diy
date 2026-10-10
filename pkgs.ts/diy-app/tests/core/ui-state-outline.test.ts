// tests/core/ui-state-outline.test.ts — 聊天显示模式（正常/大纲）的缓存契约
//
// 2026-10-04 定案：取消原「脉络/阅读/审计」三档密度，改**唯一一个显示开关**
//（正常 = 折叠态正文全文；大纲 = 截 N 行）。这里锁定：
//   ① 默认正常（false）、行数默认 3；② 行数 parse 夹在 1-10；
//   ③ 旧 key（diy_chat_density 三档 / diy_chat_compact）由 clearUiCache 一并清走。
// 文件名曾叫 ui-state-density：密度这个概念已被取消，名字跟着语义走（review P2-9）。
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

const { Caches, OUTLINE_LINES_DEFAULT, clearUiCache } = await import(
    "../../src/renderer_solid/lib/ui-state"
);

describe("聊天显示模式（正常/大纲）", () => {
    beforeEach(() => store.clear());

    it("默认正常（false，折叠态正文全文）", () => {
        expect(Caches.diy_chat_outline.get()).toBe(false);
    });

    it("大纲行数默认 3，parse 夹在 1-10（越界/非整数回默认）", () => {
        expect(Caches.diy_chat_outline_lines.defaultValue).toBe(OUTLINE_LINES_DEFAULT);
        expect(Caches.diy_chat_outline_lines.get()).toBe(3);
        for (const good of [1, 5, 10]) {
            store.set("diy_chat_outline_lines", String(good));
            expect(Caches.diy_chat_outline_lines.get(), String(good)).toBe(good);
        }
        for (const bad of ["0", "11", "-1", "3.5", "abc", ""]) {
            store.set("diy_chat_outline_lines", bad);
            expect(Caches.diy_chat_outline_lines.get(), bad).toBe(OUTLINE_LINES_DEFAULT);
        }
    });

    it("写入即持久化（大纲开关存 1/0）", () => {
        Caches.diy_chat_outline.set(true);
        expect(store.get("diy_chat_outline")).toBe("1");
        expect(Caches.diy_chat_outline.get()).toBe(true);
    });

    it("clearUiCache 清走旧 key（三档密度 + 旧紧凑 key）", () => {
        for (const k of ["diy_chat_density", "diy_chat_compact", "diy_chat_compact_lines"]) {
            store.set(k, "x");
        }
        clearUiCache();
        for (const k of ["diy_chat_density", "diy_chat_compact", "diy_chat_compact_lines"]) {
            expect(store.get(k), k).toBeUndefined();
        }
    });
});
