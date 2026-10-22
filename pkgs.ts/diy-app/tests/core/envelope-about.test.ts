import { describe, expect, test } from "vitest";
import { ENVELOPE_ABOUT } from "../../src/shared/context/envelope";

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
        // 轮中变更 = 追加 diff，新旧以后出现者为准
        expect(ENVELOPE_ABOUT).toContain("runtimeDiff");
        expect(ENVELOPE_ABOUT).toContain("后出现");
        // 压缩不动变量树 → 不许为查值去 cat / 跑命令
        expect(ENVELOPE_ABOUT).toContain("历史压缩不动变量树");
        expect(ENVELOPE_ABOUT).toContain("cat");
        // 空值与缺值不是一回事
        expect(ENVELOPE_ABOUT).toContain("[]");
        expect(ENVELOPE_ABOUT).toContain("{}");
        expect(ENVELOPE_ABOUT).toContain("「没有这个变量」");
        // summary 只是背景
        expect(ENVELOPE_ABOUT).toContain("summary");
        expect(ENVELOPE_ABOUT).toContain("背景");
    });
});
