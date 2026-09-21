// src/shared/view-registry.ts
// 🎯 view / page 注册表：**view 侧声明 placement，page 不认识任何 view id**（依赖倒置）。
//
// 为什么放 shared 而不是 renderer：
//   这份定义是**纯数据**（id / 标题 / 归属），没有 JSX。放 shared 才能被
//   main 侧校验（CLI `ui view area <id> <area>` 要拒绝不存在的 view 名）、被单测覆盖。
//   渲染组件映射（id → Solid 组件）在 renderer 侧另有一份，见 lib/view-components.tsx。
//
// 与 VSCode 的刻意差异：这里没有 when 表达式、没有运行时求值。
// 静态层（本文件）是代码常量，动态层是用户数据，中间没有表达式引擎。

import { fr, px, type Layout } from "./grid-layout";

/** view 的类型定义（一份代码，不含任何实例状态） */
export interface ViewDef {
  id: string;
  title: string;
  /**
   * 状态归属：
   *  - global  — 单实例（如任务树）
   *  - context — 每个 page 实例一个（如 per-task 的 chat：各持滚动位置/草稿/流式状态）
   */
  instanceScope: "global" | "context";
  /**
   * 能放到哪些 page、默认放哪个 area、同 area 内排序。
   * **加 view 只改这一处**，不必去改任何 page —— 这是依赖倒置的全部收益。
   */
  placement: Record<string, ViewPlacement>;
}

export interface ViewPlacement {
  area: string;
  /** 同 area 内的展示顺序（小在前），缺省 0 */
  order?: number;
}

/** page 定义：一类事情一个全布局。布局是**声明式固定**的，不允许动态 add view */
export interface PageDef {
  id: string;
  title: string;
  /** 是否可多开（任务执行页：每个任务一个实例，等同浏览器 tab） */
  multi?: boolean;
  /** 开发者给的默认布局（用户覆盖是另一层数据） */
  layout: Layout;
}

// ═══════════════════════════════════════════
// view 注册表
// ═══════════════════════════════════════════

export const VIEWS: ViewDef[] = [
  {
    id: "task.tree",
    title: "任务树",
    instanceScope: "global",
    placement: { task: { area: "main", order: 10 } },
  },
  {
    id: "chat.local",
    title: "对话",
    instanceScope: "context", // 每个任务 tab 一个实例
    placement: { "task-run": { area: "center", order: 10 } },
  },
  {
    id: "task.detail",
    title: "任务详情",
    instanceScope: "context",
    placement: { "task-run": { area: "left", order: 10 } },
  },
  {
    // 阶段 1 的试验场整体是一个 view（内部仍是现有三栏）。
    // 将来若要「把预览拖到右侧而不显示 devtools」，再拆成 lab.editor / lab.vars / …
    // 独立 view —— 那时只需改本表与各自 placement，page 侧不动。
    id: "lab.workbench",
    title: "试验场",
    instanceScope: "context",
    placement: { "task-run": { area: "bottom", order: 10 } },
  },
  {
    id: "llm.proxy",
    title: "LLM 代理",
    instanceScope: "global",
    placement: { llm: { area: "main", order: 10 } },
  },
  {
    id: "settings.appinfo",
    title: "状态",
    instanceScope: "global",
    placement: { settings: { area: "main", order: 10 } },
  },
  {
    id: "settings.logs",
    title: "日志",
    instanceScope: "global",
    placement: { settings: { area: "main", order: 20 } },
  },
  {
    id: "settings.theme",
    title: "外观",
    instanceScope: "global",
    placement: { settings: { area: "main", order: 30 } },
  },
];

// ═══════════════════════════════════════════
// page 注册表
// ═══════════════════════════════════════════

/** 任务执行页：左详情 | 中 chat | 右预留 | 底 devtools */
export const TASK_RUN_LAYOUT: Layout = {
  version: 1,
  cols: [px(300), fr(1), px(0)], // 右栏初始 0（预留，未实现）
  rows: [fr(1), px(320)], // 底栏高度；默认收起由 layoutStore 的 hidden 表达（不是把尺寸写 0）
  areas: [
    { id: "left", col: 0, row: 0 },
    { id: "center", col: 1, row: 0 },
    { id: "right", col: 2, row: 0 },
    { id: "bottom", col: 0, row: 1, colSpan: 3 },
  ],
};

/** 各 page 默认隐藏的 area（开发者默认布局的一部分：试验场是 devtools，默认不占地方） */
export const DEFAULT_HIDDEN: Record<string, string[]> = {
  "task-run": ["right", "bottom"],
};

export const PAGES: PageDef[] = [
  {
    id: "task",
    title: "任务",
    layout: {
      version: 1,
      cols: [fr(1)],
      rows: [fr(1)],
      areas: [{ id: "main", col: 0, row: 0 }],
    },
  },
  {
    id: "task-run",
    title: "任务执行",
    multi: true, // 每个任务一个实例
    layout: TASK_RUN_LAYOUT,
  },
  {
    id: "llm",
    title: "LLM",
    layout: {
      version: 1,
      cols: [fr(1)],
      rows: [fr(1)],
      areas: [{ id: "main", col: 0, row: 0 }],
    },
  },
  {
    id: "settings",
    title: "设置",
    layout: {
      version: 1,
      cols: [fr(1)],
      rows: [fr(1)],
      areas: [{ id: "main", col: 0, row: 0 }],
    },
  },
];

