/**
 * TaskSideView — 任务执行页**左栏**的任务详情（简化版）。
 *
 * 与任务页的完整 `TaskInfoView` 的分工（刻意不同，不是重复实现）：
 *   本视图是「执行任务时的提示性显示」——大多数任务内容不多，主要目的是
 *   **不必来回切页面**就能确认「我在做哪个任务、它什么状态」。
 *   故：只读为主、单栏纵向、无编辑态、无 md/raw 二级 tab。
 *   **内容编辑跳回任务页的大 view**（那里有编辑态、草稿、渲染切换）。
 *
 * 状态两边都能改：状态是高频动作，跳回再改的代价明显高于就地改。
 */
import { createSignal, Show } from "solid-js";
import { taskStore } from "../store/taskStore";
import { diyService } from "../lib/rpc";
import { getRendererActions } from "../lib/renderer-actions";
import { StateSelect } from "./TaskDetailPanel";
import { MarkdownView } from "./MarkdownView";

export function TaskSideView(props: { uri: string }) {
    const [saving, setSaving] = createSignal(false);
    /** 只认属于本视图 uri 的任务（切 tab 期间 selectedTask 可能还是上一个） */
    const task = () => (taskStore.selectedTask?.uri === props.uri ? taskStore.selectedTask : null);

    const changeState = async (next: string) => {
        if (next === task()?.state) return;
        setSaving(true);
        try {
            await diyService.diy.task.edit({
                uri: props.uri,
                title: undefined,
                state: next as any,
                body: undefined,
                parent: undefined,
            });
            await taskStore.loadTree();
            await taskStore.selectTask(props.uri);
        } catch (e) {
            console.error("[TaskSideView] change state failed:", e);
        } finally {
            setSaving(false);
        }
    };

    /** 跳回任务页看/改完整详情（本视图不做编辑态） */
    const openFull = () => {
        const a = getRendererActions();
        a.navigate?.("task");
        a.focus?.(props.uri);
    };

    return (
        <div class="flex flex-col h-full overflow-hidden">
            <div class="flex items-center gap-2 px-3 py-2 border-b shrink-0">
                <span class="text-[11px] font-bold tracking-wide opacity-60">任务详情</span>
                <button class="btn btn-ghost btn-xs ml-auto shrink-0" onClick={openFull} title="回到任务页看完整详情（含编辑）">
                    ↗ 全部
                </button>
            </div>

            <div class="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
                <Show when={task()} fallback={<div class="text-xs opacity-60">加载中…</div>}>
                    {(t) => (
                        <>
                            <h3 class="text-sm font-bold leading-snug">{t().title || t().uri}</h3>

                            <div class="flex items-center gap-2 flex-wrap">
                                <StateSelect current={t().state} saving={saving()} onSave={changeState} />
                            </div>

                            <div class="flex flex-col gap-1 text-[11px] opacity-60">
                                <Show when={t().project}>
                                    <span class="truncate" title={t().project_path ?? t().project}>
                                        📂 {t().project_label ?? t().project_path ?? t().project}
                                    </span>
                                </Show>
                                <Show when={t().created}>
                                    <span>🕐 {new Date(t().created!).toLocaleString()}</span>
                                </Show>
                                <span class="font-mono truncate" title={t().uri}>
                                    {t().uri}
                                </span>
                                <Show when={t().parent}>
                                    <span class="truncate">↳ 父 {t().parent}</span>
                                </Show>
                            </div>

                            <div class="border-t pt-2">
                                <Show when={t().body} fallback={<span class="text-xs opacity-40 italic">无内容</span>}>
                                    <MarkdownView content={t().body!} />
                                </Show>
                            </div>
                        </>
                    )}
                </Show>
            </div>
        </div>
    );
}
