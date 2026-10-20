/**
 * notice-compact.ts — 「压缩历史」类提示的二级信息（##391 R4 ④ 保存/落盘类）。
 *
 * 压缩是**不可见但影响很大**的动作：它改的是"模型还能看到多少历史"，
 * 只回一句「已压缩」等于让用户赌一把。二级信息必须说清：
 *   · 来源：哪个入口（用量面板的压缩按钮 → `localChatStore.compact`）
 *   · 原因：带**预算数字**（MB）、是不是 noop（历史本来就够小）
 *   · 机制：压的是什么（只压喂给模型的窗口，盘上原文保留）、怎么撤销、noop 是什么意思
 *
 * 口径来源：`localChatStore.compact` / `undoCompact` 与 `main` 的 compact 实现 ——
 * 压缩**不改盘上原文**（被裁的原文另存），撤销走 append-only 的 undo 记录。
 */
import type { NoticeMeta } from "./notice";

const DETAIL_COMPACT = [
    "在监测什么：上下文预算 —— 模型一次能读多少历史。压缩 = 把超出预算的**较早轮次**从「喂给模型的窗口」里裁掉，盘上的会话原文**不删**（被裁部分另存，可撤销）。",
    "为什么会弹：压缩改变的是「模型还能看到多少」，属于不可见但影响很大的动作 —— 成功也要说清压了什么、能不能回退，失败更要说清有没有动到数据。",
    "noop 是什么意思：算下来历史本来就在预算内，没有可裁的内容 → 什么都没改（不是失败，也不是「压了个空」）。",
    "怎么消：4 秒自动消失；撤销入口在压缩面板（append-only 的 undo 记录，恢复后的块树会立刻重建）。",
    "对你的影响：压缩后模型对早期上下文的记忆会变短（对话里通常能看到压缩边界）；觉得压狠了可以直接撤销。",
].join("\n");

/** 压缩类提示的二级信息（`kind` 决定原因措辞；预算用 MB 表述，与面板显示一致） */
export function compactNotice(p: {
    kind: "noop" | "done" | "failed";
    budgetBytes: number;
    uri: string;
    error?: unknown;
}): NoticeMeta {
    const mb = (p.budgetBytes / (1024 * 1024)).toFixed(1);
    const reason =
        p.kind === "noop"
            ? `会话 ${p.uri} 按预算 ${mb} MB 试算：历史已在预算内，可裁轮次 = 0 → 未改动任何内容`
            : p.kind === "done"
              ? `会话 ${p.uri} 已按预算 ${mb} MB 裁掉较早轮次（盘上原文保留、可撤销），块树已按新边界重建`
              : `会话 ${p.uri} 压缩失败（预算 ${mb} MB）：${p.error instanceof Error ? p.error.message : String(p.error)} → 窗口未变，历史仍按原样喂给模型`;
    return {
        source: "上下文压缩 · compact（renderer_solid/store/localChatStore.ts::compact · UsagePanel.tsx 压缩按钮）",
        reason,
        detail: DETAIL_COMPACT,
    };
}
