// tests/core/user-stamp.test.ts — 「用户这句话是什么时候说的」（##331 ②）
//
// 判据全是**不许编**的纪律：ops 没有 ts 字段，唯一时间真源是 turnId 内嵌毫秒，
// 而三种 user 块（轮首 / 轮首批量 / 插话）的精确度不同 —— 插话只能给"所在轮起点"，
// 且必须 self-declare（exact=false）。旧日志解析不出就不显示，绝不用渲染时刻顶替。
import { describe, expect, it } from "vitest";
import { turnIdOfUserBlock, userStamp } from "../../src/renderer_solid/lib/user-stamp";
import { fmtTurnStamp } from "../../src/shared/date-format";

const T = "t1791126774555"; // t + 13 位毫秒（main 造轮 id 的形状）

describe("turnIdOfUserBlock：块 id → 所属轮", () => {
    it("轮首 / 轮首批量 / 插话三种 user 块都认；assistant 块不认", () => {
        expect(turnIdOfUserBlock(`${T}_u`)).toBe(T);
        expect(turnIdOfUserBlock(`${T}_u2`)).toBe(T);
        expect(turnIdOfUserBlock(`${T}_su3`)).toBe(T);
        expect(turnIdOfUserBlock(`${T}_s1_a`)).toBeNull(); // assistant 正文，不是 user 块
    });

    it("形状不认识（旧日志 / 改名前的 id）→ null，不猜", () => {
        expect(turnIdOfUserBlock("u1")).toBeNull();
        expect(turnIdOfUserBlock("t123_u")).toBeNull(); // 毫秒位数不对
        expect(turnIdOfUserBlock(T)).toBeNull();
        expect(turnIdOfUserBlock(undefined)).toBeNull();
        expect(turnIdOfUserBlock(null)).toBeNull();
    });
});

describe("userStamp：给 user 发言的时刻（复用 agent 侧的格式化）", () => {
    it("轮首 user：就是发送时刻（exact=true），文案与 agent 侧同源", () => {
        const s = userStamp(`${T}_u`)!;
        expect(s.exact).toBe(true);
        expect(s.text).toBe(fmtTurnStamp(T)); // **同一个函数**，不是另写一份格式化
        expect(s.text).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
        expect(s.title).toContain(T);
    });

    it("插话 user：只有**所在轮起点**可用 ⇒ exact=false，且 title 说清这一点", () => {
        const s = userStamp(`${T}_su1`)!;
        expect(s.exact).toBe(false);
        expect(s.text).toBe(userStamp(`${T}_u`)!.text); // 同一轮 = 同一个数（不编第二个时刻）
        expect(s.title).toContain("插话");
        expect(s.title).toContain("所在轮的起点");
    });

    it("解析不出 → null（宁可没有时间，也不显示假时刻）", () => {
        expect(userStamp("u1")).toBeNull();
        expect(userStamp(`${T}_s1_a`)).toBeNull();
    });
});
