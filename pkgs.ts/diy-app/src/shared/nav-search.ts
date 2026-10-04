// src/shared/nav-search.ts
// 🎯 nav ⌘K 快速打开会话的**搜索规则**（纯函数，renderer 与单测共用，无 DOM 无 Node 依赖）
//
// 为什么单独成文件而不是塞进 NavSearch.tsx：
//   ① 「谁排在前面」「什么算命中」是可判定的规则，塞进组件就只剩「界面上看着对」一种验证；
//   ② 复用 shared/task-list 的 matchTask / buildSnippet —— 挑词口径与任务管理页搜索**同源**，
//      同一个词在两个入口命中同一批任务，不会各写一套（那才会出现"表格搜得到、⌘K 搜不到"）。
//
// 与任务管理页搜索的**刻意差异**（这里不是"再实现一遍"，是场景不同）：
//   · 表格是树（剪枝 + 保祖先链 + 展开），弹层是**平铺候选**（快速定位，不看层级）；
//   · 表格保持用户排序，弹层按**命中强度**排 —— 搜 `12` 时任务 #12 必须压过"正文提到 12"的。

import { buildSnippet, matchTask, type SearchSnippet, type TaskListNode } from "./task-list";

/** 弹层默认最多展示多少条（再多就不是"快速打开"，是翻列表了） */
export const NAV_SEARCH_LIMIT = 12;

/**
 * 命中强度（小 = 靠前）。
 *
 * 分档的依据是「用户敲这个词时，心里想的是哪个字段」：
 *   编号精确 → 前缀 → 标题前缀 → 标题子串 → 其他字段 → 正文。
 * 正文恒最后：它是"内容里碰巧提到"，一条正文长的任务几乎必然命中，排前面会淹掉真目标。
 */
export const NAV_HIT_RANK = {
  numExact: 0,
  numPrefix: 1,
  titlePrefix: 2,
  titleSub: 3,
  field: 4,
  body: 5,
} as const;

export interface NavHit<T extends TaskListNode = TaskListNode> {
  node: T;
  /** 命中强度（见 NAV_HIT_RANK） */
  rank: number;
  /** 正文命中片段（仅 rank = body 时有值） */
  snippet: SearchSnippet | null;
}

/** 整棵树的**平铺任务**（项目节点不参与命中 —— 弹层的结果单位是任务/会话） */
export function flattenTasks<T extends TaskListNode>(nodes: T[]): T[] {
  const out: T[] = [];
  const walk = (ns: T[]) => {
    for (const n of ns) {
      if (n.kind === "task") out.push(n);
      walk((n.children ?? []) as T[]);
    }
  };
  for (const n of nodes) {
    if (n.kind !== "project") continue;
    walk((n.children ?? []) as T[]);
  }
  return out;
}

/**
 * 单条任务的命中判定 + 强度。未命中返回 null。
 *
 * 编号前缀档要求查询词**是数字开头**（`#` 可选）：否则搜 "task" 会把 num "12" 也算前缀
 * 命中（荒谬）；而搜 "1" 时 #1 / #12 / #199 排前面正是用户要的。
 */
function rankOf(node: TaskListNode, q: string): { rank: number; snippet: SearchSnippet | null } | null {
  const num = (node.num ?? "").toLowerCase();
  const title = (node.title ?? "").toLowerCase();
  const digitQ = q.startsWith("#") ? q.slice(1) : q;
  const numish = digitQ.length > 0 && /^\d+$/.test(digitQ);

  if (numish && num === digitQ) return { rank: NAV_HIT_RANK.numExact, snippet: null };
  if (numish && num.startsWith(digitQ)) return { rank: NAV_HIT_RANK.numPrefix, snippet: null };
  if (title.startsWith(q)) return { rank: NAV_HIT_RANK.titlePrefix, snippet: null };
  if (title.includes(q)) return { rank: NAV_HIT_RANK.titleSub, snippet: null };

  // 其余字段 / 正文：直接问 matchTask（口径与任务管理页搜索同源）——
  // 它返回的 snippet 是否为 null 正是「字段命中」与「正文命中」的分界。
  const m = matchTask(node, q);
  if (!m) return null;
  return m.snippet
    ? { rank: NAV_HIT_RANK.body, snippet: m.snippet }
    : { rank: NAV_HIT_RANK.field, snippet: null };
}

/**
 * 全树搜索任务，按命中强度 + 最近修改排序，取前 limit 条。
 *
 * 同档内按 `updated` 降序（最近动过的更可能是要找的），再按任务号升序兜底 ——
 * 缺 updated 的旧数据恒排本档最后（不给"没时间戳"编一个假顺序）。
 */
export function searchTasks<T extends TaskListNode>(
  nodes: T[],
  query: string,
  limit = NAV_SEARCH_LIMIT,
): NavHit<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: NavHit<T>[] = [];
  for (const node of flattenTasks(nodes)) {
    const r = rankOf(node, q);
    if (r) hits.push({ node, rank: r.rank, snippet: r.snippet });
  }
  hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const au = a.node.updated ?? "";
    const bu = b.node.updated ?? "";
    if (au !== bu) return bu.localeCompare(au); // 新在前；空串自然落最后
    const an = Number(a.node.num ?? Number.MAX_SAFE_INTEGER);
    const bn = Number(b.node.num ?? Number.MAX_SAFE_INTEGER);
    return an - bn;
  });
  return limit > 0 ? hits.slice(0, limit) : hits;
}
