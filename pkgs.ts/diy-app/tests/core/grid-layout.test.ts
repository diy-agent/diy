// tests/core/grid-layout.test.ts — 全局网格布局的数据模型与校验（纯函数）
import { describe, expect, it } from "vitest";
import {
  LAYOUT_VERSION,
  areaCss,
  areaTracks,
  cellCount,
  colLineSegments,
  collapsibleTracks,
  findArea,
  ownerAt,
  rowLineSegments,
  formatTracks,
  fr,
  parseTracks,
  px,
  resolveLayout,
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

describe("track 归属与可拖线段", () => {
  const L = sixCells(); // A=[0,3] B=[1] C=[2] D=[4,5]（col0/col1/col2 × row0/row1）

  it("ownerAt 按矩形找归属", () => {
    expect(ownerAt(L, 0, 0)).toBe("A");
    expect(ownerAt(L, 0, 1)).toBe("A");
    expect(ownerAt(L, 1, 0)).toBe("B");
    expect(ownerAt(L, 2, 1)).toBe("D");
    expect(ownerAt(L, 5, 5)).toBeUndefined();
  });

  it("竖线线段：只取两侧 owner 不同的行（被跨列 area 覆盖的段不可拖）", () => {
    // 竖线 1（col0|col1）：row0 A≠B 可拖；row1 A≠D 可拖 → 整条
    expect(colLineSegments(L, 1)).toEqual([{ start: 0, span: 2 }]);
    // 竖线 2（col1|col2）：row0 B≠C 可拖；row1 D=D（D 跨 col1+col2）不可拖 → 只有上半段
    expect(colLineSegments(L, 2)).toEqual([{ start: 0, span: 1 }]);
  });

  it("横线线段：只取上下 owner 不同的列", () => {
    // 横线 1（row0|row1）：col0 A=A 不可拖；col1 B≠D 可拖；col2 C≠D 可拖 → 右两列
    expect(rowLineSegments(L, 1)).toEqual([{ start: 1, span: 2 }]);
  });

  it("areaTracks 给出 area 占据的 track 索引", () => {
    expect(areaTracks(L, "A")).toEqual({ cols: [0], rows: [0, 1] });
    expect(areaTracks(L, "D")).toEqual({ cols: [1, 2], rows: [1] });
  });
});

describe("collapsibleTracks —— 隐藏 area 时哪些 track 能收（实测踩过的坑）", () => {
  /** 真实的任务执行页布局：左/中/右 三列 + 底部横条（跨 3 列） */
  const bar: Layout = {
    version: LAYOUT_VERSION,
    cols: [px(300), fr(1), px(0)],
    rows: [fr(1), px(320)],
    areas: [
      { id: "left", col: 0, row: 0 },
      { id: "center", col: 1, row: 0 },
      { id: "right", col: 2, row: 0 },
      { id: "bottom", col: 0, row: 1, colSpan: 3 },
    ],
  };

  it("默认隐藏 right + bottom → 只收 col2 与 row1", () => {
    // 反面教训：按「area 碰到的 track 全收」会把三列一起归零（网格塌成 0px）
    expect(collapsibleTracks(bar, new Set(["right", "bottom"]))).toEqual({ cols: [2], rows: [1] });
  });

  it("最小化 left → 收 col0：bottom 跨 3 列属「穿过」，不算阻碍（col2 上还有可见的 right，故不收）", () => {
    expect(collapsibleTracks(bar, new Set(["left", "bottom"]))).toEqual({ cols: [0], rows: [1] });
    // 再把 right 也隐藏 → col2 才跟着收
    expect(collapsibleTracks(bar, new Set(["left", "right", "bottom"]))).toEqual({
      cols: [0, 2],
      rows: [1],
    });
  });

  it("最小化 center → 收 col1", () => {
    expect(collapsibleTracks(bar, new Set(["center", "bottom"]))).toEqual({ cols: [1], rows: [1] });
  });

  it("只隐藏 bottom（三列都可见）→ 只收 row1，三列不动", () => {
    expect(collapsibleTracks(bar, new Set(["bottom"]))).toEqual({ cols: [], rows: [1] });
  });

  it("只隐藏 left（bottom 可见）→ 收 col0", () => {
    expect(collapsibleTracks(bar, new Set(["left"]))).toEqual({ cols: [0], rows: [] });
  });

  it("rowSpan 2 的竖条穿过 row1：隐藏 bottom 仍能收 row1（VSCode 式布局）", () => {
    const vscode: Layout = {
      version: LAYOUT_VERSION,
      cols: [px(300), fr(1), px(0)],
      rows: [fr(1), px(320)],
      areas: [
        { id: "left", col: 0, row: 0, rowSpan: 2 },
        { id: "center", col: 1, row: 0 },
        { id: "right", col: 2, row: 0, rowSpan: 2 },
        { id: "bottom", col: 1, row: 1 },
      ],
    };
    expect(collapsibleTracks(vscode, new Set(["bottom"]))).toEqual({ cols: [], rows: [1] });
    expect(collapsibleTracks(vscode, new Set(["left"]))).toEqual({ cols: [0], rows: [] });
  });

  it("无隐藏 → 一个都不收", () => {
    expect(collapsibleTracks(bar, new Set())).toEqual({ cols: [], rows: [] });
  });
});

// ═══════════════════════════════════════════
// CLI 表达：track 串 ↔ TrackSize[]
//   `ui layout set --cols 240,*,320` 是第一种测试能力（CLI 操纵 UI 状态）的入口，
//   故解析/回显必须严格：非法 token 一律 null，不造默认值。
// ═══════════════════════════════════════════

describe("parseTracks", () => {
  it("数字=px，*=fr(1)，裸数字与 px 等价", () => {
    expect(parseTracks("240,*,320")).toEqual([px(240), fr(1), px(320)]);
    expect(parseTracks("240px,320px")).toEqual([px(240), px(320)]);
  });

  it("显式 fr 值（2fr）", () => {
    expect(parseTracks("240,2fr")).toEqual([px(240), fr(2)]);
  });

  it("允许 0px（新增线的初始尺寸就是 0）与空格", () => {
    expect(parseTracks("0, 1fr , 200")).toEqual([px(0), fr(1), px(200)]);
  });

  it("非法 token → null（不静默退化）", () => {
    for (const bad of ["", " ", "abc", "240,", ",240", "-5", "0fr", "-1fr", "240,,320", "1e3"]) {
      expect(parseTracks(bad), bad).toBeNull();
    }
  });

  it("formatTracks 与 parseTracks 互逆", () => {
    for (const spec of ["240,*,320", "0,1fr,200", "300,2fr"]) {
      expect(formatTracks(parseTracks(spec)!)).toBe(spec.replace("1fr", "*"));
    }
  });
});

// ═══════════════════════════════════════════
// resolveLayout —— 有效布局（渲染与 CLI 必须同源）
// ═══════════════════════════════════════════

describe("resolveLayout", () => {
  const base = () => threeCol();

  it("无覆盖 → 与原布局等值（不共享可变数组）", () => {
    const out = resolveLayout(base(), {});
    expect(out.cols).toEqual([px(240), fr(1), px(320)]);
    expect(out.cols).not.toBe(base().cols);
  });

  it("用户 track 覆盖生效；长度不符则忽略（防脏数据）", () => {
    const out = resolveLayout(base(), { cols: [px(100), px(200), px(300)] });
    expect(out.cols).toEqual([px(100), px(200), px(300)]);
    const bad = resolveLayout(base(), { cols: [px(100)] });
    expect(bad.cols).toEqual([px(240), fr(1), px(320)]);
  });

  it("隐藏 area → 其独占 track 归零（穿过它的 track 不受影响）", () => {
    const l: Layout = {
      version: LAYOUT_VERSION,
      cols: [px(200), fr(1), px(300)],
      rows: [fr(1), px(200)],
      areas: [
        { id: "left", col: 0, row: 0, rowSpan: 2 },
        { id: "center", col: 1, row: 0 },
        { id: "right", col: 2, row: 0, rowSpan: 2 },
        { id: "bottom", col: 1, row: 1 },
      ],
    };
    const out = resolveLayout(l, { hidden: { left: true } });
    expect(out.cols[0]).toEqual(px(0)); // left 独占 col0
    expect(out.cols[1]).toEqual(fr(1)); // center / bottom 还在
  });

  it("没有任何隐藏 → 尺寸原样（不误触归零）", () => {
    const out = resolveLayout(base(), { hidden: { detail: false } });
    expect(out.cols).toEqual([px(240), fr(1), px(320)]);
  });
});
