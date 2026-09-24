// src/shared/tab-order.ts
// 🎯 打开列表的**排序与缩进**规则（纯函数，可单测）。
//
// 为什么独立成文件：侧栏要同时表达**两套层次**，而它们的判据完全不同 ——
//   ① 页面层次：lab 挂在 task-run 之下（PageDef.parentPage）→ 子页面紧跟父之后
//   ② 任务层次：a/b/c 是 a 的子任务 → 同链相邻、子任务缩进
// 原先只有 ① 被表达（`t.parent`），于是「先开 a/b/c 再开 a」在侧栏里是两个
// 平级 tab，看不出关系。本文件把两套规则写在一起，并保证**缩进有排序兜底**：
// 缩进若不能配相邻，那缩进就是在撒谎（子 tab 上面坐着的不是它的父）。
//
// 依赖方向：本文件只认数据（TabLike + 祖先链），不 import 任何 store ——
// taskStore 与 tabStore 都不依赖对方，祖先链由调用方算好传进来。

export interface TabLike {
  /** 唯一键：`<pageId>:<ctx>` */
  key: string;
  pageId: string;
  /** 上下文键（任务 URI） */
  ctx: string | null;
  /** 父 tab 的 key（**页面**层次：子页面挂靠，关父连带关子） */
  parent?: string;
  /** 任务祖先链（**任务**层次：不含自己，从根到直接父）。无 = 顶级任务或非任务 tab */
  taskAncestors?: string[];
}

/** 某 tab 在本 page 里的父键（页面层次）。显式 parent 优先，否则由注册表 parentPage 推 */
export function pageParentKeyOf(
  item: TabLike,
  parentPageOf: (pageId: string) => string | undefined,
): string | undefined {
  if (item.parent) return item.parent;
  const pp = parentPageOf(item.pageId);
  return pp ? `${pp}:${item.ctx ?? ""}` : undefined;
}

/**
 * 某 tab 的**任务缩进层级** = 打开列表里存在的祖先任务个数。
 *
 * 只在「祖先也开着」时缩进：祖先没开却缩进，视觉上会指向一个不存在的父。
 * 层级用**计数**而非任务树深度：侧栏是扁平列表，缩进表达的是「相对已开项」的
 * 从属关系，不是绝对深度（绝对深度会让两个不同分支的兄弟缩进不同，看着更乱）。
 */
export function taskIndentOf(item: TabLike, opened: TabLike[]): number {
  const openCtx = new Set(opened.map((t) => t.ctx).filter((c): c is string => !!c));
  return (item.taskAncestors ?? []).filter((a) => openCtx.has(a)).length;
}

/**
 * 新 tab 应插入的下标（**排序规则的唯一实现**）。
 *
 * 优先级：
 *   ① 页面子页面 → 插到父「及其已有关联子页面」之后（父子不被别的 tab 隔开）
 *   ② 任务**祖先**已在列表里 → 插到它这一族之后
 *   ③ 任务**后代**已在列表里（我才是父）→ 插到最靠前的那个后代**之前**
 *   ④ 都不适用 → 队尾
 *
 * ② ③ 必须都做，因为关系是双向的：
 *   - 先开 a 再开 a/b/c：a/b/c 有祖先 a → 走 ②
 *   - **先开 a/b/c 再开 a：a 没有祖先，但 a 是 a/b/c 的祖先 → 走 ③**
 * 只做 ② 的话后者会追加到队尾，a 与 a/b/c 隔着别的 tab，缩进就没法表达
 * （这正是用户报的场景，第一版实现漏了）。
 */
export function insertionIndex(
  item: TabLike,
  opened: TabLike[],
  parentPageOf: (pageId: string) => string | undefined,
): number {
  // ① 页面层次：子页面插父之后
  const pageParent = pageParentKeyOf(item, parentPageOf);
  if (pageParent) {
    const i = opened.findIndex((t) => t.key === pageParent);
    if (i >= 0) return endOfFamily(opened, i, (t) => t.parent === pageParent);
  }

  // ② 任务层次（我是子）：找**最近的**已打开祖先，插到它这一族之后
  const ancestors = item.taskAncestors ?? [];
  for (let k = ancestors.length - 1; k >= 0; k--) {
    const ancUri = ancestors[k]!;
    const i = opened.findIndex((t) => t.ctx === ancUri);
    if (i < 0) continue;
    return endOfFamily(opened, i, (t) => (t.taskAncestors ?? []).includes(ancUri));
  }

  // ③ 任务层次（我是父）：已开项里有我的后代 → 插到最靠前那个后代之前
  if (item.ctx) {
    const myUri = item.ctx;
    const first = opened.findIndex((t) => (t.taskAncestors ?? []).includes(myUri));
    if (first >= 0) return first;
  }

  return opened.length;
}

/** 从下标 i 起，跨过所有满足 sameFamily 的连续项，返回该族之后的下标 */
function endOfFamily(opened: TabLike[], i: number, sameFamily: (t: TabLike) => boolean): number {
  let j = i + 1;
  while (j < opened.length && sameFamily(opened[j]!)) j++;
  return j;
}

/**
 * 按「族」重排整个列表：保证每条父子链相邻，且父在子之前。
 *
 * 为什么需要（不只是插入时算位置）：插入位置只管新来的那一个，历史数据
 * （旧版本存下的顺序、或先开子后开父的既有列表）仍可能是散的。启动时跑一遍
 * 本函数，把列表规范成「父在前、同族相邻」—— 缩进才始终说真话。
 *
 * 稳定：同族内保持原相对顺序（用户手动调过的顺序不被搅乱）。
 */
export function normalizeOrder(
  opened: TabLike[],
  parentPageOf: (pageId: string) => string | undefined,
): TabLike[] {
  const out: TabLike[] = [];
  const placed = new Set<string>();
  const byKey = new Map(opened.map((t) => [t.key, t]));

  /** 深度优先：先放自己，再放自己的后代（页面子页面 + 任务子任务） */
  const emit = (t: TabLike) => {
    if (placed.has(t.key)) return;
    placed.add(t.key);
    out.push(t);
    // 后代顺序 = 原列表顺序（稳定）
    for (const c of opened) {
      if (placed.has(c.key)) continue;
      if (isChildOf(c, t, parentPageOf, byKey)) emit(c);
    }
  };

  // 根 = 没有父在列表里的项（按原顺序）
  for (const t of opened) {
    const pageParent = pageParentKeyOf(t, parentPageOf);
    const hasPageParent = !!pageParent && byKey.has(pageParent);
    const hasTaskAncestor = (t.taskAncestors ?? []).some((a) => opened.some((o) => o.ctx === a));
    if (!hasPageParent && !hasTaskAncestor) emit(t);
  }
  // 兜底：环或异常数据导致的未放置项，按原顺序补上（绝不丢 tab）
  for (const t of opened) emit(t);
  return out;
}

/** c 是否是 t 的直接子（页面层次优先，其次任务层次） */
function isChildOf(
  c: TabLike,
  t: TabLike,
  parentPageOf: (pageId: string) => string | undefined,
  byKey: Map<string, TabLike>,
): boolean {
  const pageParent = pageParentKeyOf(c, parentPageOf);
  if (pageParent && byKey.has(pageParent)) return pageParent === t.key;
  // 任务层次：直接父就是 t 的 ctx
  const ancestors = c.taskAncestors ?? [];
  return ancestors.length > 0 && ancestors[ancestors.length - 1] === t.ctx;
}
