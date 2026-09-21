// src/shared/grid-layout.ts
// 🎯 全局网格布局的**唯一数据模型 + 唯一校验实现**（纯函数，main / renderer / CLI 共用）。
//
// 模型（与 133 设计一致）：每条线贯穿整个容器 —— 不是断头台/BSP。
//   cols[] / rows[]  一维 track 尺寸（全高竖线 / 全宽横线）
//   areas[]          矩形 {id, col, colSpan, row, rowSpan} = 连续格块的并集
// 与 CSS Grid 1:1 映射：cols → grid-template-columns，area → grid-column/row。
//
// 为什么校验独立于渲染：矩形性/重叠/越界 是纯数据问题，写成纯函数才能单测，
// 才能让 CLI `layout set` 在**写入前**拒绝非法输入（而不是等渲染出诡异画面）。

/** track 尺寸：px 固定 / fr 弹性。不用裸 number —— 单位歧义是布局类 bug 的常见来源 */
export type TrackSize = { unit: "px"; value: number } | { unit: "fr"; value: number };

export const px = (value: number): TrackSize => ({ unit: "px", value });
export const fr = (value: number): TrackSize => ({ unit: "fr", value });

/** 一个 viewarea 的几何：矩形区域（col/row 0-based，span 默认 1） */
export interface AreaRect {
  /** 稳定 id 即 public API（CLI / binding / 测试只认它，禁止坐标寻址） */
  id: string;
  col: number;
  colSpan?: number;
  row: number;
  rowSpan?: number;
  /** 最小尺寸（px），拖线 clamp 用；缺省 0 */
  minSize?: number;
}

export interface Layout {
  /** schema 版本：无此字段则用户已存偏好无法迁移 */
  version: number;
  cols: TrackSize[];
  rows: TrackSize[];
  areas: AreaRect[];
}

export const LAYOUT_VERSION = 1;

// ─── 校验 ─────────────────────────────────────────────

export interface LayoutError {
  /** 出错的字段路径（如 "areas[2].col"），便于 CLI 直接回显 */
  path: string;
  msg: string;
}

const isTrack = (t: unknown): t is TrackSize => {
  if (!t || typeof t !== "object") return false;
  const o = t as Partial<TrackSize>;
  if (typeof o.value !== "number" || !Number.isFinite(o.value)) return false;
  if (o.unit === "px") return o.value >= 0; // 0 合法：新增线的初始尺寸就是 0px
  if (o.unit === "fr") return o.value > 0; // 0fr 会退化成不可见，拒绝
  return false;
};

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * 校验布局合法性。返回错误列表（空数组 = 合法）。
 * 覆盖：版本 / track 尺寸 / area id 唯一与非空 / 起止索引越界 / span 合法 / 重叠。
 */
