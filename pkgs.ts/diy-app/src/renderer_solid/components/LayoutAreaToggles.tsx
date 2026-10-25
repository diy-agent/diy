import { For } from "solid-js";
import { areasWithViews, type PageDef } from "../../shared/view-registry";
import { layoutStore } from "../store/layoutStore";

/**
 * page 菜单条上的「区域开合」按钮组 —— **只列有点击价值的 area**（本 page 实例下有 view 的）。
 * 给空 area 渲染按钮就是「点了没反应」的噪音。
 *
 * 为什么抽出来（2026-10-21，用户报「上下文树页有最小化按钮，但没有恢复按钮」）：
 * `ViewGrid` 的 area 右上角**最小化是单向动作** —— 收起后 chrome 随 area 一起消失，
 * 恢复入口只有这一个按钮组。此前 TaskRunPage / TrafficPage / PromptLabV4Page **各抄了一份**，
 * 而 ContextLabPage 漏抄 ⇒ 那个页上最小化 = 区域永久消失（只能 `diy ui view area` 救回来）。
 * 复制粘贴导致「谁抄到谁有恢复入口」，这类基础设施必须一份。
 *
 * `idx` 保留 area 在 `layout.areas` 里的原始序号 —— 序号表达「第几个区域」，与网格位置对应。
 */
export function LayoutAreaToggles(props: { page: PageDef; ctx: string | null }) {
    const menuAreas = () => {
        const has = areasWithViews(props.page, props.ctx, layoutStore.bindingFor(props.page, props.ctx));
        return props.page.layout.areas
            .map((area, idx) => ({ area, idx }))
            .filter((x) => has.has(x.area.id));
    };
    // area 序号（① ② ③ …）：按钮先用序号替代图标（动态绘制随 grid 结构变化的图标待定）
    const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
    const hidden = (areaId: string): boolean => layoutStore.isHidden(props.page.id, areaId);
    return (
        <For each={menuAreas()}>
            {({ area, idx }) => (
                <button
                    class={`btn btn-xs ${hidden(area.id) ? "btn-ghost opacity-50" : "btn-active"}`}
                    title={`${area.id}（区域 ${idx + 1}）开合`}
                    aria-pressed={!hidden(area.id)}
                    onClick={() => layoutStore.toggleArea(props.page.id, area.id)}
                >
                    {CIRCLED[idx] ?? idx + 1} {area.id}
                </button>
            )}
        </For>
    );
}
