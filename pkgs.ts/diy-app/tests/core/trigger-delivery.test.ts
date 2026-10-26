// 触发器投递判据（##408 v2 · 2026-10-26 大王裁）
//
// 三条规则各有现场，逐个钉住：
//   ① N0 是空位 → 设了等同 N1（不报错、不红）
//   ② owner 解析不出 ⇒ 降级 global 信箱，**且不叫醒**（global 不是真任务）
//   ③ N1 不自动补信箱（只认 sinks 里显式写的 inbox）
import { describe, expect, it } from "vitest";
import { GLOBAL_ADDRESS, NO_DELIVERY, planDelivery } from "../../src/shared/trigger-delivery";

const TASK = "projects/4/tasks/408";

describe("planDelivery", () => {
    it("N0 是空位：设了 N0 的效果与 N1 完全一致（不报错、不拒绝）", () => {
        const def = { level: "N0" as const, sinks: ["owner"] };
        expect(planDelivery(def, { owner: TASK })).toEqual(planDelivery({ ...def, level: "N1" }, { owner: TASK }));
        expect(planDelivery(def, { owner: TASK }).wake).toEqual([TASK]);
    });

    it("owner 解析不出 ⇒ 降级 global 信箱，且**不叫醒**（global 不是一条真任务）", () => {
        const plan = planDelivery({ level: "N1", sinks: ["owner", "inbox"] }, {});
        expect(plan.wake).toEqual([]); // 叫醒 global 会开出一条不存在的会话
        expect(plan.inbox).toEqual([GLOBAL_ADDRESS]);
    });

    it("owner 是空串 / 非字符串 ⇒ 同样按「解析不出」处理（不假装有归属）", () => {
        expect(planDelivery({ level: "N1", sinks: ["owner"] }, { owner: "  " }).inbox).toEqual([GLOBAL_ADDRESS]);
        expect(planDelivery({ level: "N1", sinks: ["owner"] }, { owner: 42 }).inbox).toEqual([GLOBAL_ADDRESS]);
    });

    it("N1 叫醒归属任务；不自动补信箱（level#inbox 的自动展开留到真有现场再加）", () => {
        const plan = planDelivery({ level: "N1", sinks: ["owner"] }, { owner: TASK });
        expect(plan.wake).toEqual([TASK]);
        expect(plan.inbox).toEqual([]);
    });

    it("N1 + 显式 inbox sink ⇒ 同一收件人两路（一路叫醒、一路留痕），各一次", () => {
        const plan = planDelivery({ level: "N1", sinks: ["owner", "inbox"] }, { owner: TASK });
        expect(plan.wake).toEqual([TASK]);
        expect(plan.inbox).toEqual([TASK]);
    });

    it("N2 只落信箱（不叫醒）", () => {
        const plan = planDelivery({ level: "N2", sinks: ["owner"] }, { owner: TASK });
        expect(plan.wake).toEqual([]);
        expect(plan.inbox).toEqual([TASK]);
    });

    it("N3 只进 journal：连 UI 都不该动", () => {
        expect(planDelivery({ level: "N3", sinks: ["owner", "ui"] }, { owner: TASK })).toBe(NO_DELIVERY);
    });

    it("ui sink 只置标记，不产生收件人（界面自己重画，不叫人）", () => {
        const plan = planDelivery({ level: "N1", sinks: ["ui"] }, {});
        expect(plan.ui).toBe(true);
        expect(plan.wake).toEqual([]);
        expect(plan.inbox).toEqual([]);
    });

    it("task:<uri> 是显式地址，与 owner 无关", () => {
        const plan = planDelivery({ level: "N1", sinks: ["task:projects/1/tasks/5"] }, { owner: TASK });
        expect(plan.wake).toEqual(["projects/1/tasks/5"]);
    });

    it("逐 sink 只算一个：dispatch 是按 sink 回调的，整条展开会投两遍", () => {
        const def = { level: "N1" as const, sinks: ["owner", "inbox"] };
        const ownerOnly = planDelivery(def, { owner: TASK }, "owner");
        const inboxOnly = planDelivery(def, { owner: TASK }, "inbox");
        expect(ownerOnly.wake).toEqual([TASK]);
        expect(ownerOnly.inbox).toEqual([]);
        expect(inboxOnly.wake).toEqual([]);
        expect(inboxOnly.inbox).toEqual([TASK]);
    });

    it("def sink 尚未接线（watch 落地时才解析）⇒ 不产生任何动作", () => {
        expect(planDelivery({ level: "N2", sinks: ["def"] }, { owner: TASK })).toBe(NO_DELIVERY);
    });
});