export function validateLayout(layout: unknown): LayoutError[] {
  const errs: LayoutError[] = [];
  if (!layout || typeof layout !== "object") return [{ path: "", msg: "layout 必须是对象" }];
  const l = layout as Partial<Layout>;

  if (!isInt(l.version) || (l.version as number) < 1) {
    errs.push({ path: "version", msg: "version 必须是 >= 1 的整数" });
  }
  if (!Array.isArray(l.cols) || l.cols.length === 0) {
    errs.push({ path: "cols", msg: "cols 必须是非空数组" });
  } else {
    l.cols.forEach((t, i) => {
      if (!isTrack(t)) errs.push({ path: `cols[${i}]`, msg: "非法 track（px 需 >=0，fr 需 >0）" });
    });
  }
  if (!Array.isArray(l.rows) || l.rows.length === 0) {
    errs.push({ path: "rows", msg: "rows 必须是非空数组" });
  } else {
    l.rows.forEach((t, i) => {
      if (!isTrack(t)) errs.push({ path: `rows[${i}]`, msg: "非法 track（px 需 >=0，fr 需 >0）" });
    });
  }
  if (!Array.isArray(l.areas)) {
    errs.push({ path: "areas", msg: "areas 必须是数组" });
    return errs;
  }

  // track 数 = 网格尺寸；非法时后面的越界检查无意义，直接返回
  const nCols = Array.isArray(l.cols) ? l.cols.length : 0;
  const nRows = Array.isArray(l.rows) ? l.rows.length : 0;
  if (nCols === 0 || nRows === 0) return errs;

  const seen = new Set<string>();
  const occupied = new Map<string, string>(); // "col,row" → area id（重叠检测）
  l.areas.forEach((a, i) => {
    const at = (f: string) => `areas[${i}].${f}`;
    if (!a || typeof a !== "object") {
      errs.push({ path: `areas[${i}]`, msg: "必须是对象" });
      return;
    }
    if (typeof a.id !== "string" || a.id.trim() === "") {
      errs.push({ path: at("id"), msg: "id 必须是非空字符串（它是 public API）" });
    } else if (seen.has(a.id)) {
      errs.push({ path: at("id"), msg: `id 重复: ${a.id}` });
    } else {
      seen.add(a.id);
    }
    const colSpan = a.colSpan ?? 1;
    const rowSpan = a.rowSpan ?? 1;
    if (!isInt(a.col) || a.col < 0) errs.push({ path: at("col"), msg: "col 必须是 >= 0 的整数" });
    if (!isInt(a.row) || a.row < 0) errs.push({ path: at("row"), msg: "row 必须是 >= 0 的整数" });
    if (!isInt(colSpan) || colSpan < 1) errs.push({ path: at("colSpan"), msg: "colSpan 必须是 >= 1 的整数" });
    if (!isInt(rowSpan) || rowSpan < 1) errs.push({ path: at("rowSpan"), msg: "rowSpan 必须是 >= 1 的整数" });
    if (a.minSize !== undefined && (!Number.isFinite(a.minSize) || a.minSize < 0)) {
      errs.push({ path: at("minSize"), msg: "minSize 必须是 >= 0 的数" });
    }
    if (!isInt(a.col) || !isInt(a.row) || !isInt(colSpan) || !isInt(rowSpan)) return;
    // 越界：矩形必须完整落在网格内
    if (a.col + colSpan > nCols) {
      errs.push({ path: at("colSpan"), msg: `越界: col(${a.col})+colSpan(${colSpan}) > cols(${nCols})` });
      return;
    }
    if (a.row + rowSpan > nRows) {
      errs.push({ path: at("rowSpan"), msg: `越界: row(${a.row})+rowSpan(${rowSpan}) > rows(${nRows})` });
      return;
    }
    // 重叠：同一格块被两个 area 占 → 渲染时互相压盖，无正确结果可给
    for (let c = a.col; c < a.col + colSpan; c++) {
      for (let r = a.row; r < a.row + rowSpan; r++) {
        const key = `${c},${r}`;
        const owner = occupied.get(key);
        if (owner !== undefined) {
          errs.push({ path: at("id"), msg: `与 area「${owner}」重叠于格子 (${c},${r})` });
          return;
        }
        occupied.set(key, a.id);
      }
    }
  });
  return errs;
}

// ─── 派生工具 ─────────────────────────────────────────

/** 网格总格块数（cols × rows） */
export function cellCount(layout: Layout): number {
  return layout.cols.length * layout.rows.length;
}

/** 未被任何 area 占用的格子（"无主格子"：新增线后腾出来的空位） */
export function unownedCells(layout: Layout): Array<{ col: number; row: number }> {
  const own = new Set<string>();
  for (const a of layout.areas) {
    for (let c = a.col; c < a.col + (a.colSpan ?? 1); c++) {
      for (let r = a.row; r < a.row + (a.rowSpan ?? 1); r++) own.add(`${c},${r}`);
    }
  }
  const out: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < layout.rows.length; r++) {
    for (let c = 0; c < layout.cols.length; c++) {
      if (!own.has(`${c},${r}`)) out.push({ col: c, row: r });
    }
  }
  return out;
}

/** track → CSS 值（px 原样，fr 加单位） */
export function trackCss(t: TrackSize): string {
  return t.unit === "px" ? `${t.value}px` : `${t.value}fr`;
}

/** area → CSS Grid 声明（1:1 映射；CSS 的 line 是 1-based，故 +1） */
export function areaCss(a: AreaRect): { "grid-column": string; "grid-row": string } {
  const colSpan = a.colSpan ?? 1;
  const rowSpan = a.rowSpan ?? 1;
  return {
    "grid-column": `${a.col + 1} / span ${colSpan}`,
    "grid-row": `${a.row + 1} / span ${rowSpan}`,
  };
}

/** 按 id 找 area（契约层只认 id） */
export function findArea(layout: Layout, id: string): AreaRect | undefined {
  return layout.areas.find((a) => a.id === id);
}

/** 某格块的 owner area id（无主返回 undefined） */
export function ownerAt(layout: Layout, col: number, row: number): string | undefined {
  for (const a of layout.areas) {
    const cs = a.colSpan ?? 1;
    const rs = a.rowSpan ?? 1;
    if (col >= a.col && col < a.col + cs && row >= a.row && row < a.row + rs) return a.id;
  }
  return undefined;
}

