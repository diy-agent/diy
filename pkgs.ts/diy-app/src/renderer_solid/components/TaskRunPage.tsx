/**
 * TaskRunPage — 任务执行页（每个打开的任务一个实例）。
 *
 * 布局（见 133 与 shared/view-registry 的 TASK_RUN_LAYOUT）：
 *   左  任务详情（简化版，只读为主）
 *   中  chat
 *   右  预留（agent 参数状态，未实现，初始宽度 0）
 *   底  试验场（devtools viewarea，默认收起）
 *
 * 本组件不自己拼布局 —— 交给 ViewGrid 消费 layout + binding，
 * 加/减 view 只改 view 注册表，本文件不动。
 */
import { onMount, createEffect, on } from "solid-js";
import { findPage, defaultBinding } from "../../shared/view-registry";
import { fr, px, type Layout } from "../../shared/grid-layout";
import { ViewGrid } from "./ViewGrid";
import { TaskSideView } from "./TaskSideView";
import { LocalChatPage } from "./LocalChatPage";
import { PromptLabV4Page } from "./PromptLabV4Page";
import { taskStore } from "../store/taskStore";
import { layoutStore } from "../store/layoutStore";

const PAGE = findPage("task-run")!;
/** 试验场展开时的高度（px）。它是 devtools，不该抢主区空间 */
const LAB_HEIGHT = 320;

export function TaskRunPage(props: { uri: string }) {
    // 子组件（chat / 试验场）当前沿用 taskStore.selectedUri；本页把「当前 tab」
    // 与「选中任务」对齐，故这里负责同步。将来做 tab 保活时再改为逐实例传 uri。
    onMount(() => void taskStore.selectTask(props.uri));
    createEffect(
        on(
            () => props.uri,
            (uri) => void taskStore.selectTask(uri),
        ),
    );

    const labOpen = () => layoutStore.labOpen;

    /** 收起时行高为 0；同时把该 view 置为「隐藏」（binding = null），
     *  而非从注册表删掉 —— 实例不被销毁重建，状态保留 */
    const layout = (): Layout =>
        labOpen() ? { ...PAGE.layout, rows: [fr(1), px(LAB_HEIGHT)] } : PAGE.layout;

    const binding = () => {
        const b = defaultBinding(PAGE, props.uri);
        if (!labOpen()) b[`lab.workbench@${props.uri}`] = null;
        return b;
    };

    return (
        <div class="flex flex-col h-full overflow-hidden">
            {/* page 级菜单条：布局是页面级的事，切换入口放这里（不在任何 view 内部）。
                与 VSCode 的布局切换同构：控制 viewarea 的开合，与 view 内容无关。 */}
            <div class="flex items-center gap-2 border-b px-3 py-1.5 text-xs shrink-0">
                <span class="font-mono opacity-60 truncate" title={props.uri}>
                    {props.uri}
                </span>
                <div class="flex-1" />
                <button
                    class={`btn btn-xs ${labOpen() ? "btn-active" : "btn-ghost"}`}
                    title="试验场（底部面板）开合"
                    aria-pressed={labOpen()}
                    onClick={() => layoutStore.toggleLab()}
                >
                    🪟 试验场
                </button>
            </div>

            <div class="flex-1 min-h-0">
                <ViewGrid
                    pageId={PAGE.id}
                    ctx={props.uri}
                    layout={layout()}
                    binding={binding()}
                    renderView={(viewId) => {
                        switch (viewId) {
                            case "task.detail":
                                return <TaskSideView uri={props.uri} />;
                            case "chat.local":
                                return <LocalChatPage />;
                            case "lab.workbench":
                                return <PromptLabV4Page />;
                            default:
                                return <div class="p-3 text-xs opacity-60">未注册的 view: {viewId}</div>;
                        }
                    }}
                />
            </div>
        </div>
    );
}
