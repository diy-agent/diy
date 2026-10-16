// src/renderer_solid/lib/delete-entry.ts
// 🎯 删除任务 / 项目的**唯一入口**：UI 行内按钮与 CLI（`diy ui task delete` /
// `diy ui project remove`，见 renderer-api-impl）共用同一条路径。
//
// 与 ##138（写操作返回旧值 + 删除走回收站）的关系：**回收站尚未实现**（##138 仍 pending），
// 故此处删除就是 core 层的 `rmSync` 语义 —— **不可恢复**。UI 侧如实标注「回收站待接 ##138」
// （见 TaskTree 的确认弹窗文案）。##138 落地后这里换成回收站 RPC 即可，UI 一行不用动。
//
// 留痕：删除动作本身在 main 的日志里可见（RPC 调用），但**数据不留副本** —— 这正是
// 本任务与 ##138 的分工：本任务只补「基础入口 + 二次确认」，可恢复性是 ##138 的事。

import { diyService } from "./rpc";
import { taskStore } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";
import { findNode } from "./task-lineage";

/**
 * 删除后的统一收尾：刷新树 + 清掉「已不在树里」的选中任务。
 *
 * tab 不用在这里摘：App 的「树 diff」effect 会把从树里消失的 uri 逐个交给
 * `tabStore.dropCtx`（见 App.tsx 的接线注释），loadTree 一刷新它就自动跟上。
 * 但**选中态不归它管** —— 不清则详情面板停在已删任务的幽灵数据上。
 */
async function afterRemoval(): Promise<void> {
    await taskStore.loadTree();
    const sel = taskStore.selectedUri;
    if (sel && !findNode(taskStore.nodes, sel)) await taskStore.selectTask(null);
}

/**
 * 删除任务（**不可恢复**）。
 *
 * 注意语义：main 的 deleteTask 只 rmSync **该任务自己的目录**，子任务目录是并列的
 * `tasks/<n>/`（父子关系由 frontmatter 的 parent 字段表达，不看目录嵌套）——
 * 所以子任务不会被删，只是失去父级、在树里升为一级任务（见 core/task-tree.ts
 * 的 buildParentLinks：parent 指向不存在的任务即落回顶层）。UI 文案必须与此一致。
 */
export async function deleteTaskViaUi(uri: string, title?: string): Promise<void> {
    await diyService.diy.task.delete({ uri });
    await afterRemoval();
    notificationStore.addToast("success", title ? `已删除任务「${title}」` : "已删除任务");
}

/** 删除项目（连带其下全部任务；main 的 removeProject 摘名片 + 删数据目录，不可恢复）。 */
export async function removeProjectViaUi(id: string, label?: string): Promise<void> {
    await diyService.diy.project.remove({ id });
    await afterRemoval();
    notificationStore.addToast("success", `已删除项目${label ? `「${label}」` : ` #${id}`}`);
}
