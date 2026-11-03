import { describe, expect, it } from "vitest";
import { effectiveBashArgs } from "../../src/shared/tool-args";

/**
 * 判据（##454 用户 2026-10-29）：「**默认不超时，有人设置工具超时就要尊重**」。
 * 同时保留 ##408 的旧判据：聊天里必须能看出「是前台还是后台、超时多少」，
 * 而模型**只发它想改的**（常常只有 `command`），缺省值是代码补的 ⇒ 补了必须标出来。
 */
describe("effectiveBashArgs", () => {
    it("模型只发 command ⇒ timeout 缺省 = 0（不设超时），background = false，两者都标 defaulted", () => {
        const r = effectiveBashArgs({ command: "ls" });
        expect(r.args).toEqual({ command: "ls", timeout: 0, background: false });
        expect(r.defaulted).toEqual(["background", "timeout"]);
    });

    it("显式 timeout 一律尊重（不因前台/后台而变）", () => {
        expect(effectiveBashArgs({ command: "x", timeout: 5000 }).args.timeout).toBe(5000);
        expect(effectiveBashArgs({ command: "x", timeout: 5000, background: true }).args.timeout).toBe(5000);
        expect(effectiveBashArgs({ command: "x", timeout: 5000 }).defaulted).not.toContain("timeout");
    });

    it("background 不再影响缺省超时（删掉「像后台就不设超时」的猜测，##454）", () => {
        const fg = effectiveBashArgs({ command: "x" });
        const bg = effectiveBashArgs({ command: "x", background: true });
        expect(fg.args.timeout).toBe(bg.args.timeout);
        expect(bg.args.timeout).toBe(0);
    });

    it("命令里出现 & / nohup 也不改超时（本函数只看参数，不读命令文本）", () => {
        const r = effectiveBashArgs({ command: "nohup sleep 999 &" });
        expect(r.args.timeout).toBe(0);
        expect(effectiveBashArgs({ command: "sleep 999 &", timeout: 1000 }).args.timeout).toBe(1000);
    });

    it('background 只认严格 true（"false" 这种字符串不算后台）', () => {
        expect(effectiveBashArgs({ command: "x", background: "false" }).args.background).toBe(false);
        expect(effectiveBashArgs({ command: "x", background: 1 }).args.background).toBe(false);
    });

    it("timeout: 0 = 不设超时，且**不算**缺省值（模型显式发了）", () => {
        const r = effectiveBashArgs({ command: "x", timeout: 0 });
        expect(r.args.timeout).toBe(0);
        expect(r.defaulted).toEqual(["background"]);
    });

    it("负数夹到 0、小数向下取整（与 runBash 的 Math.max(0, Math.floor()) 同形）", () => {
        expect(effectiveBashArgs({ timeout: -5 }).args.timeout).toBe(0);
        expect(effectiveBashArgs({ timeout: 1500.9 }).args.timeout).toBe(1500);
    });

    it("非数字 timeout（模型给字符串）⇒ 当没给，回缺省 0 并标记", () => {
        const r = effectiveBashArgs({ command: "x", timeout: "60000" });
        expect(r.args.timeout).toBe(0);
        expect(r.defaulted).toContain("timeout");
    });

    it("background: true 原样保留；false 也算显式（不进 defaulted）", () => {
        const r = effectiveBashArgs({ command: "x", background: true });
        expect(r.args.background).toBe(true);
        expect(r.defaulted).not.toContain("background");
        expect(effectiveBashArgs({ background: false }).defaulted).not.toContain("background");
    });

    it("入参不是对象（流式早期 null / 半截字符串）⇒ 全缺省，不抛", () => {
        for (const bad of [null, undefined, "{\"command\"", 42]) {
            const r = effectiveBashArgs(bad);
            expect(r.args).toEqual({ command: "", timeout: 0, background: false });
            expect(r.defaulted).toEqual(["background", "timeout"]);
        }
    });

    it("command 不是字符串 ⇒ 空串（不把异常对象塞进执行路径）", () => {
        expect(effectiveBashArgs({ command: 123 }).args.command).toBe("");
    });
});
