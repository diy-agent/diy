// tests/core/context-attribution.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 归属（变量落在哪个投递单元）与归因（system 重建由谁引起）的纯函数口径。
//
// 这份逻辑原先住在 ContextLabPage.tsx，只能靠 UI 级探针取证（review2 RV-10）；
// 提出为 shared 纯函数后在这里锁住三件易漂移的事：
//   · 归属三态（unit / container / none）—— 不能把"未投递"谎报成 runtime（RV-01）；
//   · sys 归因用**当轮快照**的划分，与页面当前划分无关（RV-02）；容器行展开成其子字段单元（RV-10）；
//   · 统计表行折叠（RV-03）与"划分别群"的**有意**口径（RV-09）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
    attributionOf,
    foldStatRows,
    sysCauses,
    unitsFromRules,
    unitsFromSystemPlaces,
} from "../../src/shared/context/attribution";
import { PLACE_CANDIDATES } from "../../src/shared/context/delivery";

const DEF_SYS = PLACE_CANDIDATES.filter((c) => c.system).map((c) => c.path);
const units = () => unitsFromRules(PLACE_CANDIDATES.map((c) => ({ place: c.path, container: c.system ? "system" : "runtime" })));

describe("attributionOf：归属三态", () => {
    it("单元 / 其后代 → unit，报单元名 + 容器", () => {
        expect(attributionOf(units(), "chain")).toEqual({ kind: "unit", place: "chain", container: "system" });
        // 叶子收拢到单元（chain.0.path → chain）
        expect(attributionOf(units(), "chain.0.path")).toEqual({ kind: "unit", place: "chain", container: "system" });
        // 非单元路径（task.body 是单元；task.body 的后代仍归它）
        expect(attributionOf(units(), "skills")).toEqual({ kind: "unit", place: "skills", container: "runtime" });
    });

    it("是若干单元的祖先 → container（子字段分属多个单元，不谎报单一容器）", () => {
        const a = attributionOf(units(), "task");
        expect(a.kind).toBe("container");
        if (a.kind === "container") {
            const places = a.units.map((u) => u.place);
            expect(places).toContain("task.title"); // system
            expect(places).toContain("task.body"); // runtime → 横跨两容器
        }
    });

    it("既非单元也非单元祖先 → none（未投递），绝不谎报 runtime", () => {
        expect(attributionOf(units(), "persona.name")).toEqual({ kind: "none" });
    });
});

describe("sysCauses：system 重建的原因（当轮快照划分）", () => {
    it("把变化的叶子收拢到该轮 system 单元", () => {
        expect(sysCauses(["chain.0", "task.body"], ["chain", "diy"])).toEqual(["chain"]);
    });

    it("★ 归因只认当轮快照的 systemPlaces —— 换成页面当前划分不改变历史结论（RV-02）", () => {
        const changed = ["chain.0"];
        const snapshot = ["chain", "diy"];
        const before = sysCauses(changed, snapshot);
        // 用户后来把 chain 移出 system（页面当前划分 = 只留 diy）——历史轮次的归因不该变
        expect(sysCauses(changed, ["diy"])).toEqual([]); // 这是"用当前划分反推"会得到的错答案
        expect(before).toEqual(["chain"]); // 用当轮快照得到的正确答案
    });

    it("容器 path 展开成其子字段所属单元（不再漏报 → RV-10）", () => {
        // 旧实现只做 `changed[i] === place || startsWith(place+".")`：`changed=["task"]`（中间容器）
        // 谁都匹配不上 → 明明 title/state 在 system 变了，却报「无原因」。现在展开成子字段单元。
        expect(sysCauses(["task"], ["chain", "task.title", "task.state"])).toEqual(["task.state", "task.title"]);
        // 子字段全在 runtime 的那轮：容器变化确实不构成 system 重建的原因
        expect(sysCauses(["task"], ["chain"])).toEqual([]);
    });

    it("★ 非值变化引起的空原因：changed 为空、或变化全落在未投递路径（RV-11）", () => {
        expect(sysCauses([], ["chain"])).toEqual([]); // 值没变（说明头/渲染变了）
        expect(sysCauses(["persona.name"], ["chain"])).toEqual([]); // 变化落在未投递路径
        expect(sysCauses(undefined, ["chain"])).toEqual([]); // 坏行/缺 changed
    });

    it("systemPlaces 缺失（undefined）不抛（RV-12 的读侧兜底语义）", () => {
        expect(unitsFromSystemPlaces([]).size).toBe(PLACE_CANDIDATES.length);
    });
});

describe("foldStatRows：统计表行粒度（RV-03）", () => {
    const paths = ["task", "task.body", "task.title", "chain", "chain.0", "persona.name"];

    it("中间容器（有后代上榜且非单元）折叠；单元与其后代保留", () => {
        const { rows, collapsed } = foldStatRows(paths, units());
        expect(rows).not.toContain("task"); // 中间容器：子字段横跨 system/runtime
        expect(rows).toContain("chain"); // 是投递单元 → 即使有后代（chain.0）也不折叠
        expect(rows).toContain("chain.0");
        expect(rows).toContain("persona.name"); // 无后代 → 叶子，保留（归属才显示得出"未投递"）
        expect(collapsed).toBe(1);
    });

    it("★ 归属列随传入划分漂移（有意：统计表按**当前**划分，RV-09）——历史变化本身不受影响", () => {
        const a = foldStatRows(paths, units());
        const b = foldStatRows(paths, unitsFromSystemPlaces(["diy"])); // chain 移出 system
        expect(a.rows).toEqual(b.rows); // 行集不变
        // 但归属（容器）变了 —— 这正是要写清口径的原因
        const ca = attributionOf(units(), "chain");
        const cb = attributionOf(unitsFromSystemPlaces(["diy"]), "chain");
        expect(ca.kind === "unit" && ca.container).toBe("system");
        expect(cb.kind === "unit" && cb.container).toBe("runtime");
    });

    it("划分未加载（units 为空）时不折叠 —— 否则会瞬时误折叠单元行（RV-13）", () => {
        expect(foldStatRows(paths, new Map())).toEqual({ rows: paths, collapsed: 0 });
    });
});

describe("unitsFromSystemPlaces：快照划分 → 单元 map", () => {
    it("名单里的 = system，其余候选 = runtime", () => {
        const u = unitsFromSystemPlaces(["chain"]);
        expect(u.get("chain")).toBe("system");
        expect(u.get("task.body")).toBe("runtime");
        expect(u.size).toBe(PLACE_CANDIDATES.length);
    });

    it("默认名单 = PLACE_CANDIDATES 的推荐（与 defaultSystemPlaces 一致）", () => {
        const u = unitsFromSystemPlaces(DEF_SYS);
        expect(u.get("task.title")).toBe("system");
        expect(u.get("task.body")).toBe("runtime");
    });
});
