// src/shared/tab-prune.ts
// 🎯 任务被删后，「打开列表」里那些指向已不存在任务的 tab 该剪哪些（纯函数，可单测）。
//
// 为什么独立成文件（##329 R1 的教训）：UI 语义判据必须有断言，不能靠「界面看着对」。
// 剪枝有两个易错点，正是本文件要钉死的：
//   ① 只剪**任务 tab**（ctx 是任务 URI）—— 别把 lab/settings 之类别的 ctx 当任务删掉；
//   ② 树**还没成功加载过**时一律不剪 —— 启动那一瞬 nodes 还是空的，照剪会把用户
//      上次开着、被恢复出来的 tab 全部清光（那是「树还没到」，不是「任务不存在」）。
//
// 过期快照的防护不在这里：那由 taskStore.loadTree 的「旧响应丢弃」负责（见其注释），
// 本函数只认调用方交给它的**那一份**树。调用方（App）读的是 store 里已生效的树。

import { isTaskUri } from "./task-uri";

export interface TabCtxLike {
  pageId: string;
  ctx: string | null;
}

export interface PruneInput {
  /** 已打开的 tab（真信息：pageId + ctx；顺序 = 显示顺序） */
  opened: readonly TabCtxLike[];
  /** 当前树里还活着的任务 URI（**最新**那一份） */
  aliveUris: Iterable<string>;
  /** 树是否已成功加载过至少一次 */
  treeLoaded: boolean;
}

/**
 * 返回应被剪掉的 tab 的 ctx（任务 URI）列表；按打开顺序、去重。
 * 调用方拿到后逐个 `tabStore.dropCtx(ctx)`（它自己负责 active 落位与子页面连带关闭）。
 */
export function staleTaskTabCtxs(input: PruneInput): string[] {
  if (!input.treeLoaded) return []; // ①「树还没到」不是「任务不存在」
  const alive = new Set(input.aliveUris);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of input.opened) {
    if (!isTaskUri(t.ctx)) continue; // ② 非任务 tab 不动
    const ctx = t.ctx as string;
    if (alive.has(ctx) || seen.has(ctx)) continue;
    seen.add(ctx);
    out.push(ctx);
  }
  return out;
}
