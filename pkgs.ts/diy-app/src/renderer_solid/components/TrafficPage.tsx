/**
 * TrafficPage — 导航栏「流量」页：跨会话查看应用发出的全部 HTTP 请求 / 响应。
 *
 * 布局（viewset，走 ViewGrid —— 与普通 page 一致）：
 *   左  基本信息（告警 / 完整记录开关 / 日志体积 / 查询条 / 请求表）
 *   右  请求 / 响应编辑器（选中那条记录的概览 + 两个 JsonViewer）
 * 两块共享**同一份** state（`createTrafficState()`）：点左栏一行，右栏即跟着换 ——
 * 这是"基本信息 + 编辑器"两栏该有的行为，而不是两个各自独立的列表。
 *
 * 本组件不自己拼布局 —— 交给 ViewGrid 消费 layout + binding：
 * 每个 area 自带最大化 / 最小化 chrome，菜单条给 area 开合入口（同 TaskRunPage）。
 */
import { For } from "solid-js";
import { areasWithViews, findPage } from "../../shared/view-registry";
import { ViewGrid } from "./ViewGrid";
import { layoutStore } from "../store/layoutStore";
import { createTrafficState, TrafficDetail, TrafficList } from "./TrafficView";
import { VIEW_BAR_H } from "../lib/layout-metrics";

const PAGE = findPage("traffic")!;
/** area 序号（① ② …）—— 与 TaskRunPage 同一套「按钮先用序号替代图标」的占位（见 133） */
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

export function TrafficPage() {
    const st = createTrafficState();
    const binding = () => layoutStore.bindingFor(PAGE, null);

    /** 菜单条只列**有 view 的 area**（空 area 的按钮点了没反应，见 TaskRunPage） */
    const menuAreas = () => {
        const has = areasWithViews(PAGE, null, binding());
        return PAGE.layout.areas.map((a, idx) => ({ area: a, idx })).filter((x) => has.has(x.area.id));
    };

    return (
        <div class="flex flex-col h-full overflow-hidden" data-traffic-page>
            <div class={`flex items-center gap-2 border-b px-3 ${VIEW_BAR_H} text-body shrink-0`}>
                <span class="font-medium">流量</span>
                <span class="text-caption opacity-50">跨会话查看应用发出的全部 HTTP 请求 / 响应</span>
                <div class="flex-1" />
                <For each={menuAreas()}>
                    {({ area, idx }) => (
                        <button
                            class={`btn btn-xs ${layoutStore.isHidden(PAGE.id, area.id) ? "btn-ghost opacity-50" : "btn-active"}`}
                            title={`${area.id}（区域 ${idx + 1}）开合`}
                            aria-pressed={!layoutStore.isHidden(PAGE.id, area.id)}
                            onClick={() => layoutStore.toggleArea(PAGE.id, area.id)}
                        >
                            {CIRCLED[idx] ?? idx + 1} {area.id}
                        </button>
                    )}
                </For>
            </div>

            <div class="flex-1 min-h-0">
                <ViewGrid
                    pageId={PAGE.id}
                    ctx={null}
                    layout={PAGE.layout}
                    binding={binding()}
                    renderView={(viewId) => {
                        switch (viewId) {
                            case "traffic.list":
                                return <TrafficList st={st} />;
                            case "traffic.detail":
                                return <TrafficDetail st={st} />;
                            default:
                                return <div class="p-3 text-body opacity-60">未注册的 view: {viewId}</div>;
                        }
                    }}
                />
            </div>
        </div>
    );
}
