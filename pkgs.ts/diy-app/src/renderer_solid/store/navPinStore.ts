/**
 * navPinStore — nav 任务项的**置顶集合**（##356 ②）。
 *
 * 真源 = 视图 cache `diy_nav_pinned`（localStorage，注册见 lib/ui-state）；本 store 是
 * 它的 signal 镜像（渲染要响应式）。规则本体是纯函数（shared/nav-pin），这里只管读写。
 *
 * 两条边界（与 tabStore 的契约一致：只存真信息、派生数据现算）：
 *  - 集合里存的是 **tab key**（`<pageId>:<ctx>`，与 `diy_tabs_opened` 同源），不是任务 uri ——
 *    置顶的单位是「导航里的那一项」（同一任务可开多个 tab，各自的置顶互不影响）。
 *  - 展示顺序**不由集合决定**（集合无序）：置顶段内顺序取全局 tab 顺序（见 partitionByPin），
 *    而置顶段本身跨项目固定在最上（见 shared/nav-project 的 navSections，##466）。
 */
import { createSignal, untrack } from "solid-js";
import { Caches } from "../lib/ui-state";
import { prunePins, togglePin } from "../../shared/nav-pin";

/** 读盘：只取字符串元素（元素级清洗收敛在这里 —— ui-state 的 parse 只校验"是数组吗"） */
function load(): string[] {
    const raw = Caches.diy_nav_pinned.get();
    return raw.filter((x): x is string => typeof x === "string");
}

const [keys, setKeys] = createSignal<string[]>(load());

function persist(next: string[]): void {
    setKeys(next);
    Caches.diy_nav_pinned.set(next);
}

export const navPinStore = {
    /** 当前置顶的 tab key 列表（顺序无意义，勿用于渲染排序） */
    get keys(): string[] {
        return keys();
    },
    has(key: string): boolean {
        return keys().includes(key);
    },
    /** 置顶 / 取消置顶（用户动作 —— 集合唯一的改写来源） */
    toggle(key: string): void {
        persist(togglePin(keys(), key));
    },
    /**
     * 剪掉已不存在的键（tab 关了 / 任务被删）。由 App 在 tab 列表变化时调用。
     *
     * untrack：剪枝结果由 alive 单方面决定，不该让「写 keys」再把自己重触发一遍
     * （效果是自激一轮、无事发生，但白跑一遍全量 diff）。
     */
    prune(alive: readonly string[]): void {
        const cur = untrack(keys);
        const next = prunePins(cur, alive);
        if (next.length !== cur.length) persist(next);
    },
};
