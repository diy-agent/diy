import { describe, expect, test } from "vitest";
import { ENVELOPE_ABOUT } from "@diy/context/envelope";

/**
 * `help.about` 是**每轮都付**的固定话术（进 system 前缀）。
 * 它的价值全在「zod 描述不了的总逻辑」—— 这里钉住**必须存在**的语义，
 * 避免为了省字节把指令删掉，也避免它重新膨胀成 1.6 KB。
 */
describe("ENVELOPE_ABOUT", () => {
    test("字节预算：不超 900 B（2026-10-22 从 1689 B 压到 724 B）", () => {
        expect(Buffer.byteLength(ENVELOPE_ABOUT, "utf8")).toBeLessThan(900);
    });

    test("保留不可替代的指令（删掉就会误用信封）", () => {
        // 两条树都在 system；user 里只发增量，后出现者为准，null = 删除
        expect(ENVELOPE_ABOUT).toContain("system");
        expect(ENVELOPE_ABOUT).toContain("runtime");
        expect(ENVELOPE_ABOUT).toContain("后出现");
        expect(ENVELOPE_ABOUT).toContain("null");
        // 可见内容分两类：机器事件 / 发言
        expect(ENVELOPE_ABOUT).toContain("notify");
        expect(ENVELOPE_ABOUT).toContain("chat");
        expect(ENVELOPE_ABOUT).toContain("human:");
        expect(ENVELOPE_ABOUT).toContain("agent:");
        // 空值与缺值不是一回事
        expect(ENVELOPE_ABOUT).toContain("[]");
        expect(ENVELOPE_ABOUT).toContain("{}");
        expect(ENVELOPE_ABOUT).toContain("没有这个变量");
    });
});
