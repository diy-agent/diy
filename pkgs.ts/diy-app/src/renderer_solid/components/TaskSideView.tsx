/**
 * TaskSideView — 任务详情的**侧栏形态**：内容区顶栏 + 独立滚动 + TaskDetailContent。
 *
 * 两处复用（内容本体在 TaskDetailContent，这里只负责「窄侧栏」的外壳）：
 *   1. 任务执行页左栏（分栏里的 task.detail view）
 *   2. nav 悬停任务项时的覆盖层
 * 任务管理详情面板不用本组件 —— 那里自带滚动容器，直接放 TaskDetailContent。
 *
 * 为什么内容组件自己取数、不听全局 selectedTask：见 TaskDetailContent 的文件头。
 */
import { TaskDetailContent } from "./TaskDetailContent";
import { taskStore } from "../store/taskStore";
import { getRendererActions } from "../lib/renderer-actions";
import { VIEW_BAR_H } from "../lib/layout-metrics";

/**
 * 跳转任务管理 = 任务管理表格点任务名那个动作（选中它、去任务管理页看详情）。
 *
 * 2026-10-03 用户指令把入口**从血缘树行内按钮移到本 view 的 bar**：树里每行一个按钮
 * 噪音大，且「进对话」与「去任务管理」两个动作挤在一行容易点错；统一收在详情 view 的
 * bar 上，与放大/缩小同处一栏。
 */
function gotoTaskManager(uri: string): void {
    void taskStore.selectTask(uri);
    getRendererActions().navigate?.("task");
    // RV-01（##245 review）：navigate 内部的无参 reveal 取的是「活动 tab 的任务」，
    // 覆盖层场景下那是会话任务 A 而非本按钮的目标 B → 闪高亮/滚动会定位到错误任务。
    // 这里补**显式** reveal 以目标 uri 覆盖之（nonce 后者胜）。
    getRendererActions().revealTask?.(uri);
}

export function TaskSideView(props: { uri: string; hoverPreview?: boolean; chromeGap?: boolean }) {
    return (
        <div data-task-side-view class="flex flex-col h-full overflow-hidden">
            <div class={`flex items-center gap-2 px-3 ${VIEW_BAR_H} border-b shrink-0`}>
                <span class="text-body font-bold tracking-wide opacity-60">任务详情</span>
                {/* 跳转任务管理：右对齐，和 area 右上角的放大/缩小 chrome 同处一栏。
                    chromeGap = area 有 chrome 浮在右上（任务执行页左栏）→ 留出它的位置，
                    否则按钮会被 chrome 盖住。 */}
                <button
                    class={`btn btn-ghost btn-xs px-1 min-h-0 ml-auto shrink-0 ${props.chromeGap ? "mr-12" : ""}`}
                    data-tip="去任务管理（看这个任务的详情）"
                    aria-label="跳转任务管理"
                    onClick={(e) => {
                        // stopPropagation：否则事件冒泡到 <main> 的「点空白关面板」处理器，
                        // 刚选中的任务又立刻被取消选中（切页那一拍 route 已变成 task）—— 面板打不开。
                        e.stopPropagation();
                        gotoTaskManager(props.uri);
                    }}
                >
                    📋
                </button>
            </div>
            <div class="flex-1 overflow-y-auto px-3 py-3 min-h-0">
                <TaskDetailContent uri={props.uri} hoverPreview={props.hoverPreview ?? true} />
            </div>
        </div>
    );
}
