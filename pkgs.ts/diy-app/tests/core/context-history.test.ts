// tests/core/context-history.test.ts
// 🎯 上下文「变更」历史（任务 148）：只记**有变化**的 step，并区分两个容器。
//
// 关键行为（对应 144 的投递规则落到 UI）：
//   · 内容未变 → 不新增 step（"内容未变不发"）
//   · system 是全量重建，runtime 是增量 patch —— 变化落在哪一份要能分辨
//   · 值没变但投递范围变了（用户改 system 名单）也算一次变化

import { describe, it, expect } from "vitest";
import { emptyHistory, record, diffStat, type StepSnapshot } from "../../src/shared/context/history";

const snap = (over: Partial<StepSnapshot> = {}): StepSnapshot => ({
  valueHashes: { "diy.cli": "h1", "task.body": "h2" },
  systemText: "diy:\n  cli: /repo/diy.sh",
  systemPlaces: ["diy"],
  runtimeText: "task:\n  body: |\n    旧",
  runtimePlaces: ["task.body"],
  ...over,
});

describe("变更历史", () => {
  it("第一次记录只作基线，不产生 step", () => {
    const h = record(emptyHistory(), snap(), "2026-09-25T00:00:00Z");
    expect(h.baseline).not.toBeNull();
    expect(h.steps).toEqual([]);
  });

  it("内容完全一致 → 不新增 step", () => {
    let h = record(emptyHistory(), snap(), "t0");
    h = record(h, snap(), "t1");
    h = record(h, snap(), "t2");
    expect(h.steps).toEqual([]);
  });

  it("值变化 → 记一次，并指出落在哪个容器", () => {
    let h = record(emptyHistory(), snap(), "t0");
    h = record(
      h,
      snap({ valueHashes: { "diy.cli": "h1", "task.body": "h9" }, runtimeText: "task:\n  body: |\n    新" }),
      "t1",
    );
    expect(h.steps).toHaveLength(1);
    const st = h.steps[0]!;
    expect(st.changed).toEqual(["task.body"]);
    expect(st.runtimeTouched).toEqual(["task.body"]);
    expect(st.systemTouched).toEqual([]);
    expect(st.runtimeDiffers).toBe(true);
    expect(st.systemDiffers).toBe(false);
    expect(diffStat(st.runtimeDiff).add).toBe(1);
    expect(diffStat(st.runtimeDiff).del).toBe(1);
  });

  it("system 份的变化被识别为 system 侧", () => {
    let h = record(emptyHistory(), snap(), "t0");
    h = record(
      h,
      snap({ valueHashes: { "diy.cli": "hX", "task.body": "h2" }, systemText: "diy:\n  cli: /other" }),
      "t1",
    );
    const st = h.steps[0]!;
    expect(st.changed).toEqual(["diy.cli"]);
    expect(st.systemTouched).toEqual(["diy.cli"]);
    expect(st.systemDiffers).toBe(true);
    expect(st.runtimeDiffers).toBe(false);
  });

  it("值没变但投递范围变了（改 system 名单）也算一次变化", () => {
    let h = record(emptyHistory(), snap(), "t0");
    h = record(
      h,
      snap({
        systemPlaces: ["diy", "task.body"],
        runtimePlaces: [],
        systemText: "diy:\n  cli: x\ntask:\n  body: |\n    旧",
        runtimeText: "",
      }),
      "t1",
    );
    expect(h.steps).toHaveLength(1);
    expect(h.steps[0]!.changed).toEqual([]);
    expect(h.steps[0]!.systemDiffers).toBe(true);
  });

  it("多次变化按序累积，index 从 1 递增", () => {
    let h = record(emptyHistory(), snap(), "t0");
    h = record(h, snap({ valueHashes: { "diy.cli": "a", "task.body": "h2" } }), "t1");
    h = record(h, snap({ valueHashes: { "diy.cli": "a", "task.body": "b" } }), "t2");
    expect(h.steps.map((s) => s.index)).toEqual([1, 2]);
  });

  it("每个 step 都带着当时的完整快照（选中该步可回看）", () => {
    let h = record(emptyHistory(), snap(), "t0");
    h = record(h, snap({ valueHashes: { "diy.cli": "changed", "task.body": "h2" } }), "t1");
    expect(h.steps[0]!.snapshot.valueHashes["diy.cli"]).toBe("changed");
  });
});