/** 某 area 占据的 track 索引（去重、升序） */
export function areaTracks(layout: Layout, areaId: string): { cols: number[]; rows: number[] } {
  const a = findArea(layout, areaId);
  if (!a) return { cols: [], rows: [] };
  const cols: number[] = [];
  const rows: number[] = [];
  for (let i = a.col; i < a.col + (a.colSpan ?? 1); i++) cols.push(i);
  for (let j = a.row; j < a.row + (a.rowSpan ?? 1); j++) rows.push(j);
  return { cols, rows };
}

/** 一条可拖的分隔线线段（沿另一轴，从 start 起 span 格） */
export interface LineSegment {
  start: number;
  span: number;
}

/**
 * 竖线 lineIndex（1..cols-1）上**真正可拖**的段：
 * 只取「左右两格 owner 不同」的连续行 —— 被跨列 area 覆盖的段没有分隔可言。
 */
export function colLineSegments(layout: Layout, lineIndex: number): LineSegment[] {
  const out: LineSegment[] = [];
  let run: number | null = null;
  for (let r = 0; r < layout.rows.length; r++) {
    const differs = ownerAt(layout, lineIndex - 1, r) !== ownerAt(layout, lineIndex, r);
    if (differs) {
      if (run === null) run = r;
    } else if (run !== null) {
      out.push({ start: run, span: r - run });
      run = null;
    }
  }
  if (run !== null) out.push({ start: run, span: layout.rows.length - run });
  return out;
}

/** 横线 lineIndex（1..rows-1）上真正可拖的段（上下两格 owner 不同） */
export function rowLineSegments(layout: Layout, lineIndex: number): LineSegment[] {
  const out: LineSegment[] = [];
  let run: number | null = null;
  for (let c = 0; c < layout.cols.length; c++) {
    const differs = ownerAt(layout, c, lineIndex - 1) !== ownerAt(layout, c, lineIndex);
    if (differs) {
      if (run === null) run = c;
    } else if (run !== null) {
      out.push({ start: run, span: c - run });
      run = null;
    }
  }
  if (run !== null) out.push({ start: run, span: layout.cols.length - run });
  return out;
}

/**
 * 哪些 track 可以因「area 被隐藏」而收成 0。
 *
 * 判据（区分「被包含」与「穿过」）：
 *   对 track t 的每一格，其 owner 必须满足
 *     ① 已隐藏（收掉它正是本意），或
 *     ② **穿过** t —— 即在该轴的垂直方向跨了多格（列 track 看 colSpan>1，行 track 看 rowSpan>1），
 *        它的尺寸来自别的 track，收掉 t 不会把它挤没
 *   否则该 track 不可收。
 *
 * 为什么需要 ②：bottom 是跨 3 列的横条，它占着 col0 的 row1。若把它当作「阻碍」，
 * 最小化 left 就永远收不掉 col0（实测踩到）。而 left/right 是 rowSpan 2 的竖条，
 * 它们穿过 row1，故最小化 bottom 能正常收掉 row1。
 *
 * 反面教训（第一版实现）：按「area 碰到的 track 全收」，隐藏 bottom（colSpan 3）
 * 会把三列全归零、隐藏 right 会连带 row0 → 整个网格塌成 0px。
 */
export function collapsibleTracks(layout: Layout, hidden: Set<string>): { cols: number[]; rows: number[] } {
  const areaOf = (id: string | undefined) => (id ? findArea(layout, id) : undefined);

  const cols: number[] = [];
  for (let c = 0; c < layout.cols.length; c++) {
    let ok = true;
    let touched = false;
    for (let r = 0; r < layout.rows.length; r++) {
      const id = ownerAt(layout, c, r);
      if (id === undefined) continue;
      if (hidden.has(id)) { touched = true; continue; }
      const a = areaOf(id);
      if (a && (a.colSpan ?? 1) > 1) continue; // 穿过本列
      ok = false;
      break;
    }
    if (ok && touched) cols.push(c);
  }

  const rows: number[] = [];
  for (let r = 0; r < layout.rows.length; r++) {
    let ok = true;
    let touched = false;
    for (let c = 0; c < layout.cols.length; c++) {
      const id = ownerAt(layout, c, r);
      if (id === undefined) continue;
      if (hidden.has(id)) { touched = true; continue; }
      const a = areaOf(id);
      if (a && (a.rowSpan ?? 1) > 1) continue; // 穿过本行
      ok = false;
      break;
    }
    if (ok && touched) rows.push(r);
  }
  return { cols, rows };
}
