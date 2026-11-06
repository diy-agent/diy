// tests/core/context-attribution.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 归属（变量落在哪个投递单元）与统计表行折叠的纯函数口径。
//
// 这份逻辑原先住在 ContextLabPage.tsx，只能靠 UI 级探针取证（review2 RV-10）；
// 提出为 shared 纯函数后在这里锁住两件易漂移的事：
//   · 归属三态（unit / container / none）—— 不能把"未投递"谎报成某个单元（RV-01）；
//   · 统计表行折叠（RV-03）与「名单未加载」的守门（RV-13）。
// ##520 起没有 system/runtime 两容器：归属只回答「记在哪一条增量里」。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { allUnits, attributionOf, foldStatRows, unitsFromRules } from "../../src/shared/context/attribution";
import { PLACE_CANDIDATES } from "@diy-agent/context/delivery";

const units = () => new Set(PLACE_CANDIDATES.map((c) => c.path));

describe("attributionOf：归属三态", () => {
    it("单元 / 其后代 → unit，报单元名", () => {
        expect(attributionOf(units(), "chain")).toEqual({ kind: "unit", place: "chain" });
        expect(attributionOf(units(), "chain.0.path")).toEqual({ kind: "unit", place: "chain" });
        expect(attributionOf(units(), "skills")).toEqual({ kind: "unit", place: "skills" });
    });

    it("是若干单元的祖先 → container（子字段分属多个单元）", () => {
        const a = attributionOf(units(), "task");
        expect(a.kind).toBe("container");
        if (a.kind === "container") {
            expect(a.units).toContain("task.title");
            expect(a.units).toContain("task.body");
            expect(a.units).toEqual([...a.units].sort());
        }
    });

    it("既非单元也非单元祖先 → none（未投递），绝不谎报", () => {
        expect(attributionOf(units(), "persona.name")).toEqual({ kind: "none" });
        expect(attributionOf(units(), "task.title.deep")).toEqual({ kind: "unit", place: "task.title" });
    });
});

describe("unitsFromRules / allUnits：单元名单的唯一来源", () => {
    it("unitsFromRules = LabRule[] 里 place 的集合", () => {
        const u = unitsFromRules([{ place: "diy" }, { place: "task.body" }]);
        expect([...u].sort()).toEqual(["diy", "task.body"]);
    });

    it("allUnits = PLACE_CANDIDATES 全集（与真发同一份）", () => {
        const u = allUnits();
        expect(u.size).toBe(PLACE_CANDIDATES.length);
        for (const c of PLACE_CANDIDATES) expect(u.has(c.path), c.path).toBe(true);
    });

    it("空名单 → 所有路径都不归任何单元（不谎报）", () => {
        expect(attributionOf(new Set(), "chain")).toEqual({ kind: "none" });
        expect(attributionOf(new Set(), "task")).toEqual({ kind: "none" });
    });

    it("覆盖最深单元优先（嵌套单元不会被父单元抢走）", () => {
        const u = unitsFromRules([{ place: "task" }, { place: "task.title" }]);
        expect(attributionOf(u, "task.title")).toEqual({ kind: "unit", place: "task.title" });
        expect(attributionOf(u, "task.body")).toEqual({ kind: "unit", place: "task" });
    });

    it("容器 path 展开成其子字段所属单元（不再漏报 → RV-10）", () => {
        const a = attributionOf(units(), "task");
        expect(a.kind === "container" ? a.units : []).toEqual(
            PLACE_CANDIDATES.map((c) => c.path)
                .filter((p) => p.startsWith("task."))
                .sort(),
        );
    });
});

describe("foldStatRows：统计表行粒度（RV-03）", () => {
    const paths = ["task", "task.body", "task.title", "chain", "chain.0", "persona.name"];

    it("中间容器（有后代上榜且非单元）折叠；单元与其后代保留", () => {
        const { rows, collapsed } = foldStatRows(paths, units());
        expect(rows).not.toContain("task");
        expect(rows).toContain("chain");
        expect(rows).toContain("chain.0");
        expect(rows).toContain("persona.name");
        expect(collapsed).toBe(1);
    });

    it("★ 行集只由 path 结构决定（与名单内容无关）；归属随名单变", () => {
        const a = foldStatRows(paths, units());
        const b = foldStatRows(paths, unitsFromRules([{ place: "diy" }]));
        expect(a.rows).toEqual(b.rows);
        expect(attributionOf(units(), "chain")).toEqual({ kind: "unit", place: "chain" });
        expect(attributionOf(unitsFromRules([{ place: "diy" }]), "chain")).toEqual({ kind: "none" });
    });

    it("名单未加载（units 为空）时不折叠 —— 否则会瞬时误折叠单元行（RV-13）", () => {
        expect(foldStatRows(paths, new Set())).toEqual({ rows: paths, collapsed: 0 });
    });
});
