// tests/core/layout-metrics.test.ts
// 🎯 聊天输入区封顶口径（任务 257 R5）：唯一入口是 `chatInputMaxHeight`。
//
// 为什么单独测这个纯函数：它的**唯一分支**（view 高度还没量到时兜 `33vh`）在 UI 里
// 只活一帧，意图测试抓不住；而这一支写错（返回空串/NaN）的后果是"封顶失效、
// 长文本把对话区挤没"—— 静默且难看。放纯函数里可以直接钉住。
import { describe, it, expect } from "vitest";
import { chatInputMaxHeight } from "../../src/renderer_solid/lib/layout-metrics";

describe("聊天输入区封顶高度（view 1/3）", () => {
    it("已量到 view 高度 → 其 1/3（四舍五入取整 px）", () => {
        expect(chatInputMaxHeight(683)).toBe("228px");
        expect(chatInputMaxHeight(651)).toBe("217px");
        expect(chatInputMaxHeight(900)).toBe("300px");
    });

    it("带小数的高度按四舍五入（clientHeight 取整后的产物不该出现 .333px）", () => {
        expect(chatInputMaxHeight(683.4)).toBe("228px");
        // 1/3 无整数解时四舍五入，不能出现 "233.33333333333334px" 这种值
        expect(chatInputMaxHeight(700)).toBe("233px");
    });

    it("未量到（0 / 负）→ 兜 33vh，绝不返回空串（空串 = 不封顶）", () => {
        for (const v of [0, -1, Number.NaN]) {
            expect(chatInputMaxHeight(v)).toBe("33vh");
        }
    });
});
