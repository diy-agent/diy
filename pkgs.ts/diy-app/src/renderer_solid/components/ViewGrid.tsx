/**
 * ViewGrid — 把 layout + binding 渲染成实际界面（1:1 CSS Grid）。
 *
 * 职责边界（刻意最小）：
 *   本组件只管**几何与分组** —— 谁在哪个 area、area 多大、怎么摆。
 *   view 内部长什么样（折叠框 / tab / 菜单条）由 view 自己决定，本组件不插手。
 *   这样「以后把折叠 view 换成 tab 形式」不需要动布局层。
 *
 * 阶段 1 不做拖拽调整（数字配置优先）：故无分隔条，改布局走 `ui layout set`。
 */
import { For, type JSX } from "solid-js";
import { areaCss, trackCss, type Layout } from "../../shared/grid-layout";
import { findArea } from "../../shared/grid-layout";
import { findPage, groupViewsByArea, type Binding } from "../../shared/view-registry";
import { ViewBoundary } from "./ViewBoundary";

export function ViewGrid(props: {
    pageId: string;
    /** page 实例的上下文键（context 型 view 的实例键由它派生） */
    ctx: string | null;
    layout: Layout;
    binding: Binding;
    /** view id → 内容。areaId 传进去供动态菜单条显示"我在哪" */
    renderView: (viewId: string, areaId: string) => JSX.Element;
}) {
    const page = () => findPage(props.pageId);

    /** 按 area 分组；未声明 placement 的 view 不会出现（page 白名单由 placement 承担） */
    const groups = () => {
        const p = page();
        if (!p) return [];
        return groupViewsByArea(p, props.ctx, props.binding).map((g) => ({
            ...g,
            rect: findArea(props.layout, g.areaId),
        }));
    };

    return (
        <div
            class="grid h-full w-full overflow-hidden"
            style={{
                "grid-template-columns": props.layout.cols.map(trackCss).join(" "),
                "grid-template-rows": props.layout.rows.map(trackCss).join(" "),
            }}
        >
            <For each={groups()}>
                {(g) => (
                    <div
                        // 每个 area 一个独立错误边界：某个 view 抛错不能拖垮整页（否则又变白屏）
                        class="overflow-hidden min-w-0 min-h-0 flex flex-col"
                        style={g.rect ? areaCss(g.rect) : undefined}
                    >
                        <For each={g.views}>
                            {(def) => (
                                <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
                                    <ViewBoundary viewId={def.id}>
                                        {props.renderView(def.id, g.areaId)}
                                    </ViewBoundary>
                                </div>
                            )}
                        </For>
                    </div>
                )}
            </For>
        </div>
    );
}
