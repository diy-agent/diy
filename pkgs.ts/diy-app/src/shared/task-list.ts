// src/shared/task-list.ts
// 🎯 任务列表的排序 / 搜索 / 扁平化 —— **纯函数**（renderer 与单测共用，无 DOM 无 Node 依赖）
//
// 为什么单独成文件而不是塞在 TaskTree.tsx 里：
//   ① 树的排序/剪枝/片段提取是**可验证的规则**（同级排序、未设置值排最后、命中保祖先链…），
//      塞进组件就只剩「界面上看着对」这一种验证方式；
//   ② TaskTree 里已有 rowCache（引用稳定，防 DOM 重建）这类微妙机制，
//      再混进排序剪枝会看不清哪层在干什么。
//
// 边界（谁负责什么）：
//   本文件：给定「节点树 + 排序规格 + 搜索词 + 展开判定」→ 输出扁平行数组（含正文命中片段）
//   TaskTree：把行映射到稳定引用缓存、渲染 DOM、滚动与键盘导航

import { PRIORITIES } from "../main/core/task-fields";
import { TASK_STATES } from "../main/core/task-state";

/**
 * 本模块需要的最小节点形状（**结构类型，刻意不 import 任何具体节点类型**）。
 *
 * 为什么不用现成的 TaskNode：它的 `state` 是枚举 TaskState（main 域类型），
 * 而 renderer 拿到的是 RPC 契约的形状（state 为宽松 string，见 api-def 的 TaskNodeShape）。
 * 两者都结构上满足本接口，于是本模块不必绑死在任一侧 —— 纯视图逻辑不该知道 RPC 契约，
 * 也不该依赖 main 的域类型。泛型参数让调用方拿回自己的具体类型（见 sortTasks / buildTaskRows）。
 */
export interface TaskListNode {
  kind: "project" | "task";
  uri?: string;
  num?: string;
  title?: string;
  state?: string;
  change_type?: string;
  module?: string;
  priority?: string;
  created?: string;
  updated?: string;
  body?: string;
  project?: string;
  project_path?: string;
  project_label?: string;
  children: TaskListNode[];
}

// ═══════════════════════════════════════
// 排序
// ═══════════════════════════════════════

export type SortKey =
  | "created"
  | "updated"
  | "num"
  | "title"
  | "state"
  | "change_type"
  | "module"
  | "priority";

export type SortDir = "asc" | "desc";

export interface SortSpec {
  key: SortKey;
  dir: SortDir;
}

/**
 * 表头顺序 = 列顺序（两者必须一致，故共用这一个清单）。
 * 含 `title`（首列）—— 规格是"点表头排序"，那每个**数据列**都该能点，
 * 不能因为标题列还兼着展开按钮/点击进详情就不给它排序入口。
 */
export const SORT_KEYS: readonly { key: SortKey; label: string; title: string }[] = [
  { key: "title", label: "标题", title: "标题（按拼音/字母）" },
  { key: "change_type", label: "类型", title: "变更性质（feat/fix/…）" },
  { key: "module", label: "模块", title: "模块" },
  { key: "priority", label: "优先级", title: "优先级（未定级排最后）" },
  { key: "state", label: "状态", title: "状态" },
  { key: "num", label: "编号", title: "任务号（项目内自增）" },
  { key: "created", label: "创建", title: "创建时间" },
  { key: "updated", label: "修改", title: "最后修改时间" },
];

/** 默认排序：创建时间升序 = 任务号顺序 = 稳定时间线（用户选定的默认，勿随意改） */
export const DEFAULT_SORT: SortSpec = { key: "created", dir: "asc" };

/** 认识的排序键 = 清单本身（曾经额外手工塞了一个 `title`，因为 title 不在清单里 —— 
 *  "清单"与"可用键"两个真相源，早晚对不上；现在只有清单一个源。 */
const SORT_KEY_SET = new Set<string>(SORT_KEYS.map((s) => s.key));

