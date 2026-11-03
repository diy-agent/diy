import { createSignal, Show } from "solid-js";
import { TrafficView } from "./TrafficView";
import { trafficStore } from "../store/trafficStore";
import { DrawerMaxButton } from "@diy-agent/ui-kit";
import { VIEW_BAR_H } from "../lib/layout-metrics";

/**
 * 聊天侧流量抽屉 —— 与 `UsageDrawer` / `TurnUsageDetailDrawer` 同款形态：
 * 全宽贴顶、默认 2/3 屏、可最大化、点遮罩/✕ 关闭；底边可上下拖拽改高度。
 *
 * 为什么是抽屉而不是页面：查流量常常是**贴着当前对话**发生的（「我刚才那条为什么 400」）。
 * 抽屉不打断对话上下文，关掉即回到原处。要跨会话看全部，去导航栏的「流量」页。
 *
 * 开关是全局 `trafficStore`：错误提示块能一键深链进来（见 `ErrorBox` 的「查看实际请求 / 响应」）。
 */
export function TrafficDrawer() {
    const [h, setH] = createSignal(66.666); // 视口高度百分比
    const [max, setMax] = createSignal(false);
    const style = () => ({ height: max() ? "100vh" : `${h()}vh` });

    const startDrag = (e: MouseEvent) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = h();
        const onMove = (ev: MouseEvent) => {
            const dh = ((ev.clientY - startY) / window.innerHeight) * 100;
            setH(Math.min(100, Math.max(12, startH + dh)));
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    return (
        <Show when={trafficStore.open}>
            <div class="fixed inset-0 z-50 flex flex-col" data-find-surface onClick={() => trafficStore.close()}>
                <div class="absolute inset-0 bg-black/30" />
                <div
                    class="relative flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-base-300 bg-base-100 shadow-2xl"
                    style={style()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div class={`flex shrink-0 items-center gap-2 border-b px-4 ${VIEW_BAR_H}`}>
                        <div class="text-title font-medium">流量</div>
                        <div class="ml-auto" />
                        <DrawerMaxButton max={max()} onToggle={() => setMax((v) => !v)} />
                        <button
                            class="btn btn-ghost btn-xs"
                            onClick={() => trafficStore.close()}
                            aria-label="关闭流量面板"
                        >
                            ✕
                        </button>
                    </div>
                    <div class="min-h-0 flex-1 p-4">
                        <TrafficView
                            focus={trafficStore.focus}
                            onFocusConsumed={() => trafficStore.clearFocus()}
                            showIntro={false}
                        />
                    </div>
                    {/* 底边拖拽手柄：上下拖动改抽屉高度 */}
                    <div
                        class="absolute inset-x-0 bottom-0 h-1.5 cursor-row-resize hover:bg-primary/40 active:bg-primary/60"
                        title="拖动调整高度"
                        onMouseDown={startDrag}
                    />
                </div>
            </div>
        </Show>
    );
}
