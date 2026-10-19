/**
 * `##` 任务引用补全（##377 第 11 刀 / ##166 §37.2 B·C）。
 *
 * **触发判据（本刀最重要的一条）**：`##` **必须后跟数字**才弹 ——
 * `##` 在 Markdown 里是二级标题，输入 `## 设计` 弹任务选择器是灾难（用户原话「搜索任务号」正是此意）。
 * `/##\d*$/` 命中才弹：`##`（刚敲完）与 `##37`（输号中）弹，`## 设计`（后跟空格）**不弹**。
 *
 * **插入形态**：`##<号>(<标题>)` —— **完整形态**，不是裸编号（全局规则 `rule.task-ref`：
 * 引用任务一律 `##<号>(<标题>)`，人记不住裸数字号是干什么的）。
 *
 * 数据源 = `taskStore`（任务树，`diy.loadTaskTree` 的同一份缓存，不自己再拉一遍）。
 */
import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { taskStore, type TreeNode } from "../../store/taskStore";

/** 拍平任务树 → 可引用的任务（只取 `kind === "task"` 且有 uri 的） */
function flatten(nodes: readonly TreeNode[]): { num: string; title: string; uri: string }[] {
    const out: { num: string; title: string; uri: string }[] = [];
    const walk = (ns: readonly TreeNode[]) => {
        for (const n of ns) {
            if (n.kind === "task" && n.uri) out.push({ num: n.num ?? "", title: n.title ?? n.uri, uri: n.uri });
            if (n.children?.length) walk(n.children);
        }
    };
    walk(nodes);
    return out;
}

export const taskCompletion: CompletionSource = (ctx) => {
    // 只看光标前：`##` + 可选数字。后跟空格 / 文字（`## 设计`）⇒ 不匹配 ⇒ 不弹。
    const m = ctx.matchBefore(/##\d*$/);
    if (!m) return null;
    const query = m.text.slice(2); // `##` 之后的数字部分（可能为空 = 刚敲完 `##`）
    const all = flatten(taskStore.nodes);

    // 匹配：号前缀优先（用户说「搜索任务号」），其次标题包含（顺手能按名字找）。
    // ⚠️ 自己匹配 + 自己排序 ⇒ 结果 `filter: false`（CM 默认的模糊匹配会把 `##377(标题)` 这种
    //    label 与区间文本 `##37` 的匹配算得很差，甚至滤掉，见下方注释）。
    const byNum = query ? all.filter((t) => t.num.startsWith(query)) : all;
    const byTitle = query ? all.filter((t) => !t.num.startsWith(query) && t.title.includes(query)) : [];
    const hit = [...byNum, ...byTitle].slice(0, 50);

    const options: Completion[] = hit.map((t) => {
        const ref = `##${t.num}(${t.title})`;
        return {
            label: ref,
            detail: t.uri,
            type: "keyword",
            apply: ref,
        };
    });
    return {
        // `from` 落在 `##` 上 ⇒ 接受时整段（`##37`）被替换成完整引用形态
        from: m.from,
        options,
        // CM 不再二次过滤：`filter: false` 的选项**保持我给的原序**（默认过滤/排序会打乱号序，
        // 且 `##37` 与 label `##377(…)` 的模糊匹配得分极低、可能直接滤掉）。
        filter: false,
        // 不设 `validFor`：让每次击键都重新问源 ⇒ 列表随输入实时收窄（本地数组，零成本）
    };
};
