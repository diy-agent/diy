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

/**
 * track → CSS 值。
 *
 * ⚠️ **fr 必须带 `minmax(0, …)` 下界**：CSS 里裸 `1fr` 等价 `minmax(auto, 1fr)`，下界是内容的
 * min-content —— 某个 view 里放一行不可折的长内容（宽表格 / 长代码 / 单行 tool 输出），整列就被
 * 撑到内容宽，合计超出容器，右侧（发送按钮就在那儿）被推出可视区，而容器 `overflow-hidden`
 * 让人以为页面坏了（2026-10-22 实测：容器 984px，列算出 355 + 1589 = 1944）。
 * area 自己已有 `min-w-0`，下界交给它（内部滚动 / 换行）才是正确归属。
 *
 * px 原样 —— 那是固定轨，本就该按声明宽度走。
 */
export function trackCss(t: TrackSize): string {
  return t.unit === "px" ? `${t.value}px` : `minmax(0, ${t.value}fr)`;
}

/**
 * 解析浏览器算出的 `grid-template-columns` / `-rows`（形如 `"355px 1589px 0px"`）为 px 数组。
 *
 * 抽成纯函数是为了能测：拖线起点取自 `getComputedStyle`，加 `minmax()` 之后浏览器仍回 px 序列，
 * 但这条前提值得钉住 —— 它一变拖拽会**静默失效**（parseFloat 拿 NaN、被 filter 掉、长度对不上
 * 就 return，表现是「拖不动」而不是报错）。
 */
