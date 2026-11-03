import { createSignal } from "solid-js";
import { assertNoticeMeta, type NoticeMeta } from "../lib/notice";

export type ToastType = "info" | "success" | "error";
/** toast 上的一个动作按钮（##358 D3 的 `[回到]`）—— 提示不该逼用户自己去翻 nav */
export interface ToastAction { label: string; onClick: () => void; }

/**
 * 一条 toast。**除了文案，还必须带二级信息**（##391 R1）：
 * 用户原话「所有用户可见的提示都需要有来源/原因/详情等，需提供详情按钮展开 2 级信息」。
 * `source` / `reason` / `detail` 从 `NoticeMeta` 继承，三者**必填**（`addToast` 空值即抛错）。
 */
export interface Toast extends NoticeMeta {
    id: string;
    type: ToastType;
    message: string;
    createdAt: number;
    /** 同源密集时聚合：同 source + 同 message 折叠成一条，`count` = 累计次数（≥1，##391 R2） */
    count: number;
    /** ##391 **遗留清单**内的调用点（走 `addToastLegacy`）：详情面板如实说"未登记"，不许装作有来源 */
    legacy?: boolean;
    /** 有动作按钮（如 `[回到]`）：想让它"点完再走"就传 `duration = 0`，见 `addToast` */
    action?: ToastAction;
}

/** `addToast` 的可选项 */
export interface ToastOptions {
    /** 毫秒；**`0` = 不自动消失**（抢过焦点的会话提示用它 —— 得让人看见或点掉） */
    duration?: number;
    /** 动作按钮（想让它"点完再走"就配 `duration: 0`） */
    action?: ToastAction;
    /**
     * 是否与同 source + 同 message 的在屏提示聚合（缺省 `true`）。
     * 密集重连 / 连续重试会把 toast 刷屏，聚合后只留一条并显示 `×N`。
     */
    aggregate?: boolean;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;
/** 每条 toast 的自动消失定时器（聚合时重置，删除时清理 —— 否则残留 timer 会去删一个新 id） */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** 聚合键：同机制 + 同文案 = 同一件事的重复发生 */
const aggregateKey = (source: string, message: string) => `${source}\u0000${message}`;

function scheduleRemoval(id: string, duration: number): void {
    const old = timers.get(id);
    if (old !== undefined) clearTimeout(old);
    if (duration > 0) timers.set(id, setTimeout(() => notificationStore.removeToast(id), duration));
    else timers.delete(id);
}

function push(t: Toast, duration: number, aggregate: boolean): string {
    let id = t.id;
    setToasts((prev) => {
        if (aggregate) {
            const key = aggregateKey(t.source, t.message);
            const i = prev.findIndex((p) => aggregateKey(p.source, p.message) === key);
            if (i >= 0) {
                // 聚合：沿用旧 id（保号）、次数 +1、原因/机制取**最新一次**（数字才是我们要的）
                id = prev[i]!.id;
                const merged: Toast = { ...t, id, count: prev[i]!.count + 1 };
                const next = prev.slice();
                next[i] = merged;
                return next;
            }
        }
        id = t.id;
        return [...prev, t];
    });
    scheduleRemoval(id, duration); // 聚合时也重置计时：重新开始那 4 秒
    return id;
}

export const notificationStore = {
    get toasts() { return toasts(); },
    /**
     * 弹一条**带二级信息**的提示（##391 起这是唯一正路）。
     *
     * @param meta 谁发的 / 为什么现在发 / 机制 —— 三者缺一即**抛错**（不是警告：
     *             没来源的提示等于让用户猜，正是本任务要根治的东西）
     * @param opts `duration`（毫秒，`0` = 常驻）/ `action` / `aggregate`（缺省聚合）
     */
    addToast: (type: ToastType, message: string, meta: NoticeMeta, opts: ToastOptions = {}): string => {
        const clean = assertNoticeMeta(meta);
        const text = String(message ?? "").trim();
        if (!text) throw new Error("[notice] 提示缺 message（文案）：`addToast` 至少要让人看见一句话（##391）");
        const t: Toast = {
            id: `toast-${nextId++}`,
            type,
            message: text,
            createdAt: Date.now(),
            count: 1,
            ...clean,
            action: opts.action,
        };
        return push(t, opts.duration ?? 4000, opts.aggregate !== false);
    },
    /**
     * ##391 **遗留清单**内的提示（129 处历史调用点，本任务 v1 不逐个改造）。
     *
     * 为什么要留这个口子而不是"都改成空 source 的 addToast"：那样护栏就形同虚设
     * （空值放行 = 债务隐身）。这里把「没登记」做成**显式、可数、只许减少**的：
     *   · 函数名自带债务语义，`rg addToastLegacy` 就是清单；
     *   · 数量由 `tests/core/notice-contract.test.ts` 按「文件 → 条数」钉住，改少了才许改基线；
     *   · 详情面板对这类提示**如实写"未登记"**（不编来源），用户至少知道这是已知债务。
     * 新代码**一律用 `addToast`**，不许再往这里加。
     */
    addToastLegacy: (type: ToastType, message: string, duration = 4000, action?: ToastAction): string => {
        const text = String(message ?? "").trim() || "(空提示)";
        const t: Toast = {
            id: `toast-${nextId++}`,
            type,
            message: text,
            createdAt: Date.now(),
            count: 1,
            legacy: true,
            source: "未登记（##391 遗留清单）",
            reason: "该调用点还没补来源/原因 —— 这是已知债务，不是「没有原因」",
            detail:
                "这条提示写在 ##391（提示体系规范化）之前，只有一句结论、没有来源与机制。\n" +
                "它在任务 ##391 正文的「未改造清单」里按文件登记、数量可数，只许减少不许增加。\n" +
                "看到它对你有用：点「复制」把原话贴回对话，agent 就能定位到具体是哪个提示该补机制。",
            action,
        };
        return push(t, duration, false);
    },
    removeToast: (id: string) => {
        const t = timers.get(id);
        if (t !== undefined) {
            clearTimeout(t);
            timers.delete(id);
        }
        setToasts((p) => p.filter((x) => x.id !== id));
    },
};
