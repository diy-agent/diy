// src/renderer_solid/store/cacheHintStore.ts
// 🎯 「缓存可能已冷」那一行提示的 renderer 侧状态（##477）—— 顶栏 bar 的**唯一数据源**。
//
// 分工与 modelNoticeStore / envWatchStore 一致：判据与产生都在 main（只有真发那一刻拿得到
// 首步命中率与请求时刻，见 main/services/cache-hint.ts）；本 store 只订阅 + 记住"当前那一行"
// + 送关闭意图。
//
// 显示语义（用户硬要求）：**单一行、不叠加、不弹窗**。新的一条（另一个渠道 / 又一次越界）
// 直接**替换**旧的那行 —— 多条排队逐条弹就是刷屏，用户连点都点不到。

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import type { CacheHint } from "../../shared/cache-hint";

const [hint, setHint] = createSignal<CacheHint | null>(null);

let abort: AbortController | undefined;

/**
 * 起订阅（App 顶层 onMount 调一次）。
 *
 * 订阅**首帧带回放**（main 侧语义）：页面重载 / 断线重连后那条提示能自己回来 ——
 * 用户重开窗口正是最容易错过提示的时刻。
 */
function start(): void {
    if (abort) return;
    const ctrl = new AbortController();
    abort = ctrl;
    void diyService.diy.cacheHint
        .watch({}, { signal: ctrl.signal })
        .then(async (stream) => {
            for await (const ev of stream) {
                if (ev.kind === "show") setHint(ev.data);
                // clear 只认"当前这一条"：旧提示的 clear 不该把新提示撤掉（事件可能乱序）
                else setHint((cur) => (cur && cur.id === ev.data.id ? null : cur));
            }
        })
        .catch(() => {
            /* 断流即停（窗口关闭 / 实例退出）；重连由下一次 start 负责 */
        });
}

function stop(): void {
    abort?.abort();
    abort = undefined;
}

/**
 * ✕：关掉当前那一条。两步都做 —— 本地立刻清（界面即时响应），main 侧一并清（否则
 * 下一次重连的回放会把同一条又推回来）。
 */
function dismiss(): void {
    const cur = hint();
    setHint(null);
    if (!cur) return;
    void diyService.diy.cacheHint.dismiss({ id: cur.id }).catch(() => {
        /* 关闭失败不改界面：下次重连会重新推回来（比"假装关掉了"诚实） */
    });
}

export const cacheHintStore = {
    get hint() {
        return hint();
    },
    start,
    stop,
    dismiss,
};
