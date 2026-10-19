// src/renderer_solid/store/envWatchStore.ts
// 🎯 「环境感知」通知的 renderer 侧状态（##384）—— 顶栏红条的**唯一数据源**。
//
// 分工：判据与产生都在 main（只有 main 能采 statfs / 拿到写失败的 ENOSPC / 见到真发的错误码，
// 见 main/services/env-watch.ts）；本 store 只订阅 + 维护"当前要显示哪几条"+ 送关闭意图。
//
// 显示语义与 modelNoticeStore **刻意不同**：
//   · 那边一次只显示最新一条（同一波失败原因必然相同）；
//   · 这里**多条并存**——磁盘满与网断可以同时发生，只显示一条就会漏掉另一件同样急的事。
//     故按 type 去重（同 type 只留最新，由 main 侧保证）、按时间升序堆叠，最多显示 3 条。
//
// 「自动消」靠 main 推 `resolve` 事件（不是本 store 猜）：条件恢复（腾出空间 / 网络通了）
// 时红条必须自己消失 —— 这是硬要求，用户不该为"它已经好了"去点 ✕。

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import type { EnvNotice } from "../../shared/env-watch";

/** 最多同时展示几条（超出的折叠成计数）：再多人就不看了（告警疲劳） */
export const MAX_BARS = 3;

const [notices, setNotices] = createSignal<EnvNotice[]>([]);

let abort: AbortController | undefined;

/**
 * 起订阅（App 顶层 onMount 调一次；stop 时取消）。
 *
 * 订阅**首帧带回放**（main 侧语义）：页面重载 / 断线重连后红条能自己回来 ——
 * 用户重开窗口正是最容易错过提示的时刻，"只推增量"会让提示随重载一起消失。
 */
function start(): void {
    if (abort) return;
    const ctrl = new AbortController();
    abort = ctrl;
    void diyService.diy.env
        .watch({}, { signal: ctrl.signal })
        .then(async (stream) => {
            for await (const ev of stream) {
                if (ev.kind === "resolve") {
                    const id = ev.data.id;
                    setNotices((prev) => prev.filter((n) => n.id !== id));
                } else {
                    const n = ev.data;
                    setNotices((prev) => [...prev.filter((x) => x.type !== n.type), n]);
                }
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
 * 关闭一条（bar 上的 ✕）。
 *
 * 两步都要做：① 本地立刻移除（界面即时响应，不等 RPC 往返）② 落 main（否则下一次轮询
 * 30s 后又把同一条推回来 —— 用户点了 ✕ 却 30s 后再弹，等于没关；main 侧 dismiss 同时静音该类）。
 */
function dismiss(id: string): void {
    setNotices((prev) => prev.filter((n) => n.id !== id));
    void diyService.diy.env.dismiss({ id }).catch(() => {
        /* 关闭失败不改界面：下次轮询会重新推回来（比"假装关掉了"诚实） */
    });
}

export const envWatchStore = {
    /** 当前要显示的通知（时间升序；空数组 = 不显示） */
    get notices() {
        return notices();
    },
    /** 超出 {@link MAX_BARS} 被折叠的条数 */
    get overflow() {
        return Math.max(0, notices().length - MAX_BARS);
    },
    start,
    stop,
    dismiss,
};
