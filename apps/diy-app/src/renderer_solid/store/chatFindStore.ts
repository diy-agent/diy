/**
 * chatFindStore — **会话数据层检索**的面板状态（##389）。
 *
 * 与 findStore（##234 页内查找）的分工（这是本任务最容易被混淆的一处）：
 *   · findStore   = 「**这一页**上哪儿写着这几个字」—— 走 DOM 文本节点，受虚拟窗口约束；
 *   · chatFindStore = 「**这个会话**（含没渲染的轮、含已被压缩的历史）哪儿写着」——
 *     走 main 侧的 ops 原文扫描（`agent.local.find`），与 DOM 完全解耦。
 * 两者**并存**：⌘F 仍是页内（##234 语义不动），⌘⇧F 才是本面板；桥接（页内 0/0 时提示
 * 「本会话另有 N 处」）由 FindBar 读本 store 的探针结果渲染。
 *
 * 为什么把 RPC 与状态收在 store 而不是组件里：面板会被反复开关、开关不该丢查询与结果；
 * 桥接也要在面板**没开**时拿到命中数（探针），两个消费方共享同一份「最近一次扫描」。
 *
 * 输入防抖 ≤150ms（口径 3）：每敲一个字扫一次 74MB 的会话是不可接受的，而 150ms 落在
 * 一次按键连发的间隙里 —— 手感仍是"边打边出结果"。
 */
import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";

/** 与 main 侧 `FindHit` 同形（RPC 输出 schema 是它的真源，见 api-def 的 agent.local.find） */
export interface ChatFindHit {
    turnId: string;
    at: number;
    blockId: string;
    kind: string;
    scope: string;
    pre: string;
    hit: string;
    post: string;
    label: string;
    compacted: boolean;
}

export interface ChatFindScopes {
    text: boolean;
    tool: boolean;
    think: boolean;
}

/** 输入防抖（口径 3 的上限是 150ms，这里留一点余量给主进程响应的抖动） */
const DEBOUNCE_MS = 120;
/** 组数上限（口径 3）：撞到它就显示「还有更多」，点一下翻倍重扫 */
const DEFAULT_TURNS = 200;

const [open, setOpen] = createSignal(false);
const [query, setQuery] = createSignal("");
const [scopes, setScopes] = createSignal<ChatFindScopes>({ text: true, tool: true, think: false });
const [hits, setHits] = createSignal<ChatFindHit[]>([]);
const [turns, setTurns] = createSignal(0);
const [more, setMore] = createSignal(false);
const [limit, setLimit] = createSignal(DEFAULT_TURNS);
const [busy, setBusy] = createSignal(false);
const [error, setError] = createSignal("");
/** 扫描耗时（ms）与扫描规模 —— 大会话里"为什么慢"必须能自证，不能让用户猜 */
const [spent, setSpent] = createSignal(0);

/**
 * 桥接探针：页内查找 0/0 时对数据层探一次，回答「本会话另有几处（几处在未渲染的轮上）」。
 * `null` = 还没探 / 当前查询没探出结论（**没结论就不显示那一行**，口径 1 的"不许静默敷衍"）。
 */
const [probe, setProbe] = createSignal<{ query: string; hits: number; turns: number; unrendered: number } | null>(
    null,
);

/** 面板的定位回调（由会话页注册：只有它拿得到滚动容器与块树） */
let locator: ((hit: ChatFindHit) => void) | null = null;

/** 每次新扫描递增：晚到的旧结果直接丢弃（防"打快了，先回来的旧查询覆盖新结果"） */
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let abortCtl: AbortController | null = null;

export interface FindSnapshot {
    hits: ChatFindHit[];
    turns: number;
    more: boolean;
}

