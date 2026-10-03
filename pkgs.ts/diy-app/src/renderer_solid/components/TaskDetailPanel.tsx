import { createSignal, createEffect, on, onMount, onCleanup, Show } from "solid-js";
import { taskStore } from "../store/taskStore";
import { localChatStore } from "../store/localChatStore";
import { draftStore } from "../store/draftStore";
import { getRendererActions } from "../lib/renderer-actions";
import { Caches } from "../lib/ui-state";
import { TaskDetailContent } from "./TaskDetailContent";
import { VIEW_BAR_H } from "../lib/layout-metrics";

const PANEL_W_MIN = 360;
/** 上限相对窗口：至少给任务树留 200px，避免抽屉吃掉整页 */
const panelMax = () => Math.max(PANEL_W_MIN + 100, window.innerWidth - 200);

/** 面板宽度（px 固定值，不用百分比；视图 cache：范围校验在字段 parse） */
function loadPanelWidth(): number {
    return Caches.diy_task_detail_width.get();
}

export function TaskDetailPanel() {
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") taskStore.selectTask(null);
    };
    onMount(() => window.addEventListener("keydown", onKey));
    onCleanup(() => window.removeEventListener("keydown", onKey));
    const [panelW, setPanelW] = createSignal(loadPanelWidth());
    // 渲染宽度一律过窗口上限：持久化的值可能来自更大的屏幕（上限 4000），
    // 直接套用会把任务树挤没（历史问题：只有拖拽路径 clamp，渲染路径没 clamp）。
    const renderW = () => Math.min(panelMax(), panelW());

    // ── per-task 记忆：详情滚动位置（存 TaskState，切任务/重挂各自恢复） ──
    let detailScrollRef: HTMLDivElement | undefined;
    /** 详情滚动恢复标记：切任务时置位，内容（selectedTask 异步加载）就绪后执行一次 */
    let needsRestore = false;
    // 切任务：冲掉旧任务防抖中的草稿（输入框随任务切换立刻卸载，不冲则最后 600ms 的字丢掉）
    createEffect(
        on(
            () => taskStore.selectedUri,
            (uri, prev) => {
                if (prev) void draftStore.flushNow(prev);
                if (uri) needsRestore = true;
            },
        ),
    );
    // 面板整体卸载（切导航页 / 关闭面板）同样要冲
    onCleanup(() => {
        const u = taskStore.selectedUri;
        if (u) void draftStore.flushNow(u);
    });
    onMount(() => {
        if (taskStore.selectedUri) needsRestore = true;
    });
    // 内容就绪后恢复详情滚动（rAF 一帧后设，内容已渲染不会被 clamped）
    createEffect(() => {
        const t = taskStore.selectedTask;
        const uri = taskStore.selectedUri;
        if (!t || !uri || !needsRestore) return;
        if (!detailScrollRef) return;
        needsRestore = false;
        const p = localChatStore.getDetailScroll(uri);
        if (p > 0) {
            // 内容异步渲染：等 scrollHeight 展开（>clientHeight）再设，防 clamped；最多 5 帧尽力
            let frames = 0;
            const trySet = () => {
                if (!detailScrollRef) return;
                frames++;
                if (frames <= 5 && detailScrollRef.scrollHeight <= detailScrollRef.clientHeight + 1) {
                    requestAnimationFrame(trySet);
                    return;
                }
                detailScrollRef.scrollTop = p;
            };
            requestAnimationFrame(trySet);
        }
    });

    // 左缘拖拽改宽：面板右锚定，宽 = 视口宽 - 鼠标 x；松开落盘
    const onGripDown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const move = (ev: MouseEvent) => {
            setPanelW(Math.min(panelMax(), Math.max(PANEL_W_MIN, window.innerWidth - ev.clientX)));
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            try {
                Caches.diy_task_detail_width.set(panelW());
            } catch {
                /* 存失败不影响本次 */
            }
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };

    return (
        <Show when={!!taskStore.selectedUri}>
            <div
                data-task-detail-panel
                class="card bg-base-100 border-l shadow-xl absolute inset-y-0 right-0 z-40 h-full flex flex-col"
                style={{ width: `${renderW()}px` }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* 左缘拖拽条 */}
                <div
                    class="absolute inset-y-0 left-0 w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 z-10"
                    onMouseDown={onGripDown}
                />
                {/* 卡片头部：URI + 试验场 + 关闭 */}
                <div class={`flex items-center justify-between px-4 ${VIEW_BAR_H} border-b shrink-0`}>
                    <span class="text-body font-mono opacity-60 truncate max-w-[300px]">
                        {taskStore.selectedUri}
                    </span>
                    <div class="flex items-center gap-1">
                        <button class="btn btn-ghost btn-xs" onClick={() => taskStore.selectTask(null)}>
                            ✕
                        </button>
                    </div>
                </div>

                {/* 任务详情（唯一内容）。**不再有 tab** —— 会话已移到任务执行页的
                    chat area，这里只剩详情本身，故无需在两种东西之间切换。 */}
                <div
                    class="flex-1 overflow-auto p-4"
                    ref={(el) => (detailScrollRef = el)}
                    onScroll={(e) => {
                        const u = taskStore.selectedUri;
                        if (u) localChatStore.setDetailScroll(u, e.currentTarget.scrollTop);
                    }}
                >
                        {/* keyed：每个任务一个内容组件实例。
                            非 keyed 时组件实例会被复用到下一个任务，而编辑态/草稿是在构造时
                            初始化的 —— 表现为「切回后显示上一个任务的标题」。
                            代价：改状态会重取任务并重建面板，但编辑态由草稿驱动
                            （draftStore.hasAny），只要用户改过内容就会自动恢复，无内容损失。
                            内容本体与任务执行页左栏 / nav 悬停覆盖层**同一个组件**：
                            这里宽度够（默认 560px），流式布局自动排成两列。 */}
                        <Show when={taskStore.selectedTask} keyed fallback={<div class="opacity-60 text-prose">加载中…</div>}>
                            {(t) => <TaskDetailContent uri={t.uri} task={t} host="manage" />}
                        </Show>
                </div>

                {/* 大 FAB：一键进入任务执行页（= 打开这个任务的对话）。
                    与任务状态无关 —— 打开 tab 表示「我现在要做它」，不改状态
                    （状态模型待重新设计，见 133）。面板内 absolute 定位，
                    不随详情滚动走，始终够得着。
                    措辞用「对话」而不是「开始/继续」：这个动作只是打开对话页，
                    不推进任务状态 —— 说「开始」会让人以为状态被改了。 */}
                <button
                    class="btn btn-primary btn-lg absolute bottom-4 right-4 z-20 rounded-full shadow-xl gap-2"
                    title="打开对话（任务执行页）"
                    onClick={() => {
                        const uri = taskStore.selectedUri;
                        if (uri) getRendererActions().openTaskRun?.(uri);
                    }}
                >
                    <span>💬</span>
                    <span>对话</span>
                </button>
            </div>
        </Show>
    );
}

