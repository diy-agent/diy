// tests/core/view-plan.test.ts — area 开合 / 最大化的渲染计划（##351 review2 R2 的回归测试）
//
// 为什么测这个：流量页的 viewset 布局改造（左列表 / 右编辑器）此前只有 CDP 肉眼验。
// 把「谁在左、谁在右」「隐藏谁、最大化后剩谁」抽成 shared 纯函数（viewAreaId /
// planPageViews），这里守住的正是这几条**可判定**的判据。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HIDDEN,
  applyHiddenViews,
  areasWithViews,
  defaultBinding,
  findPage,
  planPageViews,
  viewAreaId,
  type AreaOpenState,
} from "../../src/shared/view-registry";

const traffic = () => findPage("traffic")!;
const noState = (): AreaOpenState => ({ hidden: {}, maximized: null });

describe("viewAreaId —— 左右 viewset 的归属判据", () => {
  it("流量页：列表在左、编辑器在右", () => {
    const p = traffic();
    expect(viewAreaId(p, "traffic.list", null)).toBe("left");
    expect(viewAreaId(p, "traffic.detail", null)).toBe("right");
  });

  it("不属于本 page 的 view → null（不编造归属）", () => {
    expect(viewAreaId(traffic(), "chat.local", null)).toBeNull();
    expect(viewAreaId(traffic(), "ghost", null)).toBeNull();
  });

  it("归属与 ctx 无关（global 型：整页一份）", () => {
    expect(viewAreaId(traffic(), "traffic.list", "projects/4/tasks/1")).toBe("left");
  });
});

describe("planPageViews —— 流量页两块的开合 / 最大化", () => {
  it("默认：两块都可见、无最大化、无被挤掉", () => {
    const p = traffic();
    const plan = planPageViews(p, null, defaultBinding(p, null), noState());
    expect(plan.visibleAreaIds).toEqual(["left", "right"]);
    expect(plan.maximizedAreaId).toBeNull();
    expect(plan.suppressedAreaIds).toEqual([]);
  });

  it("最小化右块 → 只剩左（但菜单条仍给右的按钮，否则开不回来）", () => {
    const p = traffic();
    const b = defaultBinding(p, null);
    const plan = planPageViews(p, null, b, { hidden: { right: true }, maximized: null });
    expect(plan.visibleAreaIds).toEqual(["left"]);
    // 菜单条判据不受开合影响：被最小化的 area 仍算"有 view"（唯一开回入口）
    expect([...areasWithViews(p, null, b)].sort()).toEqual(["left", "right"]);
  });

  it("最大化左块 → 右块被挤掉", () => {
    const p = traffic();
    const plan = planPageViews(p, null, defaultBinding(p, null), { hidden: {}, maximized: "left" });
    expect(plan.maximizedAreaId).toBe("left");
    expect(plan.suppressedAreaIds).toEqual(["right"]);
  });

  it("最大化后被最小化 → 退回网格（最大化不能指向看不见的 area）", () => {
    const p = traffic();
    const plan = planPageViews(p, null, defaultBinding(p, null), {
      hidden: { left: true },
      maximized: "left",
    });
    expect(plan.maximizedAreaId).toBeNull();
    expect(plan.visibleAreaIds).toEqual(["right"]);
  });

  it("最大化一个不存在的 area / 无 view 的 area → 退回网格", () => {
    const p = traffic();
    const b = defaultBinding(p, null);
    expect(planPageViews(p, null, b, { hidden: {}, maximized: "ghost" }).maximizedAreaId).toBeNull();
    // 该 area 无 view → 不进可见集，也算不生效
    expect(planPageViews(p, null, b, { hidden: {}, maximized: "right" }).suppressedAreaIds).toEqual(["left"]);
  });

  it("view 级隐藏（binding=null）→ 该 area 空掉，可见集里消失", () => {
    const p = traffic();
    const b = applyHiddenViews(defaultBinding(p, null), { "traffic.detail": true });
    expect(planPageViews(p, null, b, noState()).visibleAreaIds).toEqual(["left"]);
  });

  it("task-run：预留 area（right/bottom）无 view，即便开发者默认收起也不进可见集", () => {
    const p = findPage("task-run")!;
    const ctx = "projects/4/tasks/1";
    const hidden: Record<string, boolean> = {};
    for (const id of DEFAULT_HIDDEN["task-run"] ?? []) hidden[id] = true; // 开发者默认收起 right/bottom
    const plan = planPageViews(p, ctx, defaultBinding(p, ctx), { hidden, maximized: null });
    expect(plan.visibleAreaIds).toEqual(["left", "center"]); // right 上有 view（成员栏），被 DEFAULT_HIDDEN 收起
    // 反向确认：DEFAULT_HIDDEN 确实声明了这两个 area（判据不是"没写才没出来"）
    expect(DEFAULT_HIDDEN["task-run"]).toEqual(["right", "bottom"]);
  });

  it("可见顺序 = layout.areas 声明顺序（几何顺序，与画面一致）", () => {
    const p = findPage("task-run")!;
    const ctx = "projects/4/tasks/1";
    const plan = planPageViews(p, ctx, defaultBinding(p, ctx), { hidden: {}, maximized: "center" });
    // task-run 的四个 area 都有 view（right = 成员栏 ##377；bottom = 作业栏 ##408）
    expect(plan.visibleAreaIds).toEqual(["left", "center", "right", "bottom"]);
    expect(plan.suppressedAreaIds).toEqual(["left", "right", "bottom"]);
  });
});
