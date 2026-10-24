/**
 * TaskRunPage — 任务执行页（每个打开的任务一个实例）。
 *
 * 布局（见 133 与 shared/view-registry 的 TASK_RUN_LAYOUT）：
 *   左  任务详情（简化版，只读为主）
 *   中  chat
 *   右  房间成员栏（##377 第 16 刀；默认收起，成员 > 1 时自动展开）
 *   底  试验场（devtools viewarea，默认收起）
 *
 * 本组件不自己拼布局 —— 交给 ViewGrid 消费 layout + binding，
 * 加/减 view 只改 view 注册表，本文件不动。
 */
import { onMount } from "solid-js";
import { findPage } from "../../shared/view-registry";
import type { Layout } from "../../shared/grid-layout";
import { ViewGrid } from "./ViewGrid";
import { TaskSideView } from "./TaskSideView";
import { LocalChatPage } from "./LocalChatPage";
import { TaskRoomRoster } from "./TaskRoomRoster";
import { JobRunsPanel } from "./JobRunsPanel";
import { jobRunsStore } from "../store/jobRunsStore";
import { taskStore } from "../store/taskStore";
import { layoutStore } from "../store/layoutStore";
import { getRendererActions } from "../lib/renderer-actions";
import { VIEW_BAR_H } from "../lib/layout-metrics";
import { LayoutAreaToggles } from "./LayoutAreaToggles";

const PAGE = findPage("task-run")!;

export function TaskRunPage(props: { uri: string }) {
    // 子组件（chat / 试验场）当前沿用 taskStore.selectedUri；本页把「当前 tab」
    // 与「选中任务」对齐，故这里负责同步。将来做 tab 保活时再改为逐实例传 uri。
    onMount(() => void taskStore.selectTask(props.uri));
    /**
     * 底栏（作业）**按需自动展开**：本任务已经有作业时展开一次。
     *
     * 判据与右栏成员栏同源（##166 §44.1 ②）：用户从没手动动过本页布局时才自动；
     * 而且只在**挂载/切任务**时判一次，不做「一出现新作业就弹面板」——
     * 那会在用户正读会话时突然压掉 320px 的阅读区（比"要自己点一下"更烦人）。
     * 说清楚代价：本次会话里**新**产生的作业不自动弹，但页面菜单条上有「④ bottom」可开，
     * 且列表本身每 3s 自刷（面板可见时）。
     */
    void jobRunsStore.refresh().then(() => {
        if (layoutStore.userTouched(PAGE.id)) return;
        if (jobRunsStore.runsFor(props.uri).length === 0) return;
        layoutStore.setAreaHiddenAuto(PAGE.id, "bottom", false);
    });
    // 右栏（成员栏）的默认开合（##166 §44.1 ②）**不在这里**做 —— 挪到 `LocalChatPage`：
    // 它（中心会话区）恒挂载、且成员表本来就在它手里；而"右栏收起时 `ViewGrid` 不挂载右栏 view"
    // 这条死结（`groups()` 按 `plan().visibleAreaIds` 过滤）对中心区不成立。
    // 本组件只把 pageId 递下去（自动开合要写布局，得知道写哪个 page）。

    const layout = (): Layout => PAGE.layout;
    const binding = () => layoutStore.bindingFor(PAGE, props.uri);

    return (
        <div class="flex flex-col h-full overflow-hidden">
            {/* page 级菜单条：布局是页面级的事，切换入口放这里（不在任何 view 内部）。
                与 VSCode 的布局切换同构：控制 viewarea 的开合，与 view 内容无关。 */}
            <div class={`flex items-center gap-2 border-b px-3 ${VIEW_BAR_H} text-body shrink-0`}>
                {/* 任务 URI 已移进「任务属性」view（2026-10-03 用户拍板 A 方案：
                    page 菜单条只留页面级入口，信息性字段归属性面板） */}
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
                {/* 打开上下文树页（**独立子页面**：真实上下文 + 划分规则，与提示词页互不干扰） */}
                <button
                    class="btn btn-xs btn-ghost"
                    title="打开上下文树页（变量树 / 划分规则 / system 与 runtime 两份投递）"
                    onClick={() => getRendererActions().openTab?.("ctxlab", props.uri)}
                >
                    🌲 上下文树
                </button>
                {/* 打开大脑页（**独立子页面**：脑容量账 / 记分 / 多步趋势 + 信号）—— 与上下文树平行，
                    分工是"钱花在哪"而不是"变量变了什么" */}
                <button
                    class="btn btn-xs btn-ghost"
                    title="打开大脑页（每步思考的预算构成 / 记分 / 多步趋势与信号）"
                    onClick={() => getRendererActions().openTab?.("brain", props.uri)}
                >
                    🧠 大脑
                </button>
                {/* 打开泳道视图页（**独立子页面**：轨迹折线 + 每步产物 + 参数表单，##320） */}
                <button
                    class="btn btn-xs btn-ghost"
                    title="打开泳道视图页（轨迹折线 / 节点详情 / 参数表单）"
                    onClick={() => getRendererActions().openTab?.("flow", props.uri)}
                >
                    🛤 泳道
                </button>
                {/* 布局切换：只给**有 view 的 area** 渲染按钮（一份实现见 LayoutAreaToggles）。
                    这是 `ViewGrid` 最小化后**唯一**的恢复入口 —— 漏接 = 区域永久消失。 */}
                <LayoutAreaToggles page={PAGE} ctx={props.uri} />
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
                                return <TaskSideView uri={props.uri} hoverPreview={true} chromeGap={true} />;
                            case "chat.local":
                                // `rosterAutoFor`：让会话区按"当前任务的成员数"决定右栏默认开合
                                // （口径 §44.1 ②；见 LocalChatPage 的 applyRosterAuto）
                                return <LocalChatPage uri={props.uri} rosterAutoFor={PAGE.id} />;
                            case "job.runs":
                                // 作业面板（##408 刀 6）：只读列表 + 来源导航
                                return <JobRunsPanel uri={props.uri} />;
                            case "room.roster":
                                // 右栏成员栏（##377 第 16 刀 / ##166 §43.3 A）：
                                // 任务恒是一个 room（§28.7 G，id = taskUri）⇒ 这个 view 就是它的成员表
                                return <TaskRoomRoster uri={props.uri} />;
                            default:
                                return <div class="p-3 text-body opacity-60">未注册的 view: {viewId}</div>;
                        }
                    }}
                />
            </div>
        </div>
    );
}
