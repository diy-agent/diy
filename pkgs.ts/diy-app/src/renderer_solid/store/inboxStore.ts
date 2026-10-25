// src/renderer_solid/store/inboxStore.ts
// 🎯 通知信箱的**界面侧**（##429 要求 ④/⑤）：把 main 落盘的 N1 条目变成一条 toast。
//
// 分工（与 `modelNoticeStore` 同形，但数据源不同）：
//   · main（`services/inbox.ts`）：判据 + 落盘（`$DIY_HOME/local/inbox.jsonl`）+ 广播；
//   · 这里：订阅增量 → 弹一条 toast（**带二级信息**，##391 的硬要求）→ 别的什么都不做。
//
// 为什么不回放历史：信箱的用途是"事后回看"，`diy notice inbox` / 将来的信箱面板负责它。
// 把历史条目当 toast 重放，会在每次窗口重载时糊用户一脸"你昨天超了预算"。
//
// 一个条目只弹一次：`seen` 按 id 去重（订阅首帧 / 重连不会重复弹同一条）。

import { diyService } from "../lib/rpc";
import { notificationStore } from "./notificationStore";
import type { InboxEntry } from "../../shared/inbox";

/** 已弹过的条目 id（只保留最近若干，够去重就行 —— toast 本身有寿命） */
const seen = new Set<string>();
const SEEN_MAX = 200;

let abort: AbortController | undefined;

/** 把一条信箱条目变成 toast（导出以便单测直接钉文案/二级信息） */
export function toastOfEntry(e: InboxEntry): { type: "info" | "error"; message: string; meta: { source: string; reason: string; detail: string } } {
    return {
        // 撞上限：模型话没说完就断了（有实际损失）⇒ error 色；成本告警只是"提醒"⇒ info
        type: e.kind === "max-tokens" ? "error" : "info",
        message: e.text,
        meta: { source: e.source, reason: e.reason, detail: e.detail },
    };
}

function remember(id: string): void {
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > SEEN_MAX) {
        // Set 保序：删最早的那批（够用即可，不做 LRU）
        const drop = seen.size - SEEN_MAX;
        let i = 0;
        for (const k of seen) {
            if (i++ >= drop) break;
            seen.delete(k);
        }
    }
}

function start(): void {
    if (abort) return;
    const ctrl = new AbortController();
    abort = ctrl;
    void diyService.diy.notice.inbox
        .watch({}, { signal: ctrl.signal })
        .then(async (stream) => {
            for await (const e of stream) {
                if (seen.has(e.id)) continue;
                remember(e.id);
                const t = toastOfEntry(e);
                notificationStore.addToast(t.type, t.message, t.meta, { duration: 8000 });
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

export const inboxStore = { start, stop, toastOfEntry };
