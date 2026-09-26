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
import { createSignal, createEffect, on, Show } from "solid-js";
import { taskStore, type TaskDetail } from "../store/taskStore";
import { editTask } from "../lib/task-edit";
import { diyService } from "../lib/rpc";
import { StateSelect } from "./TaskDetailPanel";
import { MarkdownView } from "./MarkdownView";
import { VIEW_BAR_H } from "../lib/layout-metrics";

export function TaskSideView(props: { uri: string }) {
    const [saving, setSaving] = createSignal(false);

    /**
     * 本实例**自己持**任务数据，不读 `taskStore.selectedTask`。
     *
     * 为什么必须这样（曾踩）：selectedTask 是**全局单例**，同一时刻只有一个值。
     * 从前这里写 `taskStore.selectedTask?.uri === props.uri ? ... : null`，
     * 于是本 view 的多个实例（任务执行页左栏 + 悬停任务项的覆盖层）只能有一个是活的：
     * 用户在任务树点了别的任务 → selectedTask 变了 → 另一个实例的条件永远为假
     * → 它的数据明明在内存里，界面却一直停在「加载中…」。
     * props.uri 传入只解决了参数传递，数据源仍是单例 —— 故这里按 uri 各自取数。
     */
    const [task, setTask] = createSignal<TaskDetail | null>(null);

    /** 按 uri 拉详情；响应回来时若 uri 已变（切得快）则丢弃，避免旧数据覆盖新的 */
    const load = async (uri: string) => {
        const r = await diyService.diy.getTask({ uri });
        if (props.uri !== uri) return;
        setTask(r.data ?? null);
    };

    // on(uri, defer=false)：挂载即取一次，之后 uri 变化重新取。
    // 不用再配 onMount —— effect 首次就是同步执行的，加 onMount 会多发一次请求。
    createEffect(
        on(
            () => props.uri,
            (uri) => {
                setTask(null);
                void load(uri);
            },
        ),
    );

    const changeState = async (next: string) => {
        if (next === task()?.state) return;
        setSaving(true);
        try {
            // 编辑走 lib/task-edit 的统一入口（它负责补全 RPC 契约里「可选但键必须出现」
            // 的那些字段）；改完只刷本实例 + 任务树，不动全局 selectedTask
            await editTask(props.uri, { state: next as any });
            await load(props.uri);
            // 任务树/导航上的状态圆点跟着更新（树是全局的，与「本 view 自己取数」不冲突）
            await taskStore.loadTree();
        } catch (e) {
            console.error("[TaskSideView] change state failed:", e);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div class="flex flex-col h-full overflow-hidden">
            <div class={`flex items-center gap-2 px-3 ${VIEW_BAR_H} border-b shrink-0`}>
                <span class="text-[11px] font-bold tracking-wide opacity-60">任务详情</span>
            </div>

            <div class="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
                <Show when={task()} fallback={<div class="text-xs opacity-60">加载中…</div>}>
                    {(t) => (
                        <>
                            <h3 class="text-sm font-bold leading-snug">{t().title || t().uri}</h3>

                            <div class="flex items-center gap-2 flex-wrap">
                                <StateSelect current={t().state} saving={saving()} onSave={changeState} />
                            </div>

                            {/* 结构化字段：只读。本视图定位是"执行时确认在做什么"，
                                编辑仍跳回任务页（那里有统一的字段编辑入口）。 */}
                            <div class="flex items-center gap-2 flex-wrap text-[11px]">
                                <Show when={t().change_type}>
                                    <span class="badge badge-sm badge-ghost font-mono">{t().change_type}</span>
                                </Show>
                                <Show when={t().module}>
                                    <span class="badge badge-sm badge-ghost font-mono">{t().module}</span>
                                </Show>
                                <Show when={t().priority}>
                                    <span class="badge badge-sm badge-ghost font-mono">{t().priority}</span>
                                </Show>
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
