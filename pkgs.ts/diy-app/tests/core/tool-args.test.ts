import { describe, expect, it } from "vitest";
import { DEFAULT_BASH_TIMEOUT_MS, effectiveBashArgs } from "../../src/shared/tool-args";

/**
 * 判据（##408 用户 2026-10-23）：聊天里必须能看出「是前台还是后台、超时多少」，
 * 而模型**只发它想改的**（常常只有 `command`），缺省值是代码补的。
 * 所以：补要补齐，且**补了必须标出来**（`defaulted`）—— 不标就是撒谎。
 */
describe("effectiveBashArgs", () => {
    it("模型只发 command ⇒ timeout/background 都按缺省补齐并标为 defaulted", () => {
        const r = effectiveBashArgs({ command: "ls" }, { bashTimeoutMs: 120_000 });
        expect(r.args).toEqual({ command: "ls", timeout: 120_000, background: false });
        expect(r.defaulted).toEqual(["background", "timeout"]);
    });

    it("后台缺省不设超时（daemon 不该在 300s 被静默做掉）", () => {
        const r = effectiveBashArgs({ command: "x", background: true }, { bashTimeoutMs: 300_000 });
        expect(r.args.timeout).toBe(0);
        expect(r.defaulted).toContain("timeout");
    });

    it("后台**显式**给了 timeout ⇒ 原样生效（到点整组停）", () => {
        const r = effectiveBashArgs({ command: "x", background: true, timeout: 5000 }, { bashTimeoutMs: 300_000 });
        expect(r.args.timeout).toBe(5000);
        expect(r.defaulted).not.toContain("timeout");
    });

    it('background 只认严格 true（"false" 这种字符串不算后台）', () => {
        expect(effectiveBashArgs({ command: "x", background: "false" }, {}).args.background).toBe(false);
        expect(effectiveBashArgs({ command: "x", background: 1 }, {}).args.background).toBe(false);
    });

    it("limits 缺字段 ⇒ 退 DEFAULT_BASH_TIMEOUT_MS（与执行侧同值）", () => {
        expect(effectiveBashArgs({ command: "x" }, {}).args.timeout).toBe(DEFAULT_BASH_TIMEOUT_MS);
    });

    it("timeout: 0 = 不设超时，且**不算**缺省值（模型显式发了）", () => {
        const r = effectiveBashArgs({ command: "x", timeout: 0 }, { bashTimeoutMs: 300_000 });
        expect(r.args.timeout).toBe(0);
        expect(r.defaulted).toEqual(["background"]);
    });

    it("负数夹到 0、小数向下取整（与 runBash 的 Math.max(0, Math.floor()) 同形）", () => {
        expect(effectiveBashArgs({ timeout: -5 }, {}).args.timeout).toBe(0);
        expect(effectiveBashArgs({ timeout: 1500.9 }, {}).args.timeout).toBe(1500);
    });

    it("非数字 timeout（模型给字符串）⇒ 当没给，回缺省并标记", () => {
        const r = effectiveBashArgs({ command: "x", timeout: "60000" }, { bashTimeoutMs: 1 });
        expect(r.args.timeout).toBe(1);
        expect(r.defaulted).toContain("timeout");
    });

    it("background: true 原样保留；false 也算显式（不进 defaulted）", () => {
        const r = effectiveBashArgs({ command: "x", background: true }, { bashTimeoutMs: 1 });
        expect(r.args.background).toBe(true);
        expect(r.defaulted).not.toContain("background");
        expect(effectiveBashArgs({ background: false }, {}).defaulted).not.toContain("background");
    });

    it("入参不是对象（流式早期 null / 半截字符串）⇒ 全缺省，不抛", () => {
        for (const bad of [null, undefined, "{\"command\"", 42]) {
            const r = effectiveBashArgs(bad, { bashTimeoutMs: 7 });
            expect(r.args).toEqual({ command: "", timeout: 7, background: false });
            expect(r.defaulted).toEqual(["background", "timeout"]);
        }
    });

    it("command 不是字符串 ⇒ 空串（不把异常对象塞进执行路径）", () => {
        expect(effectiveBashArgs({ command: 123 }, {}).args.command).toBe("");
    });
});
