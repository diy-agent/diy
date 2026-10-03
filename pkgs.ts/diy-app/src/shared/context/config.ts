// src/shared/context/config.ts
// 🎯 「哪些变量进 system」这份划分规则的**契约与净化**（纯函数，无 node 依赖）。
//
// 为什么需要它（本设计的核心判断）：划分决定"什么值得缓存、什么每次都变"，
// 它必须是**真源**而不是页面的本地偏好 —— 页面上把 task.body 划进 system，预览跟着变、
// 真发却仍按默认名单发，那就是**界面在说谎**（与"两处请求预览只有一处是真发"同族）。
// 所以这份规则落盘到 $DIY_HOME/context.yaml，页面与真发读同一份（文件 I/O 在 main 侧）。
//
// 只声明 **system 名单**：没进名单的自动归 runtime（不是两套表，避免两边打架）。
// 空 = 用推荐名单（defaultSystemPlaces）。

import { z } from "zod";
import { defaultSystemPlaces } from "./delivery";
import { isValidPath } from "./path";

/** context.yaml 的结构（全局一份） */
export const ContextConfigSchema = z.object({
  /** 划入 system 的投递单元路径（其余自动 runtime） */
  systemPlaces: z.array(z.string()),
});
export type ContextConfig = z.infer<typeof ContextConfigSchema>;

/**
 * 净化一份名单（**读侧一律走它**：手改文件、旧版本残留、写坏的路径都从这里兜住）。
 *
 * 三件事，都出声（返回 dropped 让调用方 warn —— 不静默半用）：
 *   1. 丢弃非法路径（`isValidPath`）；
 *   2. 丢弃与已留项互为祖先/后代的（places 的硬规则：重叠时"属于哪个单元"没有唯一答案）；
 *   3. 去重。
 * 结果为空 → 返回推荐名单（**保证真发永远有一份可用名单**，不会因为文件写坏就发出空 system）。
 *
 * 为何"丢坏项"而不是"整份回落默认"：手改文件打错一个字（`task.titl`）不该把
 * 用户其余的划分一起丢掉；而重叠这类集合级错误只能丢其中一个（排序后取先者，结果确定）。
 */
export function sanitizeSystemPlaces(raw: readonly string[]): {
  places: string[];
  dropped: string[];
} {
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const p of [...new Set(raw)].sort()) {
    if (!isValidPath(p)) {
      dropped.push(p);
      continue;
    }
    const conflict = kept.find((k) => k === p || p.startsWith(`${k}.`) || k.startsWith(`${p}.`));
    if (conflict !== undefined) {
      dropped.push(p);
      continue;
    }
    kept.push(p);
  }
  if (kept.length === 0) {
    return { places: defaultSystemPlaces(), dropped };
  }
  return { places: kept, dropped };
}
