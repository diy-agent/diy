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
import { onMount, createEffect, on, For } from "solid-js";
import { findPage, defaultBinding } from "../../shared/view-registry";
import type { Layout } from "../../shared/grid-layout";
import { ViewGrid } from "./ViewGrid";
import { TaskSideView } from "./TaskSideView";
import { LocalChatPage } from "./LocalChatPage";
import { taskStore } from "../store/taskStore";
import { layoutStore } from "../store/layoutStore";
import { getRendererActions } from "../lib/renderer-actions";

const PAGE = findPage("task-run")!;

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

    /** 试验场（bottom area）默认收起：底部行初始 0，点布局按钮才展开 */
    const areas = () => PAGE.layout.areas;
    const layout = (): Layout => PAGE.layout;
    const binding = () => defaultBinding(PAGE, props.uri);

    /** area 序号（① ② ③ …）：布局按钮先用序号替代图标（动态绘制图标待定，见 133） */
    const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

    return (
        <div class="flex flex-col h-full overflow-hidden">
            {/* page 级菜单条：布局是页面级的事，切换入口放这里（不在任何 view 内部）。
                与 VSCode 的布局切换同构：控制 viewarea 的开合，与 view 内容无关。 */}
            <div class="flex items-center gap-2 border-b px-3 py-1.5 text-xs shrink-0">
                <span class="font-mono opacity-60 truncate" title={props.uri}>
                    {props.uri}
                </span>
                <div class="flex-1" />
                {/* 打开提示词页（**子页面**：中心是系统提示词，挂在当前任务 tab 之下）。
                    关掉本任务 tab 时它会一并关闭（tabStore 保证）。 */}
                <button
                    class="btn btn-xs btn-ghost"
                    title="打开提示词页（调模版 / 看变量 / 请求预览）"
                    onClick={() => getRendererActions().openLab?.(props.uri)}
                >
                    🪟 提示词
                </button>
                {/* 布局切换：**本 page 有几个 area 就有几个按钮**（不是只给试验场一个）。
                    点一下开合该 area。图标用序号替代 —— 动态绘制随 grid 结构变化的图标
                    待定（见 133），序号先保证「结构可见、可操作」。 */}
                <For each={areas()}>
                    {(a, i) => (
                        <button
                            class={`btn btn-xs ${layoutStore.isHidden(PAGE.id, a.id) ? "btn-ghost opacity-50" : "btn-active"}`}
                            title={`${a.id}（区域 ${i() + 1}）开合`}
                            aria-pressed={!layoutStore.isHidden(PAGE.id, a.id)}
                            onClick={() => layoutStore.toggleArea(PAGE.id, a.id)}
                        >
                            {CIRCLED[i()] ?? i() + 1} {a.id}
                        </button>
                    )}
                </For>
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
                            default:
                                return <div class="p-3 text-xs opacity-60">未注册的 view: {viewId}</div>;
                        }
                    }}
                />
            </div>
        </div>
    );
}
