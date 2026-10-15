import { TrafficView } from "./TrafficView";
import { trafficStore } from "../store/trafficStore";

/**
 * 导航栏「流量」页 —— 跨会话查看应用发出的全部 HTTP 请求 / 响应。
 *
 * 为什么这里也读 `trafficStore.focus`：上下文树页的「在流量页打开」（##310）要**跳过来并定位**
 * 到某一步真发的那条请求。抽屉那条路（`TrafficDrawer`）只在对话页挂着，跨页跳只能走这里；
 * 两条路共用同一个 store，所以焦点语义只有一份。
 */
export function TrafficPage() {
    return (
        <div class="flex flex-col p-4 h-full min-h-0">
            <TrafficView focus={trafficStore.focus} onFocusConsumed={() => trafficStore.clearFocus()} />
        </div>
    );
}