/** `"created:asc"` → SortSpec；形状不对或不认识的键 → 回落默认（未知键不报错） */
export function parseSort(raw: string | undefined): SortSpec {
  if (!raw) return DEFAULT_SORT;
  const [key, dir] = raw.split(":");
  if (!key || !SORT_KEY_SET.has(key)) return DEFAULT_SORT;
  return { key: key as SortKey, dir: dir === "desc" ? "desc" : "asc" };
}

export function formatSort(s: SortSpec): string {
  return `${s.key}:${s.dir}`;
}

/**
 * 点表头：同键翻方向；切到别的键时给一个"该键最常想看的开头"。
 *
 * 规则：**除 `updated` 外一律升序**。为什么是升序而不是"降序先看要紧的"——
 *   1. 枚举的排序依据是**声明序**（`TASK_STATES` / `PRIORITIES` 的数组顺序），
 *      而声明序本身就是"有意义的展示序"：priority 的 `P0` 排第 0 位、state 的 `pending` 排第 0 位。
 *      升序 = 按这个顺序读 = P0 在前、待处理在前 —— 正是"先看要紧的"。
 *   2. 时间/编号/文本同理：时间线从头看、任务号从小到大、文本 A→Z 都是升序直觉。
 *   3. `updated` 降序是唯一的例外：这条列问的是"最近改了什么"，升序会把陈旧任务堆在最前。
 *
 * ⚠️ 这里曾经按"时间/编号升序、其余降序"分两类，与上面的意图**正好相反**：
 * 降序会把 `enumRank` 的位次整体反转（sign=-1）→ 首次点「优先级」得到 P3 在前。
 * 注释写着"先看 P0 在前"，代码给出 P3 在前 —— 方向反了，这是被 175 的 review 抓出来的。
 */
export function toggleSort(cur: SortSpec, key: SortKey): SortSpec {
  if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "updated" ? "desc" : "asc" };
}

/**
 * 可空值比较：**未设置的值恒排最后**（与 asc/desc 无关）。
 *
 * 为什么"恒最后"而不是随方向翻转：`priority` 未定级、`module` 未填是「没信息」，
 * 不是「最小」。升序时若排最前，会和「P0 最高优先级」混在一起被误读；
 * 恒排最后则两个方向都能一眼看到"哪些还没填"。
 *
 * 注意只有"是否缺失"这一层不受方向影响；位次（rank）与文本比较仍随方向翻转 ——
 * 所以"想先看到 P0"必须用**升序**（`PRIORITIES` 里 P0 位次最小），降序是 P3 在前。
 */
function cmpField<T>(
  a: T | undefined,
  b: T | undefined,
  sign: number,
  cmp: (x: T, y: T) => number,
  rank?: (v: T) => number,
): number {
  if (a === undefined || b === undefined) {
    return a === b ? 0 : a === undefined ? 1 : -1;
  }
  if (rank) {
    const d = rank(a) - rank(b);
    if (d !== 0) return sign * d;
  }
  return sign * cmp(a, b);
}

/** 取枚举里的位次；不在表内（历史手写值）→ 排到已知值之后 */
function enumRank(list: readonly string[], v: string): number {
  const i = list.indexOf(v);
  return i === -1 ? list.length : i;
}

function cmpText(a: string, b: string): number {
  return a.localeCompare(b, "zh");
}

/**
 * 生成任务节点比较器。
 * 只在**同一父级的兄弟之间**使用 —— 跨层级排序会破坏父子结构（树是分类与分解的表达）。
 */
export function taskComparator<T extends TaskListNode>(spec: SortSpec): (a: T, b: T) => number {
  const sign = spec.dir === "asc" ? 1 : -1;
  const { key } = spec;
  return (a, b) => {
    switch (key) {
      case "num":
        // 任务号是自增数字，必须按数值比 —— 字典序会把 #9 排到 #100 之后（真实故障）
        return cmpField(numValue(a), numValue(b), sign, (x, y) => x - y);
      case "created":
      case "updated":
        // ISO 8601（带 Z）字典序 == 时间序，无需 Date 解析
        return cmpField(a[key], b[key], sign, (x, y) => (x < y ? -1 : x > y ? 1 : 0));
      case "state":
        return cmpField(a.state, b.state, sign, cmpText, (v) => enumRank(TASK_STATES, v));
      case "priority":
        return cmpField(a.priority, b.priority, sign, cmpText, (v) => enumRank(PRIORITIES, v));
      case "change_type":
        return cmpField(a.change_type, b.change_type, sign, cmpText);
      case "module":
        return cmpField(a.module, b.module, sign, cmpText);
      case "title":
        return cmpField(a.title, b.title, sign, cmpText);
    }
  };
}

