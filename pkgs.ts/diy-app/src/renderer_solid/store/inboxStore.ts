// src/renderer_solid/store/inboxStore.ts
// 🎯 通知信箱的**界面侧**（##429 要求 ④/⑤ + ##436 的列表/未读/已读水位）。
//
// 分工（与 `modelNoticeStore` 同形，但数据源不同）：
//   · main（`services/inbox.ts`）：判据 + 落盘（`$DIY_HOME/local/inbox.jsonl`）+ 广播；
//   · 这里：**回填一次历史**（列表 + 未读数要用）→ 订阅增量 → 弹 toast + 追加到列表。
//
// 为什么现在要回填：##429 那版刻意只推增量（回放历史会让每次重载糊一脸旧 toast）。
// ##436 要的是一个**上边栏可见**的信箱：未读数必须有底账，否则重启后未读数归零、用户
// 永远看不到"有 3 条没读过"。两者的折中 = **回填进列表、但不弹 toast**（去重集合 `seen`
// 在回填时先把历史 id 记满）—— 历史照旧不打扰，只当数据。
//
// 已读水位（`lastReadId`，##436 块 3）：**只存一个 id**，落视图 cache
// （`Caches.diy_inbox_last_read`，沿 `sessionStore` 已读水位的既有做法：丢了大不了多报未读，
// 不造成数据损失）。不新开账本文件 —— 水位是"用户看到哪儿了"，不是业务事实。
//
// ⚠️ **水位带数据根**（##266 硬要求）：`localStorage` 是同一个 Electron userData，而
// lab（`build/home`）与 production（`~/.diy`）的 `local/inbox.jsonl` 是两份不同的账。
// 只按条目 id 存，在 lab 里点开一次面板就会把 production 的未读一把清掉。
// 存储形态 = `<数据根>|<条目 id>`（见 `shared/inbox.watermarkStoreOf`），数据根从
// `diy.getAppInfo` 取（与 `SidebarRoom` 判 lab/prod 同源）。
//
// 一个条目只弹一次：`seen` 按 id 去重（订阅首帧 / 重连不会重复弹同一条）。

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import { Caches } from "../lib/ui-state";
import { notificationStore } from "./notificationStore";
import {
    INBOX_MAX,
    latestIdOf,
    unreadCountOf,
    watermarkIdOf,
    watermarkStoreOf,
    type InboxEntry,
} from "../../shared/inbox";

/** 已处理过的条目 id（toast 去重）：够去重就行 —— toast 本身有寿命 */
const seen = new Set<string>();
const SEEN_MAX = 200;

let abort: AbortController | undefined;
/** 只订阅一次：start 在 App 的 onMount 里调，tab 切换不该重复订阅（##436 硬约束） */
let started = false;

const [entries, setEntries] = createSignal<InboxEntry[]>([]);
/** 本实例的数据根（`~/.diy` / `build/home`…）：水位按它分段，空 = 还没问出来 */
const [dataRoot, setDataRoot] = createSignal<string>("");
/** 存储里的原样水位（`<数据根>|<id>`）；对外暴露的是"属于当前数据根的那一段" */
const [storedWatermark, setStoredWatermark] = createSignal<string>(Caches.diy_inbox_last_read.get() ?? "");

/** 属于当前数据根的水位 id（数据根未定 ⇒ `""` = 全部未读，宁可多报也不谎报已读） */
function watermark(): string {
    return watermarkIdOf(storedWatermark(), dataRoot());
}

/** 把一条信箱条目变成 toast（导出以便单测直接钉文案/二级信息） */
export function toastOfEntry(e: InboxEntry): { type: "info" | "error"; message: string; meta: { source: string; reason: string; detail: string } } {
    return {
        // 撞上限：模型话没说完就断了（有实际损失）⇒ error 色；其余（成本告警 / 留言 / 滞留）⇒ info
        type: e.kind === "max-tokens" ? "error" : "info",
        message: e.text,
        meta: { source: e.source, reason: e.reason, detail: e.detail },
    };
}

function remember(id: string): boolean {
    if (seen.has(id)) return false;
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
    return true;
}

/** 追加到列表（按 id 去重 + 保持时间升序 + 截到 `INBOX_MAX`） */
function append(e: InboxEntry): void {
    setEntries((prev) => {
        if (prev.some((p) => p.id === e.id)) return prev;
        const next = [...prev, e];
        return next.length > INBOX_MAX ? next.slice(next.length - INBOX_MAX) : next;
    });
}

/** 回填历史（只进列表，不弹 toast —— 历史条目不该在每次重载时糊一脸） */
async function load(): Promise<void> {
    try {
        const rows = (await diyService.diy.notice.inbox.list({ taskUri: undefined, limit: INBOX_MAX })) as InboxEntry[];
        for (const e of rows) remember(e.id); // 先标记成"已处理"：后面的 watch 不会为它们弹 toast
        setEntries(rows);
    } catch (e) {
        // 读不到 ≠ 没有条目：列表留空、控制台留痕（不弹 toast —— 信箱坏了不该再打断人）
        console.warn("[inbox] 回填历史失败（面板按空处理）:", e);
    }
}

function start(): void {
    if (started) return;
    started = true;
    void diyService.diy
        .getAppInfo({})
        .then((info) => setDataRoot(info.diyHome ?? ""))
        .catch(() => {
            /* 拿不到数据根 ⇒ 水位判不出归属 ⇒ 全部算未读（多报一次，总比谎报已读过好） */
        })
        .then(() => load())
        .then(() => {
        if (abort) return;
        const ctrl = new AbortController();
        abort = ctrl;
        void diyService.diy.notice.inbox
            .watch({}, { signal: ctrl.signal })
            .then(async (stream) => {
                for await (const e of stream) {
                    if (!remember(e.id)) continue;
                    append(e);
                    const t = toastOfEntry(e);
                    // N2（人署名留言）= 值得抬头看一眼 → 停久一点；N1 照旧 8s 自己走
                    notificationStore.addToast(t.type, t.message, t.meta, { duration: e.level === "N2" ? 15000 : 8000 });
                }
            })
            .catch(() => {
                /* 断流即停（窗口关闭 / 实例退出）；重连由下一次 start 负责 */
            });
    });
}

function stop(): void {
    abort?.abort();
    abort = undefined;
    started = false;
    // `seen` / 列表**不清**：widget 卸载重挂（切 tab）不该让未读数或去重失效
}

export const inboxStore = {
    start,
    stop,
    toastOfEntry,
    /** 全部条目（时间升序；面板倒序渲染） */
    get entries(): InboxEntry[] {
        return entries();
    },
    /** 未读数 = 比水位新的条数（判据是纯函数，见 `shared/inbox.unreadCountOf`） */
    get unread(): number {
        return unreadCountOf(entries(), watermark());
    },
    /** 当前数据根下的水位 id（`""` = 全部未读） */
    get lastReadId(): string {
        return watermark();
    },
    /** 本实例数据根（空 = 还没问出来） */
    get dataRoot(): string {
        return dataRoot();
    },
    /** 标到最新（打开面板即"这一波我都看到了"—— 水位只有一个值，只能这么表达） */
    markAllRead(): void {
        const id = latestIdOf(entries());
        if (!id || id === watermark()) return;
        const stored = watermarkStoreOf(dataRoot(), id);
        setStoredWatermark(stored);
        Caches.diy_inbox_last_read.set(stored);
    },
    /** 清空（测试用；同时清水位，否则测试之间互相污染） */
    reset(): void {
        setEntries([]);
        setDataRoot("");
        setStoredWatermark("");
        Caches.diy_inbox_last_read.reset();
        seen.clear();
    },
};