export function parseTrackPx(cssValue: string): number[] {
  return cssValue
    .split(/\s+/)
    .map((x) => parseFloat(x))
    .filter((x) => Number.isFinite(x));
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

// ─── CLI 表达：track 串 ↔ TrackSize[] ─────────────────

/**
 * 解析 CLI 的 track 串：逗号分隔，数字 = px，`*` = fr(1)，`Nfr` = fr(N)。
 * 例：`240,*,320` → [px(240), fr(1), px(320)]
 *
 * 为什么让 CLI 用这种简写而不是 JSON：布局数据 1:1 映射 CSS Grid，简写与
 * `grid-template-columns` 的书写方式一致（`240px 1fr 320px` 的逗号版），
 * 手输与断言都短。非法 token 返回 null，由调用方报错（不在解析里造默认值）。
 */
export function parseTracks(spec: string): TrackSize[] | null {
  const out: TrackSize[] = [];
  for (const raw of spec.split(",")) {
    const t = raw.trim();
    if (t === "") return null;
    if (t === "*") {
      out.push(fr(1));
      continue;
    }
    const m = /^(\d+(?:\.\d+)?)(px|fr)?$/.exec(t);
    if (!m) return null;
    const v = Number(m[1]);
    if (!Number.isFinite(v)) return null;
    const unit = m[2] ?? "px"; // 裸数字按 px（布局尺寸的绝大多数写法）
    if (unit === "px" ? v < 0 : v <= 0) return null;
    out.push(unit === "px" ? px(v) : fr(v));
  }
  return out.length > 0 ? out : null;
}

/** track 串的单行回显（get 用；与 parseTracks 互逆） */
export function formatTracks(tracks: TrackSize[]): string {
  return tracks.map((t) => (t.unit === "fr" ? (t.value === 1 ? "*" : `${t.value}fr`) : String(t.value))).join(",");
}

// ─── 有效布局：默认 + 用户覆盖 ─────────────────────────

/** 布局的用户态里，影响几何的部分（layoutStore 的结构子集；避免 shared 依赖 renderer） */
export interface LayoutOverride {
  cols?: TrackSize[];
  rows?: TrackSize[];
  /** areaId → 隐藏 */
  hidden?: Record<string, boolean>;
}

/**
 * 拖线后两侧轨道的新尺寸 —— **单位是身份，拖拽只改尺寸，不换单位**。
 *
 * 为什么（实测账单，##5 2026-10-22）：原实现拖完把两侧都写成 px，于是声明为 `1fr` 的中栏被
 * **固化成当时的绝对 px**（该页存了 `355px 1589px 0px`）。用户缩小窗口时没有任何轨道可让 ⇒
 * 合计 1944px 撑在 984px 容器里，右侧发送按钮被顶出可视区。
 * 「拖过就不再受 fr 重算影响」这个意图是对的（用户就是要这侧更宽）—— 错的是**换了单位**。
 *
 * 规则：
 *   · base 是 px ⇒ 写 px（固定栏就是固定栏）
 *   · base 是 fr ⇒ 写 **fr 权重**，按该轴各 fr 轨此刻的 px 比例分配（相对宽度不丢）
 *     ⇒ 窗口缩放时剩余空间仍按权重重算，不再撑爆
 *
 * 为什么不放在 `resolveLayout` 里做归一（曾经那么写过）：`ui layout set --cols 300,624,0`
 * 是**显式意图**（IDE 式固定宽），归一化会让它静默失效。拖线才是「快照」—— 快照该换算，
 * 声明不该。故修在写入侧：只有拖拽路径会走到本函数。
 *
 * @param renderedPx 该轴**此刻渲染出来的** px 序列（`getComputedStyle` 的 gridTemplate 解析）
 */
export function trackPairAfterDrag(
  baseTracks: TrackSize[],
  renderedPx: number[],
  lineIndex: number,
  next: [number, number],
): [TrackSize, TrackSize] {
  // 该轴只有一条弹性轨时，权重数值没有意义（剩余空间全归它）⇒ 保持原值，别写出 0.85 这种漂移
  const frCount = baseTracks.filter((t) => t.unit === "fr").length;

  const write = (idx: number, pxValue: number): TrackSize => {
    const b = baseTracks[idx];
    if (!b || b.unit === "px") return px(Math.max(0, Math.round(pxValue)));
    // 弹性轨：**按它自己此刻的 px 同比缩放权重**（w' = w · px'/px），尺度不漂：
    //   · 单条弹性轨（其余 px / 0）⇒ 权重恒等于原值，不会被写成 0.85 这种莫名数字
    //   · 多条弹性轨 ⇒ 相对宽度原样保留，窗口缩放仍成立
    // 此刻 px 未知（窗口还没渲染 / 该轨被折叠成 0）⇒ 保持原权重
    const curPx = renderedPx[idx] ?? 0;
    if (frCount <= 1 || curPx <= 0) return fr(b.value);
    const w = (b.value * Math.max(0, pxValue)) / curPx;
    return fr(Math.min(9999, Math.max(0.01, Math.round(w * 100) / 100)));
  };
  return [write(lineIndex - 1, next[0]), write(lineIndex, next[1])];
}

/**
 * 有效布局 = 开发者默认 + 用户 track 覆盖 + 隐藏 area 的 track 归零。
 *
 * 抽到 shared 的原因：渲染（ViewGrid）与 CLI（`ui layout get`）必须算出**同一份**
 * 结果，否则测试断言的布局和界面上的布局是两回事。原先这段逻辑只活在 ViewGrid
 * 的 createMemo 里。
 */
export function resolveLayout(base: Layout, override: LayoutOverride): Layout {
  const cols = override.cols?.length === base.cols.length ? override.cols : base.cols;
  const rows = override.rows?.length === base.rows.length ? override.rows : base.rows;
  const hiddenIds = Object.keys(override.hidden ?? {}).filter((id) => override.hidden![id]);
  if (hiddenIds.length === 0) return { ...base, cols, rows };
  // 只收「该 track 的格子全属已隐藏 area」的那些（见 collapsibleTracks 的教训注释）
  const fold = collapsibleTracks(base, new Set(hiddenIds));
  return { ...base, cols: foldTracks(cols, fold.cols, "col"), rows: foldTracks(rows, fold.rows, "row") };
}

/**
 * 让 track 尺寸**贴合容器**：容器变大/变小时，把差额还/借给最大那条 track。
 *
 * 病（用户 2026-10-23 报的「聊天区变矮、下面一大段空白」）：
 *   拖过线之后两侧 track 都被写成 px（见 setTrackPair 的理由）。之后**容器尺寸一变**
 *   （窗口拉大 / 收起一个 area 让出空间），px 之和就不再等于容器高度 ——
 *   CSS Grid 不会替你填，多出来的部分就是一条死区。实测：`tasks` 页 rows=440px+116px、
 *   容器 836px ⇒ 底部空 280px，聊天区只有 440px。
 *
 * 判据：
 *   · 本轴只要还有一个 fr，剩余空间天然归它 —— 不动（浏览器会算对）；
 *   · 全是 px 才需要修正；差额全给**最大**那条（通常是内容区，面板/侧栏保持原高 ——
 *     这符合用户直觉："窗口变大，该变大的是内容"，而不是把侧栏一起撑开）；
 *   · 目标 track 不低于 `MIN_FIT_TRACK`（拖到下限就再也抓不到线了）。
 */
export const MIN_FIT_TRACK = 48;

export function fitTracks(tracks: readonly TrackSize[], containerPx: number): TrackSize[] {
  if (!(containerPx > 0) || tracks.length === 0) return [...tracks];
  if (tracks.some((t) => t.unit === "fr" && t.value > 0)) return [...tracks];
  const sum = tracks.reduce((a, t) => a + t.value, 0);
  if (sum <= 0) return [...tracks];
  let delta = containerPx - sum;
  if (Math.abs(delta) < 1) return [...tracks];
  const out = tracks.map((t) => ({ ...t }));
  // 从最大值开始吃/还差额（一份差额只该有一个去处，可预测）
  const order = out
    .map((t, i) => ({ i, v: t.value }))
    .sort((a, b) => b.v - a.v)
    .map((x) => x.i);
  for (const i of order) {
    if (Math.abs(delta) < 1) break;
    const cur = out[i]!.value;
    const want = cur + delta;
    const next = Math.max(MIN_FIT_TRACK, want);
    delta -= next - cur;
    out[i] = px(next);
  }
  return out;
}

/**
 * 收起若干 track —— 并把**被收起的尺寸交给邻居**。
 *
 * 为什么不能只把尺寸写 0（##348 ⑤ 的根因）：
 *   本轴只要还有弹性轨（fr），剩余空间天然归它 —— 用户不动线时（默认 `300px 1fr 0px`）
 *   收起左栏不必做任何事。但**拖过线之后**两侧 track 都被写成 px（见 layoutStore.setTrackPair
 *   的理由：拖过就不再受 fr 重算影响），此时收 col0 就是净丢 300px：网格内容只剩 624px、容器
 *   984px ⇒ 中栏右侧空出一条死区，看起来就是「左栏最小化后中栏不扩到全宽」。
 *   故无弹性轨时把这份尺寸交给**同轴最近的未收起邻居**（交给一个而不是均摊：一份尺寸只该有
 *   一个去处，"谁变宽了"才可预测）。方向选「内容区在左上」——列向右找、行向上找。
 */
function foldTracks(tracks: TrackSize[], folded: number[], axis: "col" | "row"): TrackSize[] {
  if (folded.length === 0) return [...tracks];
  const out = [...tracks];
  const dir = axis === "col" ? 1 : -1;
  for (const i of folded) {
    const freed = out[i]!;
    out[i] = px(0);
    // fr 轨本身没有可交的绝对尺寸；本轴还有别的弹性轨时它会吃下剩余空间，不用搬
    if (freed.unit !== "px" || freed.value === 0) continue;
    if (out.some((t) => t.unit === "fr" && t.value > 0)) continue;
    const target = nearestOpenTrack(out, folded, i, dir);
    if (target >= 0) out[target] = px(out[target]!.value + freed.value);
  }
  return out;
}

/** 同轴最近的未收起 track（先偏好方向，没有则反向）；-1 = 全被收起了 */
function nearestOpenTrack(tracks: TrackSize[], folded: number[], from: number, dir: number): number {
  for (const step of [dir, -dir]) {
    for (let i = from + step; i >= 0 && i < tracks.length; i += step) {
      if (!folded.includes(i)) return i;
    }
  }
  return -1;
}