/** 任务号 → 数字（缺失/非数字 → undefined，排最后） */
function numValue(n: TaskListNode): number | undefined {
  if (!n.num) return undefined;
  const v = Number(n.num);
  return Number.isFinite(v) ? v : undefined;
}

/** 同级排序（返回新数组，不改入参） */
export function sortTasks<T extends TaskListNode>(nodes: T[], spec: SortSpec): T[] {
  return [...nodes].sort(taskComparator<T>(spec));
}

// ═══════════════════════════════════════
// 搜索
// ═══════════════════════════════════════

/** 正文片段：命中处前后各截一段，供行内第二行展示 */
export interface SearchSnippet {
  before: string;
  /** 命中原文（保留大小写，只有比较时忽略大小写） */
  match: string;
  after: string;
  /** 正文里命中的总处数（>1 时行内显示 `+N 处`） */
  count: number;
}

export interface TaskMatch {
  /** 片段（正文命中才有；标题等字段命中时为 null） */
  snippet: SearchSnippet | null;
}

/** 片段上下文长度（命中处前后各取多少个字符） */
const SNIPPET_CONTEXT = 30;

/**
 * 在文本中找第一处命中并截出片段；无命中返回 null。
 *
 * 文本先做**空白折叠**（`\s+` → 单个空格）再匹配与展示：片段是单行展示，
 * Markdown 正文里的换行/缩进/表格对齐在单行里没有意义，折叠后命中位置与展示一致
 * （不在原始文本上算下标再映射，避免两套下标体系）。
 */
export function buildSnippet(text: string, query: string, context = SNIPPET_CONTEXT): SearchSnippet | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const q = query.trim();
  if (!flat || !q) return null;
  const lower = flat.toLowerCase();
  const qLower = q.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return null;

  let count = 0;
  for (let at = idx; at !== -1; at = lower.indexOf(qLower, at + qLower.length)) count++;

  const from = Math.max(0, idx - context);
  const to = Math.min(flat.length, idx + q.length + context);
  return {
    before: (from > 0 ? "…" : "") + flat.slice(from, idx),
    match: flat.slice(idx, idx + q.length),
    after: flat.slice(idx + q.length, to) + (to < flat.length ? "…" : ""),
    count,
  };
}

/**
 * 任务是否命中搜索词；未命中返回 null。
 *
 * 匹配范围 = **本任务自身的信息 + 正文**：标题 / 任务号（带不带 `#` 都算）/
 * URI / 模块 / 变更性质 / 优先级 / 状态 / 正文。
 *
 * URI 算本任务自身的信息（它就是这条任务的地址，`projects/4/tasks/109` 是可用的定位手段），
 * 所以搜 `projects/9` 会命中该项目的全部任务 —— 这是**有意**的。
 * 不含的是**别人的**信息（项目显示名/路径）：那种命中在行里看不出来源，
 * 用户会问"为什么这条被搜出来了"。
 *
 * 单一关键词子串匹配（不切词、不支持 `-` 排除等语法）：本功能定位是"快速定位"，
 * 不是查询语言；真需要复杂查询时，应该走将来的过滤/扩展字段机制，而不是在这里堆语法。
 */
export function matchTask(node: TaskListNode, query: string): TaskMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const num = node.num ?? "";
  const haystack = [
    node.title ?? "",
    num,
    `#${num}`,
    node.uri ?? "",
    node.module ?? "",
    node.change_type ?? "",
    node.priority ?? "",
    node.state ?? "",
  ];
  if (haystack.some((h) => h.toLowerCase().includes(q))) return { snippet: null };

  const snippet = node.body ? buildSnippet(node.body, q) : null;
  return snippet ? { snippet } : null;
}

