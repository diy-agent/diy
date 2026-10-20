/**
 * notice-copy.ts — 「复制到剪贴板」/「落盘保存」这类**成功提示**的二级信息（##391 R4 ④）。
 *
 * 为什么要为"成功"单独一份：用户抱怨的正是**成功类**提示（「会话实时更新已恢复」）——
 * 失败时人还有上下文（我刚点了什么、为什么失败），成功时**没有任何线索**说明
 * "成功的是什么、成功了多大一份、我能拿它干什么"。所以成功提示的二级信息必须回答：
 *   · 来源：哪个按钮 / 哪个组件做的（含代码位置）
 *   · 原因：**复制了多少字**、**什么时候** —— 数字与时刻最能自证
 *   · 机制：剪贴板/落盘是怎么回事、什么时候会失败、失败长什么样、这条提示怎么消
 *
 * 口径：失败走 `copyFailMeta` / 调用点自己给 reason，但**同一条机制说明**（`DETAIL_CLIPBOARD`）
 * 必须一致 —— 用户点开"复制成功"和"复制失败"的详情时，读到的是同一套说法。
 */
import { formatClock, type NoticeMeta } from "./notice";

/** 剪贴板机制说明（成功/失败共用） */
const DETAIL_CLIPBOARD = [
    "在监测什么：点「复制」时把那段文本写进**系统剪贴板**（`navigator.clipboard.writeText`）。写入是异步的 —— 系统授权、窗口是否聚焦都会影响它。",
    "成功意味着什么：可以直接粘到别处（终端 / 对话 / 编辑器）。提示里带「多少字」是为了让你确认复制的是**这一份**，不是上一次留下的旧剪贴板内容。",
    "什么时候会失败：窗口没有剪贴板权限、页面不在前台、或运行在受限的远程会话里 —— 这时会出一条 error 提示，且**不会**假装成功（旧剪贴板内容原样保留）。",
    "怎么消：4 秒自动消失；失败的原始异常在控制台。",
].join("\n");

/** 「已复制」的二级信息：`what` = 复制的是什么（人读），`text` = 实际复制的文本（用来数字数） */
export function copyOkMeta(p: { what: string; text: string; mech: string }): NoticeMeta {
    const chars = p.text.length;
    const lines = p.text.split("\n").length;
    return {
        source: `剪贴板 · ${p.what}（${p.mech}）`,
        reason: `已写入剪贴板 ${chars} 字 / ${lines} 行（${formatClock(Date.now())}）—— 现在可以粘到终端、对话或编辑器里`,
        detail: DETAIL_CLIPBOARD,
    };
}

/** 「复制失败」的二级信息：原因里带错误原文（用户/agent 都能据此判是权限还是别的问题） */
export function copyFailMeta(p: { what: string; mech: string; error: unknown }): NoticeMeta {
    const msg = p.error instanceof Error ? p.error.message : String(p.error);
    return {
        source: `剪贴板 · ${p.what}（${p.mech}）`,
        reason: `写入剪贴板被拒绝（${formatClock(Date.now())}）：${msg || "(无错误消息)"} —— 剪贴板内容未改变，可手选文本或换到前台窗口重试`,
        detail: DETAIL_CLIPBOARD,
    };
}
