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

import { matchTask, type SearchSnippet, type TaskListNode } from "./task-list";

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
  /**
   * 结果项要打开的任务 URI —— **必填**（不是 node.uri 的裸拷贝）。
   *
   * 为什么单独收窄成 string：`TaskListNode.uri` 是可选的（结构类型，项目节点就没有），
   * 但**没有 uri 的任务压根打不开会话** —— 它不该出现在结果里。搜索时直接把它滤掉、
   * 并把 uri 提升成必填，调用方（NavSearch）就不必写 `hit.node.uri!`（那断言在真缺
   * uri 时会静默把 undefined 送进 openTaskRun → `keyOf(pageId, undefined)`）。
   * 类型诚实：**能出现在结果里的，一定有 uri**。
   */
  uri: string;
  /** 命中强度（见 NAV_HIT_RANK） */
  rank: number;
  /** 正文命中片段（仅 rank = body 时有值） */
  snippet: SearchSnippet | null;
}

/**
 * 整棵**森林**的平铺任务（项目节点不参与命中 —— 弹层的结果单位是任务/会话）。
 *
 * 直接从根开始递归：只有 `kind === "task"` 被收录，项目节点自然被略过，
 * 故**不对"根恒为项目"作假设**（review3 R3-4）—— 顶层若直接挂 task 也照样能搜到。
 */
export function flattenTasks<T extends TaskListNode>(nodes: T[]): T[] {
  const out: T[] = [];
  const walk = (ns: T[]) => {
    for (const n of ns) {
      if (n.kind === "task") out.push(n);
      walk((n.children ?? []) as T[]);
    }
  };
  walk(nodes);
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
 * 全树搜索任务（= `flattenTasks` + `searchTasksOf` 的组合，便捷入口）。
 *
 * 返回**全部命中**（**不截断**）：调用方既要展示前 N 条、又要在底部写「N / 共 M 条」（RV-4），
 * 若这里就截断，就分不清「真只有 12 条」与「被截掉了」。截断由调用方按需 `slice`
 * （弹层用 `NAV_SEARCH_LIMIT`）—— 本模块**不再**提供带 limit 的包装：生产路径要全量计数，
 * 那种包装无人消费（review2 R2-3，已删以减面）。
 */
export function searchTaskHits<T extends TaskListNode>(nodes: T[], query: string): NavHit<T>[] {
  return searchTasksOf(flattenTasks(nodes), query);
}

/**
 * 对**已平铺**的任务列表搜索排序（核心实现）。
 *
 * 与 `searchTaskHits` 分开的理由（RV-8）：`flattenTasks` 是按整棵树走的，与查询词无关；
 * 弹层每次按键都重搜时，若把平铺也放进搜索函数，就等于每次输入都重新遍历整棵树。
 * 调用方（NavSearch）按 `taskStore.nodes` 引用 memo 平铺结果，逐键只做匹配。
 *
 * 排序：命中强度 → `updated` 降序（最近动过的更可能是要找的）→ 任务号升序兜底。
 * 缺 updated 的旧数据恒排本档最后（不给"没时间戳"编一个假顺序）。
 * **跳过没有 uri 的任务**：它们打不开会话，进结果就是死项（见 NavHit.uri）。
 */
/**
 * 排序兜底用的任务号：能解析成有限数才用，否则给 `MAX_SAFE_INTEGER`（排本档最后）。
 *
 * 为什么不能直接 `Number(node.num ?? MAX)`（review4 R4-3）：
 *   · `num: ""` 时 `??` 不触发 → `Number("") === 0` → 空号被排到**所有任务之前**（反了）；
 *   · `num` 非数字 → `NaN`，比较器返回 `NaN` → 排序结果**未定义**。
 * 真源里 num 恒为数字串，但这里是 shared/ 的通用纯函数，不靠调用方纪律成立。
 */
function numOrLast(raw: string | undefined): number {
  const s = (raw ?? "").trim();
  if (!s) return Number.MAX_SAFE_INTEGER;
  const v = Number(s);
  return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
}

export function searchTasksOf<T extends TaskListNode>(flat: T[], query: string): NavHit<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: NavHit<T>[] = [];
  for (const node of flat) {
    const uri = node.uri;
    if (!uri) continue; // 无 uri = 打不开，不是候选
    const r = rankOf(node, q);
    if (r) hits.push({ node, uri, rank: r.rank, snippet: r.snippet });
  }
  hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const au = a.node.updated ?? "";
    const bu = b.node.updated ?? "";
    if (au !== bu) return bu.localeCompare(au); // 新在前；空串自然落最后
    return numOrLast(a.node.num) - numOrLast(b.node.num);
  });
  return hits;
}
