// tests/core/room-delivery-plan.test.ts
// 🎯 忙时发送语义统一（##377 第 27 刀）：**每句话都先落 room**，忙不忙只决定**投递方式**。
//
// 病灶（用户口径「还不能真正使用」+ owner 派的第 27 刀）：
//   任务页有轮次在跑时按 Enter ⇒ 进插话队列（`_su*` 块）、**不落 room**（房间页 / `room get` 查不到）；
//   侧边栏同一句话却进 room 的投递队列（看得见的"排队中"）⇒ 同一动作两个入口两套语义。
//
// 判据（本文件守的就是它）：
//   ① 空闲 ⇒ `turn`（开一轮，拿得到属于这条消息的回复）
//   ② 忙   ⇒ `steer`（插进正在跑的那一轮），且说明是 `note`（**送到了**，只是没有独立回复）
//   ③ `note` 与 `error` 是两件事：`ok + note` 不算失败，徽章文案要读得懂

import { describe, it, expect } from "vitest";
import {
    DeliveryStateSchema,
    STEERED_NOTE,
    deliveryPlanFor,
    deliveryStateText,
} from "../../src/shared/room";

describe("deliveryPlanFor：忙不忙只决定投递方式", () => {
    it("① 空闲 ⇒ 开一轮", () => {
        expect(deliveryPlanFor(false)).toEqual({ kind: "turn" });
    });

    it("② 忙 ⇒ 插进正在跑的那一轮（steer 插话能力不能丢：纠正不该等三分钟）", () => {
        const plan = deliveryPlanFor(true);
        expect(plan.kind).toBe("steer");
        expect(plan.kind === "steer" ? plan.note : "").toBe(STEERED_NOTE);
    });

    it("② 说明是「送到了、方式不同」，不是错误（不许写进 error）", () => {
        expect(STEERED_NOTE).toContain("插入");
        expect(STEERED_NOTE).not.toContain("失败");
        expect(STEERED_NOTE).not.toContain("未投递");
    });
});

describe("投递状态：note（补充说明）与 error（失败）分开", () => {
    const base = { memberId: "agent:main", status: "ok" as const, ts: "2026-10-20T10:00:00.000Z" };

    it("① `ok + note` 能过 schema，且 error 仍缺席（不是失败）", () => {
        const parsed = DeliveryStateSchema.parse({ ...base, note: STEERED_NOTE });
        expect(parsed.note).toBe(STEERED_NOTE);
        expect(parsed.error).toBeUndefined();
        expect(parsed.status).toBe("ok");
    });

    it("② 老数据没有 note 也照常解析（盘上存量 deliveries.jsonl 不迁移）", () => {
        const parsed = DeliveryStateSchema.parse(base);
        expect(parsed.note).toBeUndefined();
        expect(deliveryStateText(parsed)).toBe("已投递");
    });

    it("③ 徽章文案：有 note ⇒ 补一句短标记（「已投递却没有回复」不许看起来像丢了）", () => {
        expect(deliveryStateText({ status: "ok", note: STEERED_NOTE })).toBe("已投递（插进本轮）");
        expect(deliveryStateText({ status: "queued" })).toBe("排队中");
        expect(deliveryStateText({ status: "failed" })).toBe("未投递");
    });
});
