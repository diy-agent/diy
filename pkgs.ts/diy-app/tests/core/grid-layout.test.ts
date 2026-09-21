// tests/core/grid-layout.test.ts — 全局网格布局的数据模型与校验（纯函数）
import { describe, expect, it } from "vitest";
import {
  LAYOUT_VERSION,
  areaCss,
  cellCount,
  findArea,
  fr,
  px,
  trackCss,
  unownedCells,
  validateLayout,
  type Layout,
} from "../../src/shared/grid-layout";

/** 测试用基准：三列布局（detail | chat | agent） */
const threeCol = (): Layout => ({
  version: LAYOUT_VERSION,
  cols: [px(240), fr(1), px(320)],
  rows: [fr(1)],
  areas: [
    { id: "detail", col: 0, row: 0 },
    { id: "chat", col: 1, row: 0 },
    { id: "agent", col: 2, row: 0 },
  ],
});

/** 133 正文里的 6 格示例：4 个 area（A=[0,3] B=[1] C=[2] D=[4,5]） */
const sixCells = (): Layout => ({
  version: LAYOUT_VERSION,
  cols: [px(200), fr(1), px(300)],
  rows: [fr(1), fr(1)],
  areas: [
    { id: "A", col: 0, row: 0, rowSpan: 2 }, // 左上 + 左下
    { id: "B", col: 1, row: 0 },
    { id: "C", col: 2, row: 0 },
    { id: "D", col: 1, row: 1, colSpan: 2 }, // 中下 + 右下
  ],
});

describe("validateLayout — 合法输入", () => {
  it("三列布局通过", () => {
    expect(validateLayout(threeCol())).toEqual([]);
  });

  it("矩形并集（同列相邻行）是合法 area，不必逐格声明", () => {
    expect(validateLayout(sixCells())).toEqual([]);
  });

  it("0px 合法：新增线的初始尺寸就是 0，视觉零变化", () => {
    const l = threeCol();
    l.cols = [px(240), fr(1), px(320), px(0)];
    expect(validateLayout(l)).toEqual([]);
  });

  it("面积缩小的格子保留、腾出的格子无主 —— 不报错", () => {
    const l = threeCol();
    l.cols = [px(240), fr(1), px(0)]; // agent 列缩到 0
    expect(validateLayout(l)).toEqual([]);
    expect(unownedCells(l)).toHaveLength(0); // area 仍在，只是宽 0
  });
});

describe("validateLayout — track 尺寸", () => {
  it("拒绝 0fr（会退化成不可见）", () => {
    const l = threeCol();
    l.cols = [px(240), fr(0), px(320)];
    expect(validateLayout(l).map((e) => e.path)).toContain("cols[1]");
  });

  it("拒绝负 px / NaN", () => {
    const l = threeCol();
    l.cols = [px(-1), fr(1), px(NaN)];
    const paths = validateLayout(l).map((e) => e.path);
    expect(paths).toContain("cols[0]");
    expect(paths).toContain("cols[2]");
  });

  it("拒绝空 cols / rows", () => {
    const l = threeCol();
    l.cols = [];
    l.rows = [];
    const paths = validateLayout(l).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["cols", "rows"]));
  });
});

describe("validateLayout — area 身份", () => {
  it("id 重复报错（id 是 public API，必须唯一）", () => {
    const l = threeCol();
    l.areas[1].id = "detail";
    expect(validateLayout(l).some((e) => e.msg.includes("id 重复"))).toBe(true);
  });

  it("id 为空串报错", () => {
    const l = threeCol();
    l.areas[0].id = "  ";
    expect(validateLayout(l).some((e) => e.path === "areas[0].id")).toBe(true);
  });
});

describe("validateLayout — 几何约束", () => {
  it("越界：col+colSpan 超出 cols 数", () => {
    const l = threeCol();
    l.areas[2] = { id: "agent", col: 2, colSpan: 2, row: 0 };
    expect(validateLayout(l).some((e) => e.msg.includes("越界"))).toBe(true);
  });

  it("重叠：同一格被两个 area 占 → 报出占用者", () => {
    const l = threeCol();
    l.areas[1] = { id: "chat", col: 0, row: 0 }; // 与 detail 抢 col0
    const err = validateLayout(l).find((e) => e.msg.includes("重叠"));
    expect(err?.msg).toContain("detail");
  });

  it("禁止不连续集合：{0,2} 这类表达不出来（网格坐标天然只能矩形）", () => {
    // 用矩形表示法，{0,2} 唯一可能的写法是 col0,rowSpan2 → 那会连 row1 一起占。
    // 这里锁定语义：spans 让 area 恒为矩形，故「不连续」在数据层面不可表达。
    const l: Layout = {
      version: LAYOUT_VERSION,
      cols: [fr(1)],
      rows: [fr(1), fr(1), fr(1)],
      areas: [{ id: "x", col: 0, row: 0, rowSpan: 3 }],
    };
    expect(validateLayout(l)).toEqual([]);
    expect(cellCount(l)).toBe(3);
  });
});

describe("派生工具", () => {
  it("unownedCells 报出新增线腾出的空位", () => {
    const l = threeCol();
    l.cols = [px(240), fr(1), px(320), px(0)];
    l.areas = l.areas.slice(); // 新列未分配 area
    expect(unownedCells(l)).toEqual([{ col: 3, row: 0 }]);
  });

  it("areaCss 与 CSS Grid 1:1（CSS line 是 1-based，故 +1）", () => {
    expect(areaCss({ id: "A", col: 0, row: 0, rowSpan: 2 })).toEqual({
      "grid-column": "1 / span 1",
      "grid-row": "1 / span 2",
    });
    expect(areaCss({ id: "D", col: 1, row: 1, colSpan: 2 })).toEqual({
      "grid-column": "2 / span 2",
      "grid-row": "2 / span 1",
    });
  });

  it("trackCss：px 原样、fr 加单位", () => {
    expect(trackCss(px(240))).toBe("240px");
    expect(trackCss(fr(1))).toBe("1fr");
  });

  it("findArea 按 id 寻址（契约层不认坐标）", () => {
    expect(findArea(threeCol(), "chat")?.col).toBe(1);
    expect(findArea(threeCol(), "nope")).toBeUndefined();
  });
});