// ═══════════════════════════════════════
// 扁平化（排序 + 剪枝）
// ═══════════════════════════════════════

/** 一行扁平结果（TaskTree 依此渲染）。泛型参数让调用方拿回自己的节点类型（见文件头） */
export interface TaskListRow<T extends TaskListNode = TaskListNode> {
  node: T;
  depth: number;
  /** 搜索态下的命中信息；非搜索态或未命中（祖先行）为 null */
  match: TaskMatch | null;
}

/** 行/拖拽节点的稳定 key：project → `proj:<id>`，task → uri */
export function taskRowKey(node: TaskListNode): string {
  return node.kind === "project" ? `proj:${node.project ?? ""}` : node.uri ?? "";
}

export interface BuildRowsOptions {
  sort: SortSpec;
  /** 搜索词（空 = 非搜索态：不剪枝，按展开状态展示） */
  query: string;
  /** 展开判定（由调用方给：项目的展开语义与任务相反，且有持久化视图 cache） */
  isExpanded: (node: TaskListNode) => boolean;
}

interface CollectCtx {
  query: string;
  searching: boolean;
  sort: SortSpec;
  isExpanded: (node: TaskListNode) => boolean;
}

/**
 * 把孩子节点收成行；`prune=true`（搜索态）时丢掉不含命中的整个分支。
 * 返回值 `hit` 表示本子树是否含命中 —— 父级据此决定自己是否保留。
 */
function collect<T extends TaskListNode>(
  kids: T[],
  depth: number,
  ctx: CollectCtx,
  prune: boolean,
): { rows: TaskListRow<T>[]; hit: boolean } {
  const rows: TaskListRow<T>[] = [];
  let hit = false;
  for (const node of sortTasks<T>(kids, ctx.sort)) {
    const match = ctx.searching ? matchTask(node, ctx.query) : null;
    const sub = collect<T>(node.children as T[], depth + 1, ctx, prune);
    if (match || sub.hit) hit = true;
    if (prune && !match && !sub.hit) continue; // 搜索态：只保留命中链（命中行 + 其祖先）
    rows.push({ node, depth, match });
    // 搜索态**强制展开**：命中项若被折叠状态挡住，搜索结果就是"看不见的"，等于没搜到
    if (ctx.searching || ctx.isExpanded(node)) rows.push(...sub.rows);
  }
  return { rows, hit };
}

/**
 * 构建扁平行数组。
 *
 * - 项目分组恒保持注册顺序（不参与排序）：排序只在**同一父级的任务之间**进行，
 *   项目只是分组容器。
 * - 搜索态（query 非空）：剪枝为"命中行 + 其祖先"，并强制展开；项目自身命中时
 *   展示其全部任务（搜项目名 = 想看这个项目下的东西）。
 */
export function buildTaskRows<T extends TaskListNode>(nodes: T[], opts: BuildRowsOptions): TaskListRow<T>[] {
  const searching = opts.query.trim().length > 0;
  const ctx: CollectCtx = { query: opts.query, searching, sort: opts.sort, isExpanded: opts.isExpanded };
  const rows: TaskListRow<T>[] = [];

  for (const project of nodes) {
    if (project.kind !== "project") continue;
    const projectHit = searching && matchesProject(project, opts.query);
    const sub = collect<T>(project.children as T[], 1, ctx, searching && !projectHit);
    if (searching && !projectHit && sub.rows.length === 0) continue;
    rows.push({ node: project, depth: 0, match: null });
    if (searching || opts.isExpanded(project)) rows.push(...sub.rows);
  }
  return rows;
}

/** 项目节点本身是否命中（名称 / 路径） */
function matchesProject(project: TaskListNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return [project.title ?? "", project.project_path ?? "", project.project_label ?? ""].some((h) =>
    h.toLowerCase().includes(q),
  );
}