export function findPage(id: string): PageDef | undefined {
  return PAGES.find((p) => p.id === id);
}

export function findView(id: string): ViewDef | undefined {
  return VIEWS.find((v) => v.id === id);
}

// ═══════════════════════════════════════════
// view 实例键 与 binding
// ═══════════════════════════════════════════

/**
 * view 实例键。
 * global  → view id 本身
 * context → `viewId@上下文键`（上下文键由 **page 实例**提供，如任务 URI）
 */
export function viewInstanceKey(def: ViewDef, ctx: string | null): string {
  return def.instanceScope === "context" ? `${def.id}@${ctx ?? ""}` : def.id;
}

/** view 实例键 → 所在 area（null = 隐藏）。binding 独立成层，即使现在固定不动 */
export type Binding = Record<string, string | null>;

/**
 * 由 view 注册表推出某 page（实例）的默认 binding。
 * 这是「静态层」到「动态层」的唯一桥：之后用户改动只动 Binding，不碰注册表。
 */
export function defaultBinding(page: PageDef, ctx: string | null, views: ViewDef[] = VIEWS): Binding {
  const b: Binding = {};
  for (const def of views) {
    const place = def.placement[page.id];
    if (!place) continue; // 该 view 不允许进本 page（page 白名单效果由 placement 承担）
    b[viewInstanceKey(def, ctx)] = place.area;
  }
  return b;
}

/** 某 view（实例）在本 page 的排序值 */
export function placementOrder(def: ViewDef, pageId: string): number {
  return def.placement[pageId]?.order ?? 0;
}

// ═══════════════════════════════════════════
// 按 area 分组（渲染入口：layout + binding → 实际要画什么）
// ═══════════════════════════════════════════

export interface AreaGroup {
  areaId: string;
  /** 该 area 内的 view，已按 order 排序 */
  views: ViewDef[];
}

/**
 * 把本 page 的 view 按 area 分组，供渲染层直接消费。
 *
 * 三处关键语义：
 *  1. binding[key] === null → **隐藏**（被删 area 的 view 走这条路：保留实例，不销毁重建）
 *  2. binding 未记录的 key → 用 placement 的默认 area
 *  3. 输出顺序 = layout.areas 的声明顺序（几何顺序），area 内按 order —— 与视觉一致
 */
export function groupViewsByArea(
  page: PageDef,
  ctx: string | null,
  binding: Binding,
  views: ViewDef[] = VIEWS,
): AreaGroup[] {
  const groups = new Map<string, ViewDef[]>();
  for (const def of views) {
    const place = def.placement[page.id];
    if (!place) continue; // 不允许进本 page
    const key = viewInstanceKey(def, ctx);
    const areaId = binding[key] === undefined ? place.area : binding[key];
    if (areaId === null) continue; // 显式隐藏
    if (!page.layout.areas.some((a) => a.id === areaId)) continue; // 防御：area 已不存在
    const list = groups.get(areaId) ?? [];
    list.push(def);
    groups.set(areaId, list);
  }
  return page.layout.areas
    .filter((a) => groups.has(a.id))
    .map((a) => ({
      areaId: a.id,
      views: [...groups.get(a.id)!].sort(
        (x, y) => placementOrder(x, page.id) - placementOrder(y, page.id),
      ),
    }));
}

// ═══════════════════════════════════════════
// 校验（纯函数，可单测 / 可被 CLI 调用）
// ═══════════════════════════════════════════

export interface RegistryError {
  path: string;
  msg: string;
}

/**
 * 校验注册表自洽：id 唯一、placement 指向存在的 page、area 存在于该 page 的 layout。
 * 依赖倒置的代价是「写错 view 名/area 名不会有类型错误」——故用本函数在单测里兜住。
 */
export function validateRegistry(
  views: ViewDef[] = VIEWS,
  pages: PageDef[] = PAGES,
): RegistryError[] {
  const errs: RegistryError[] = [];
  const viewIds = new Set<string>();

  views.forEach((v, i) => {
    const at = (f: string) => `views[${i}].${f}`;
    if (!v.id || v.id.trim() === "") errs.push({ path: at("id"), msg: "id 必须非空" });
    else if (viewIds.has(v.id)) errs.push({ path: at("id"), msg: `id 重复: ${v.id}` });
    else viewIds.add(v.id);
    if (v.instanceScope !== "global" && v.instanceScope !== "context") {
      errs.push({ path: at("instanceScope"), msg: "必须是 global 或 context" });
    }
    for (const [pageId, place] of Object.entries(v.placement ?? {})) {
      const page = pages.find((p) => p.id === pageId);
      if (!page) {
        errs.push({ path: at(`placement.${pageId}`), msg: `page 不存在: ${pageId}` });
        continue;
      }
      const area = page.layout.areas.find((a) => a.id === place.area);
      if (!area) {
        errs.push({
          path: at(`placement.${pageId}.area`),
          msg: `area「${place.area}」不存在于 page「${pageId}」的 layout`,
        });
      }
    }
  });

  // page 级：view 的 placement 里出现未知 page 已在上面覆盖；
  // 这里检查同一 page 内没有重名 area（renderer 按 id 分组渲染，重名会互相覆盖）
  pages.forEach((p, i) => {
    const seen = new Set<string>();
    for (const a of p.layout.areas) {
      if (seen.has(a.id)) errs.push({ path: `pages[${i}].layout.areas`, msg: `area id 重复: ${a.id}` });
      seen.add(a.id);
    }
  });

  return errs;
}