/** 扫一次（面板与探针共用）：取消在途、按 seq 丢弃晚到结果 */
async function scan(taskUri: string, q: string, s: ChatFindScopes, maxTurns: number): Promise<FindSnapshot | null> {
    const mine = ++seq;
    abortCtl?.abort();
    const ctl = new AbortController();
    abortCtl = ctl;
    const t0 = Date.now();
    try {
        const r = await diyService.diy.agent.local.find(
            { taskUri, query: q, text: s.text, tool: s.tool, think: s.think, maxTurns },
            { signal: ctl.signal },
        );
        if (mine !== seq) return null;
        setSpent(Date.now() - t0);
        return { hits: r.hits as ChatFindHit[], turns: r.turns, more: r.more };
    } catch (e) {
        if (mine !== seq) return null;
        // 取消不是错（打字时每次换 query 都会取消上一次）
        const name = (e as { name?: string })?.name ?? "";
        if (name === "AbortError" || /abort|cancel/i.test(String((e as Error)?.message ?? ""))) return null;
        setError(String((e as Error)?.message ?? e).slice(0, 200));
        return null;
    }
}

/** 面板内的检索（防抖） */
function schedule(taskUri: string | null, q: string, s: ChatFindScopes, maxTurns: number): void {
    if (timer) clearTimeout(timer);
    if (!taskUri || !q.trim()) {
        setHits([]);
        setTurns(0);
        setMore(false);
        setBusy(false);
        setError("");
        return;
    }
    setBusy(true);
    timer = setTimeout(() => {
        timer = null;
        void (async () => {
            const r = await scan(taskUri, q, s, maxTurns);
            if (!r) {
                setBusy(false);
                return;
            }
            setHits(r.hits);
            setTurns(r.turns);
            setMore(r.more);
            setBusy(false);
            setError("");
        })();
    }, DEBOUNCE_MS);
}

/**
 * 桥接探针（面板没开时才探）：命中数 + 落在**未渲染轮**上的命中数。
 *
 * `rendered` 由会话页给出（它才知道虚拟窗口挂了哪几轮）—— 探针只做集合差，
 * 不从 DOM 反推（DOM 查询在这里既慢又会把"正在卸载"的行算进去）。
 * 与面板共用 `scan`：去抖/取消/seq 只有一份实现，两个入口不会各自飘。
 */
function runProbe(
    taskUri: string | null,
    q: string,
    rendered: ReadonlySet<string>,
    s: ChatFindScopes,
): void {
    if (!taskUri || !q.trim()) {
        lastProbeKey = "";
        setProbe(null);
        return;
    }
    // 同一份活别排第二次：effect 可能因**别的**信号抖动而重跑（面板开关、计数归零…），
    // 而查询/范围没变就没必要再读一遍文件。"进行中"时同样跳过 —— 在途结果回来会自己填上。
    const key = `${taskUri}\u0000${q}\u0000${s.text ? 1 : 0}${s.tool ? 1 : 0}${s.think ? 1 : 0}`;
    if (key === lastProbeKey) return;
    lastProbeKey = key;
    void (async () => {
        const r = await scan(taskUri, q, s, DEFAULT_TURNS);
        if (!r || key !== lastProbeKey) return; // 期间换了查询/会话：旧结论作废（别用旧答案回答新问题）
        const unrendered = r.hits.filter((h) => !rendered.has(h.turnId)).length;
        setProbe({ query: q, hits: r.hits.length, turns: r.turns, unrendered });
    })();
}

/** 最近一次探针的 key（去重用；空串 = 没探过 / 已作废） */
let lastProbeKey = "";

