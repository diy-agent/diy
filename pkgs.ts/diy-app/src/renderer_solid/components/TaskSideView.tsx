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
import { VIEW_BAR_H } from "../lib/layout-metrics";

export function TaskSideView(props: { uri: string; hoverPreview?: boolean }) {
    return (
        <div data-task-side-view class="flex flex-col h-full overflow-hidden">
            <div class={`flex items-center gap-2 px-3 ${VIEW_BAR_H} border-b shrink-0`}>
                <span class="text-body font-bold tracking-wide opacity-60">任务详情</span>
            </div>
            <div class="flex-1 overflow-y-auto px-3 py-3 min-h-0">
                <TaskDetailContent uri={props.uri} hoverPreview={props.hoverPreview ?? true} />
            </div>
        </div>
    );
}
