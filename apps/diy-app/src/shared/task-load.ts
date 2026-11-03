// src/shared/task-load.ts
// 🎯 `getTask` 响应的**判读**（纯函数，单测见 tests/core/task-store.test.ts / tab-prune.test.ts）。
//
// 为什么要单独一个判据：契约（main/services/api-impl.ts）本就区分
//   - 找到   → `{ status: "ok",    data: {…} }`
//   - 未找到 → `{ status: "error", data: null }`   ← 注释写明「truthy 的壳对象会让 renderer 守卫失效」
// 但 renderer 只看 `r.data`、且 data 为 null 时与「异步还没回来」**长得一样** ——
// 于是已删任务的详情页恒停在「加载中…」（##361 的死路，无终态无出路）。
// 判读收在此一处：renderer 的每一处守卫都问它，不再各自写 `if (!r.data)`。

/** getTask 的判读结果：拿得到 / 任务不存在 */
export type GetTaskVerdict = "ok" | "missing";

/**
 * 判读一次 getTask 响应。
 *
 * 判据（两者任一即 missing，与 body 的契约一致）：`status !== "ok"` 或 `data == null`。
 * 保守取「必须显式 ok 且有载荷」：将来 main 新增别的 status 时，旧 renderer 会落到
 * 「不存在」这条可见的终态（有出路），而不是退回「永远加载中」（无出路）。
 */
export function getTaskVerdict(
  r: { status?: string; data?: unknown } | null | undefined,
): GetTaskVerdict {
  return r && r.status === "ok" && r.data != null ? "ok" : "missing";
}
