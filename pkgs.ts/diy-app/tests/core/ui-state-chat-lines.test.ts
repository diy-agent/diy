// tests/core/ui-state-chat-lines.test.ts — 聊天“2 级结论摘要行数”的缓存契约
//
// 2026-10-11：原「正常 / 大纲」两态开关取消，改成**每轮各自的展开级别循环**
//（见 lib/chat-fold 的 TurnLevel；级别本身不落盘）。留在存储里的只有摘要行数：
//   ① 默认 3；② parse 夹在 1-10（越界/非整数回默认）；
//   ③ 历次迭代的旧 key（三档密度 / 旧紧凑 key / 「正常/大纲」开关与其行数 key）
//      由 clearUiCache 一并清走，升级不留残渣。
// 文件名曾叫 ui-state-density → ui-state-outline：名字跟着语义走（review P2-9），
// 语义再变（大纲模式取消）就再改一次，不留下名不副实的文件。
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

const { Caches, CONCLUSION_LINES_DEFAULT, clearUiCache } = await import(
    "../../src/renderer_solid/lib/ui-state"
);

describe("聊天结论摘要行数", () => {
    beforeEach(() => store.clear());

    it("结论摘要行数默认 3，parse 夹在 1-10（越界/非整数回默认）", () => {
        expect(Caches.diy_chat_conclusion_lines.defaultValue).toBe(CONCLUSION_LINES_DEFAULT);
        expect(Caches.diy_chat_conclusion_lines.get()).toBe(3);
        for (const good of [1, 5, 10]) {
            store.set("diy_chat_conclusion_lines", String(good));
            expect(Caches.diy_chat_conclusion_lines.get(), String(good)).toBe(good);
        }
        for (const bad of ["0", "11", "-1", "3.5", "abc", ""]) {
            store.set("diy_chat_conclusion_lines", bad);
            expect(Caches.diy_chat_conclusion_lines.get(), bad).toBe(CONCLUSION_LINES_DEFAULT);
        }
    });

    it("写入即持久化", () => {
        Caches.diy_chat_conclusion_lines.set(5);
        expect(store.get("diy_chat_conclusion_lines")).toBe("5");
        expect(Caches.diy_chat_conclusion_lines.get()).toBe(5);
    });

    it("clearUiCache 清走全部旧 key（三档密度 / 旧紧凑 / 正常-大纲两态）", () => {
        const legacy = [
            "diy_chat_density",
            "diy_chat_compact",
            "diy_chat_compact_lines",
            "diy_chat_outline",
            "diy_chat_outline_lines",
        ];
        for (const k of legacy) store.set(k, "x");
        clearUiCache();
        for (const k of legacy) expect(store.get(k), k).toBeUndefined();
    });
});
