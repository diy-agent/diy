import { TrafficView } from "./TrafficView";

/** 导航栏「流量」页 —— 跨会话查看应用发出的全部 HTTP 请求 / 响应。 */
export function TrafficPage() {
    return (
        <div class="flex flex-col p-4 h-full min-h-0">
            <TrafficView />
        </div>
    );
}
