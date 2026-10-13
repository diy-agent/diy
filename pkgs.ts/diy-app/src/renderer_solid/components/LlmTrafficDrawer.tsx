import { Show } from "solid-js";
import { LlmTrafficView } from "./LlmTrafficPanel";
import { llmTrafficStore } from "../store/llmTrafficStore";
import { useDrawerMax, DrawerMaxButton } from "./DrawerMaximize";
import { VIEW_BAR_H } from "../lib/layout-metrics";

/**
 * 聊天侧流量抽屉 —— 与 `UsageDrawer` / `TurnUsageDetailDrawer` 同款形态：
 * 全宽贴顶、默认 2/3 屏、可最大化、点遮罩/✕ 关闭。
 *
 * 为什么是抽屉而不是页面：查流量是**贴着当前对话**发生的（「我刚才那条为什么 400」）。
 * 抽屉不打断对话上下文，关掉即回到原处；「当前会话」语义天然成立。跨会话的全景可在
 * 🧠 LLM 页（`LlmTrafficPanel`）看 —— 两处同一份数据、同一个 `LlmTrafficView`。
 *
 * 开关是全局 `llmTrafficStore`：错误块能一键深链进来（见 `ErrorBox` 的「查看流量 →」）。
 */
export function LlmTrafficDrawer() {
    const DM = useDrawerMax();
    return (
        <Show when={llmTrafficStore.open}>
            <div class="fixed inset-0 z-50 flex flex-col" onClick={() => llmTrafficStore.close()}>
                <div class="absolute inset-0 bg-black/30" />
                <div
                    class="relative flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-base-300 bg-base-100 shadow-2xl"
                    style={DM.style()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div class={`flex shrink-0 items-center gap-2 border-b px-4 ${VIEW_BAR_H}`}>
                        <div class="text-title font-medium">LLM 流量</div>
                        <div class="ml-auto" />
                        <DrawerMaxButton max={DM.max()} onToggle={DM.toggle} />
                        <button
                            class="btn btn-ghost btn-xs"
                            onClick={() => llmTrafficStore.close()}
                            aria-label="关闭流量面板"
                        >
                            ✕
                        </button>
                    </div>
                    <div class="min-h-0 flex-1 p-4">
                        <LlmTrafficView
                            focusTraceId={llmTrafficStore.focusTraceId}
                            onFocusConsumed={() => llmTrafficStore.clearFocus()}
                            showIntro={false}
                        />
                    </div>
                </div>
            </div>
        </Show>
    );
}