export const chatFindStore = {
    get open(): boolean {
        return open();
    },
    get query(): string {
        return query();
    },
    get scopes(): ChatFindScopes {
        return scopes();
    },
    get hits(): ChatFindHit[] {
        return hits();
    },
    get turns(): number {
        return turns();
    },
    get more(): boolean {
        return more();
    },
    get busy(): boolean {
        return busy();
    },
    get error(): string {
        return error();
    },
    get spentMs(): number {
        return spent();
    },
    /** 桥接探针的结论（null = 无结论 ⇒ FindBar 不出那一行） */
    get probe() {
        return probe();
    },
    /** 当前会话 URI（null = 不在会话页 ⇒ ⌘⇧F 会如实拒绝，见 App 的快捷键分支） */
    get taskUri(): string | null {
        return currentTaskUri;
    },
    /** 桥接探针：命中数 + 落在未渲染轮上的命中数（见 runProbe 注释） */
    probeDeep(taskUri: string | null, q: string, rendered: ReadonlySet<string>, s: ChatFindScopes): void {
        runProbe(taskUri, q, rendered, s);
    },
    /**
     * 清掉探针结论（页内已找到 / 查询清空 / 面板关闭时会话页调它）。
     * ⚠️ **只写不读**：调用方在 effect 里，若这里读 `probe()` 就会把"我刚写入的东西"变成
     * 依赖 ⇒ 探测结果一回来就重跑 effect ⇒ 又发起一次扫描（自己喂自己，永远停不下来）。
     * 写 null 在值已为 null 时是 no-op（Solid 的 === 判等），故不必先判断。
     */
    clearProbe(): void {
        setProbe(null);
    },
    /**
     * 会话页**认领**面板（任务 URI + 定位回调，一处写完）。
     *
     * 为什么两样要一起认领：多开 tab 时本组件可能同时存活多份，而面板状态是单例；
     * 分开写会出现「A 页的 locator + B 页的 uri」这种错配（点了结果跳到别的会话去）。
     */
    claim(u: string | null, fn: (hit: ChatFindHit) => void): void {
        locator = fn;
        setTaskUri(u);
    },
    /**
     * 会话页卸载时**交还**（按 uri 判，见 releaseTask）。
     * 只管自己那一份：别的页还活着时，它的 uri / locator 不该被这一页的销毁带走。
     */
    release(u: string | null): void {
        if (u === null || u !== currentTaskUri) return;
        locator = null;
        setTaskUri(null);
    },
    locate(hit: ChatFindHit): void {
        locator?.(hit);
    },
    toggle(): void {
        setOpen((v) => !v);
    },
    openWith(q?: string): void {
        if (q !== undefined) {
            setQuery(q);
            setLimit(DEFAULT_TURNS);
            const u = currentTaskUri;
            schedule(u, q, scopes(), DEFAULT_TURNS);
        }
        setOpen(true);
    },
    close(): void {
        setOpen(false);
        runProbe(null, "", new Set(), scopes()); // 面板一关，探针结论立刻作废（不在页面上留旧数字）
    },
    setQuery(taskUri: string | null, q: string): void {
        setQuery(q);
        // 换了查询就立刻丢掉上一批结果（宁可闪一下）：留着旧列表等于**用旧答案回答新问题**
        // —— 用户看到"有结果"，但那几条是上一个词的（这也正是打错字时最难自查的一类错觉）。
        setHits([]);
        setTurns(0);
        setMore(false);
        setLimit(DEFAULT_TURNS);
        schedule(taskUri, q, scopes(), DEFAULT_TURNS);
    },
    setScope(taskUri: string | null, key: keyof ChatFindScopes, v: boolean): void {
        const s = { ...scopes(), [key]: v };
        setScopes(s);
        schedule(taskUri, query(), s, limit());
    },
    /** 「还有更多」：组数上限翻倍重扫（口径 3 的出口，不做无限滚动） */
    loadMore(taskUri: string | null): void {
        const next = limit() * 2;
        setLimit(next);
        schedule(taskUri, query(), scopes(), next);
    },

};

/** 当前会话 URI（面板/探针都要它；由会话页写入，避免把 taskStore 依赖塞进本 store） */
let currentTaskUri: string | null = null;

/**
 * 写当前会话 URI（**按 uri 判**，不是无条件覆盖）。
 *
 * `claim` 与 `release` 都经它，而切 tab 时"新页挂载"与"旧页卸载"的先后**不保证**
 * （Solid 的销毁顺序不承诺）：无条件写 null 会把刚挂上的那一页的 URI 抹掉 —— 症状是
 * 「⌘⇧F 打开面板，输入框有字、结果永远 0」（它连 taskUri 都没有，压根没查）。
 * 故 release 侧先比 uri 再交还，这里再判一次"值没变就不动"。
 */
function setTaskUri(u: string | null): void {
    if (u === currentTaskUri) return;
    currentTaskUri = u;
    // 面板开着且已有查询：换了会话就按新会话重扫（否则结果还停在上一页的会话里）
    if (open() && query()) schedule(u, query(), scopes(), limit());
}
