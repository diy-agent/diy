/**
 * OpsDownBar — 会话页「实时更新中断」**常驻条**（##354 ③ 的形态 + ##391 的二级信息）。
 *
 * 为什么是常驻条而不是 toast：op 订阅是实时显示的**唯一**通道（##327 单通道化），它断了
 * 就等于用户一个字也看不到，而那种状态在界面上与「模型还在想」完全同形。一次性 toast 在
 * 「故障瞬间切走窗口」时必然错过，也读不到「现在还没恢复」。故它**在故障期间一直在**，
 * 恢复（`markOpsLive`）才消失 —— 状态可见的生命周期与故障本身等长。
 *
 * ##391 补的是**二级信息**（用户原话「所有用户可见的提示都需要有来源/原因/详情」）：
 *   · 一级（这行字）：中断了 + 正在自动重连（不打扰，不铺术语）
 *   · 二级（`[详情]`）：来源（opsWatch + 代码位置）/ 原因（**从几点开始断、已经断了多久、
 *     期间重订几次**）/ 机制（单通道、1s 重订、按行号补发、历史不丢）
 *
 * 为什么自带 1s ticker：没有它，「已持续 Ns」停在常驻条首次渲染的那一刻 —— 一条中断了 3 分钟
 * 的提示却写着「2s」，比没有数字更误导。ticker 只在本条挂载期间跑（故障消失即卸载）。
 */
import { createSignal, onCleanup, onMount } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import { opsDownMeta } from "../lib/notice-ops";
import { formatClock } from "../lib/notice";
import { NoticeDetail } from "./NoticeDetail";

export function OpsDownBar() {
    const [now, setNow] = createSignal(Date.now());
    onMount(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        onCleanup(() => clearInterval(t));
    });
    const meta = () =>
        opsDownMeta({ since: localChatStore.opsDownSince, now: now(), reconnects: localChatStore.opsReconnects });

    return (
        <div
            data-ops-down="1"
            role="status"
            aria-live="polite"
            class="flex shrink-0 flex-wrap items-center gap-2 border-b border-error/40 bg-error/10 px-3 py-1.5 text-body text-error"
        >
            <span class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-error" />
            <span class="shrink-0 font-medium">会话实时更新中断</span>
            <span class="opacity-80">正在自动重连…（重连成功后补齐，历史不丢）</span>
            <span class="ml-auto text-xs opacity-70">
                {/* 一级也带上「从几点开始」：一眼能对表，不必先说"出事"再点详情才发现 */}
                自 {formatClock(localChatStore.opsDownSince ?? now())} 起
            </span>
            <NoticeDetail meta={meta()} label="详情" />
        </div>
    );
}
