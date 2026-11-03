// src/renderer_solid/store/modelNoticeStore.ts
// 🎯 「模型不可用」通知的 renderer 侧状态（##369 ①）—— 顶栏 bar 的**唯一数据源**。
//
// 分工：判据与产生都在 main（只有真发失败那一刻才拿得到状态码与上游原文，见
// main/services/model-notice.ts）；本 store 只订阅 + 记住"当前要显示哪一条"+ 送关闭意图。
//
// 显示语义：**一次只显示最新一条**。多条并存时排队逐条弹是过度设计 —— 同一波失败
// 原因几乎必然相同（同一个模型 / 同一把 key），把最新一条说清楚就够，点 ✕ 时
// 一次把当前这波全部关掉（main 侧 dismiss 不给 id = 全关）。

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import type { ModelUnavailableNotice } from "../../shared/model-unavailable";

const [notice, setNotice] = createSignal<ModelUnavailableNotice | null>(null);

/** 回看窗口（##407）：关掉 bar 不该让「刚才发生了什么」无解；与 main 侧 ring 同量级 */
const MAX_HISTORY = 20;

/**
 * 本次会话见过的通知（**关掉也留着**）。用途只有一个：提示关掉之后的**回看** ——
 * 用户点 ✕ 时通常正忙，回头想「刚才那条到底是哪个模型、该去哪改」时还能找回来。
 * 全局通知信箱（`level.inbox`）尚未实现（`tool.wake-gap`），故这里只做这一条的定向回看。
 */
const [history, setHistory] = createSignal<ModelUnavailableNotice[]>([]);

let abort: AbortController | undefined;

/**
 * 起订阅（App 顶层 onMount 调一次；stop 时取消）。
 *
 * 订阅**首帧带回放**（main 侧语义）：页面重载 / 断线重连后 bar 能自己回来 ——
 * 用户重开窗口正是最容易错过提示的时刻，"只推增量"会让提示随重载一起消失。
 */
function start(): void {
    if (abort) return;
    const ctrl = new AbortController();
    abort = ctrl;
    void diyService.diy.notice
        .watch({}, { signal: ctrl.signal })
        .then(async (stream) => {
            for await (const n of stream) {
                setNotice(n);
                // 订阅首帧会**回放**未关闭的通知：按 id 去重，别把同一条记两遍
                setHistory((prev) => (prev.some((p) => p.id === n.id) ? prev : [...prev, n].slice(-MAX_HISTORY)));
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
 * 关闭当前提示（bar 上的 ✕ /「知道了」）。
 *
 * 两步都要做：① 本地立刻清（界面即时响应，不等 RPC 往返）② 落 main（否则下一次
 * 重连的回放会把同一条又推回来 —— 用户点了 ✕ 却关不掉的提示等于没关）。
 */
function dismissCurrent(): void {
    const cur = notice();
    setNotice(null);
    if (!cur) return;
    void diyService.diy.notice.dismiss({ id: cur.id }).catch(() => {
        /* 关闭失败不改界面：下次重连会重新推回来（比"假装关掉了"诚实） */
    });
}

export const modelNoticeStore = {
    /** 当前要显示的通知（null = 不显示） */
    get notice() {
        return notice();
    },
    /** 回看：见过的通知（含已关闭的），旧的在前 */
    get history() {
        return history();
    },
    start,
    stop,
    dismissCurrent,
};
