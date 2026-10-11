// tests/core/ui-state-chat-view.test.ts — 聊天**视图 cache**的两个数：全局展开级别 + 摘要行数
//
// 2026-10-11：原「正常 / 大纲」两态开关取消 → 改成**展开级别**（1 摘要结论 / 2 完整结论 /
// 3 全部正文 / 4 逐条过程；第 5 层「单条过程内容」不在循环里，见 lib/chat-fold 的 TurnLevel）。
// 存储里只剩两个数：
//   ① 全局级别（顶部 `n/4 展开`）—— 默认 3、parse 只收 1-4（越界回默认）、**落盘**；
//   ② 摘要行数 —— 默认 3、parse 夹在 1-10；
//   ③ 历次迭代的旧 key（三档密度 / 旧紧凑 key / 「正常/大纲」开关与其行数 key）
//      由 clearUiCache 一并清走，升级不留残渣。
// **单轮的手动覆盖不落盘**（轮次 id 无限增长）—— 故此处没有对应字段可测，这是有意的。
// 文件名曾叫 ui-state-density → ui-state-outline → ui-state-chat-lines：名字跟着语义走
//（review P2-9），语义再变就再改一次，不留下名不副实的文件。
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
const { DEFAULT_TURN_LEVEL, TURN_LEVEL_MAX } = await import("../../src/renderer_solid/lib/chat-fold");

describe("聊天全局展开级别", () => {
    beforeEach(() => store.clear());

    it("默认 = chat-fold 的默认级别（3：全部正文），存储层不另立一套默认", () => {
        expect(Caches.diy_chat_level.defaultValue).toBe(DEFAULT_TURN_LEVEL);
        expect(Caches.diy_chat_level.get()).toBe(3);
    });

    it("parse 只收 1-4：越界（含第 5 层「过程详情」）与脏值一律回默认", () => {
        for (const good of [1, 2, 3, TURN_LEVEL_MAX]) {
            store.set("diy_chat_level", String(good));
            expect(Caches.diy_chat_level.get(), String(good)).toBe(good);
        }
        for (const bad of ["0", "5", "-1", "2.5", "abc", ""]) {
            store.set("diy_chat_level", bad);
            expect(Caches.diy_chat_level.get(), bad).toBe(DEFAULT_TURN_LEVEL);
        }
    });

    it("写入即持久化（全局级别是长期偏好，重开 app 不回默认）", () => {
        Caches.diy_chat_level.set(1);
        expect(store.get("diy_chat_level")).toBe("1");
        expect(Caches.diy_chat_level.get()).toBe(1);
    });
});

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
