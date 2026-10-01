/**
 * localChatStore — 本地自定义 agent 会话状态（ai-sdk 块协议，独立于 ACP chatStore）
 *
 * Op 流（RPC serverStream / history 日志）→ BlockStore.fold → 块树信号。
 * wire = 存储 = 渲染输入：history 重放与实时流走同一条 fold 路径。
 *
 * 状态按 taskUri 隔离（Map）：切任务不 reset 在途会话、不串 running/cancel。
 * main 侧 LocalAgentManager 本来就是按 task 分会话，这里对齐它。
 *
 * ⚠️ 运行态有**两个**来源，不许混（任务 194，判据见 shared/session-view.ts）：
 *   · remoteActive —— main 真值（agent.local.running）：这个任务此刻是否真有轮次在跑，
 *     **包含别人发起的**（CLI / 另一窗口）。只看本地 `running` 会把别人正在跑的轮次
 *     误报成「本轮未完成（流中断/崩溃恢复）」，也没有停止入口。
 *   · running —— 只是"我这轮在等自己的流"，是前者的子集；停止时按本地确定终态立刻复位。
 *
 * 模型与人物**不在这里**：模型属于人物（配置实体），本 store 只负责"某个任务的会话流"，
 * 谁干活由任务 frontmatter 的 persona 决定（见 store/personaStore.ts 与 shared/persona.ts）。
 */

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "./notificationStore";
import { BlockStore, toTree, type BlockNode, type Op } from "../../main/services/local-blocks";
import { personaStore } from "./personaStore";
import { sessionView, type SessionView } from "../../shared/session-view";

interface TaskState {
    store: BlockStore;
    loaded: boolean;
    trees: () => BlockNode[];
    setTrees: (v: BlockNode[]) => void;
    running: () => boolean;
    setRunning: (v: boolean) => void;
    /** main 真值：本 task 此刻有活跃轮次（含别人发起的），由 agent.local.running 轮询刷新 */
    active: () => boolean;
    setActive: (v: boolean) => void;
    /** 已请求停止的时刻（epoch ms）；null = 没点过。main 报不活跃后自动清掉 */
    stopRequestedAt: () => number | null;
    setStopRequestedAt: (v: number | null) => void;
    /** 本地在途流的取消句柄：点停止时立刻结束等待，不干等服务端 end 帧 */
    abort: AbortController | null;
    error: () => string | null;
    setError: (v: string | null) => void;
    /** 阅读位置：会话块树滚动区 scrollTop（内存态，随会话保留；不落盘——重启后从最新看起） */
    scroll: number;
    /** 详情面板当前 tab（local=agent 对话 / info=任务详情），per-task 记忆 */
    tab: "local" | "info";
    /** 详情 tab 的滚动位置（info 滚动容器 scrollTop） */
    detailScroll: number;
    /** 历史加载在途 promise：open() 并发去重（见 open 内注释） */
    loading?: Promise<void>;
}

const states = new Map<string, TaskState>();
const [currentUri, setCurrentUri] = createSignal<string | null>(null);

function stateFor(taskUri: string): TaskState {
    let s = states.get(taskUri);
    if (!s) {
        const [trees, setTrees] = createSignal<BlockNode[]>([]);
        const [running, setRunning] = createSignal(false);
        const [active, setActive] = createSignal(false);
        const [stopRequestedAt, setStopRequestedAt] = createSignal<number | null>(null);
        const [error, setError] = createSignal<string | null>(null);
        s = {
            store: new BlockStore(), loaded: false, trees, setTrees, running, setRunning,
            active, setActive, stopRequestedAt, setStopRequestedAt, abort: null,
            error, setError, scroll: 0, tab: "local", detailScroll: 0,
        };
        states.set(taskUri, s);
    }
    return s;
}

/** 当前选中任务的状态（渲染层只读这个；切换任务自动切信号源） */
function cur(): TaskState | null {
    const u = currentUri();
    return u ? (states.get(u) ?? null) : null;
}

/** 块树快照刷新（重建整棵树） */
function refresh(st: TaskState) {
    st.setTrees(st.store.roots().map((r) => toTree(st.store, r.id)));
}

// ─── 渲染批处理（合并高频 op，落到每帧至多一次 refresh） ──────────
//
// 为什么必须做：上游 text-delta 是逐 token 一个 op（local-agent.ts），
// 若每个 op 都 refresh，则 ①整棵树重建 O(块数) ②Markdown 全量 re-parse O(长度²)，
// 两者叠加在长回答下会明显卡顿。
// 为什么用 rAF 而非定时器：一次刷新即一次绘制，rAF 天然对齐帧率（≤60fps），
// 30~60ms 的定时器在 60fps 下会白丢 2~4 帧，且与绘制节奏脱钩。
// 定稿信号不受影响：stop op 改变的是块字段（stopped），与 refresh 时机无关，
// 且 streaming 结束时的最后一次 refresh 一定执行（帧回调里取最新快照）。

/** 待刷新的 task（同一 task 多 op 只记一次；跨 task 各自独立，不互相吞并） */
const pendingRefresh = new Set<TaskState>();
let rafId: number | null = null;

function scheduleRefresh(st: TaskState) {
    pendingRefresh.add(st);
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
        rafId = null;
        const batch = [...pendingRefresh];
        pendingRefresh.clear();
        for (const s of batch) refresh(s);
    });
}

/** 立即刷新并取消在途批（用于流结束/切会话等需要同步可见的时机） */
function flushRefresh(st: TaskState) {
    pendingRefresh.delete(st);
    refresh(st);
}

// ─── 运行态真值（main 内存权威） ─────────────────
//
// 为什么必须问 main：renderer 拿不到"别人正在跑"这件事 —— 别人的 op 不经过我们这条流，
// 本地 running 永远是 false，于是正在跑的轮次就被当成中断的历史（任务 194 现象一）。
// 代价是轮询：main 侧目前没有"轮次开始/结束"的元事件通路（那是 180 的设计题），
// 在没有它之前，UI 至少不该把别人正在跑的轮次说成"流中断"。间隔克制（2s），
// 且只在会话页挂载期间运行（watch 的 stop 由组件 cleanup 调用）。

/** main 运行态轮询间隔（会话页挂载期间） */
const ACTIVE_POLL_MS = 2000;

/** 判据用的"现在"：轮询每拍推进一次，让停止宽限期（shared/session-view.ts）能自己过期 */
const [nowMs, setNowMs] = createSignal(Date.now());

/**
 * 重放 ops 重建块树。
 *
 * 为什么需要：**别人发起的轮次**其 op 不经过我这条流（我看不到别人写的日志 —— 那是 180
 * 的事件总线范围）。若不主动拉，一轮正常结束后界面里那份树永远停在"turn 未收 stop"，
 * 于是又变成"本轮未完成（流中断/崩溃恢复）"的误报 —— 只是这次错在信息落后，不是流中断。
 * 只在 main 报"活跃 → 不活跃"的下降沿调用（轮次已收尾，日志是终态、不会读到半截）。
 *
 * 在途去重：cancel / send 轮末 / 轮询三处都可能撞上同一次下降沿，重复重建纯属浪费。
 */
const reloadInFlight = new Map<string, Promise<void>>();

function reload(taskUri: string): Promise<void> {
    const inFlight = reloadInFlight.get(taskUri);
    if (inFlight) return inFlight;
    const p = doReload(taskUri).finally(() => reloadInFlight.delete(taskUri));
    reloadInFlight.set(taskUri, p);
    return p;
}

async function doReload(taskUri: string): Promise<void> {
    const st = states.get(taskUri);
    if (!st) return;
    // ⚠️ 我自己这轮在途时**不能**重建：
    //   · main 报"不活跃"只说明**服务端**收尾了，我这条流可能还在消费尾巴，
    //     重建会把 store 整个换掉，而那些 op 之后仍 `apply` 到新 store 上 —— 丢帧/错序；
    //   · 重建读的是盘上日志，此刻可能还没写完最后一批。
    // 跳过是安全的：下一轮结束（或下次下降沿）还会再触发一次。
    if (st.running()) return;
    // 与 open() 的首载互斥（任务 201 G3）：loadHistory 正往**旧** store 逐条 fold ops，
    // 此时重建会把 store 整个换掉 → 它后续的 apply 落到新 store 上（历史重复/串台）。
    // 等首载结束再重建；loadHistory 自己吞错不 reject，这里 catch 只是防御。
    if (st.loading) {
        try {
            await st.loading;
        } catch {
            /* 首载失败已由 loadHistory 出声，不挡重建 */
        }
        if (st.running()) return; // 等首载期间又开始发送 → 同样不重建
    }
    try {
        const ops = (await diyService.diy.agent.local.history({ taskUri })) as Op[];
        // 重建而不是增量 fold：loadHistory 是"把全部 op 再喂一遍"，增量会导致内容重复
        st.store = new BlockStore();
        for (const op of ops) st.store.apply(op);
        st.loaded = true;
        flushRefresh(st);
    } catch (e) {
        console.warn(`[localChat] 收尾重放失败 ${taskUri}:`, e);
    }
}

/** 查一次 main 真值，写入该 task 的 active 标记（未建状态的 task 直接跳过：没人看就不必刷） */
async function refreshActive(taskUri: string): Promise<void> {
    const st = states.get(taskUri);
    if (!st) return;
    const was = st.active();
    try {
        const r = await diyService.diy.agent.local.running({});
        const active = (r?.active ?? []).some((t) => t.taskUri === taskUri);
        st.setActive(active);
        // main 说这轮已收尾 → 停止请求使命结束（否则宽限期后会把"停止中"又说成"正在生成"）
        if (!active) st.setStopRequestedAt(null);
        // 下降沿：main 刚收尾一轮 —— 它的 op 我这条流收不到，主动重放让树追上终态
        if (was && !active) await reload(taskUri);
    } catch (e) {
        // 查询失败不改既有判断：宁可留着上一次的真值，也不能当作"没人跑"（那正是误报中断的成因）
        console.warn(`[localChat] 运行态查询失败 ${taskUri}:`, e);
    }
    setNowMs(Date.now());
}

/** 会话页挂载期间持续对真值；返回停止函数（组件 cleanup 调用） */
function watch(taskUri: string): () => void {
    void refreshActive(taskUri);
    const timer = setInterval(() => void refreshActive(taskUri), ACTIVE_POLL_MS);
    return () => clearInterval(timer);
}

/** 运行态视图（判据全在 shared/session-view.ts，这里只把三个信号喂进去） */
function viewOf(st: TaskState | null): SessionView {
    if (!st) return sessionView({ sending: false, remoteActive: false, stopRequestedAt: null, now: nowMs() });
    return sessionView({
        sending: st.running(),
        remoteActive: st.active(),
        stopRequestedAt: st.stopRequestedAt(),
        now: nowMs(),
    });
}

/** 切换/进入会话：首次加载持久化 Op 日志；已加载过的直接复用（含在途流式） */
/** 拉历史并 fold 进块树（open 的实际加载体，被在途去重包裹） */
async function loadHistory(st: TaskState, taskUri: string): Promise<void> {
    try {
        const ops = (await diyService.diy.agent.local.history({ taskUri })) as Op[];
        for (const op of ops) st.store.apply(op);
        refresh(st);
        st.loaded = true;
    } catch (e) {
        // 历史拉失败≠无历史：降级可见（toast）+ 不标 loaded（下次进入自动重试），绝不静默展示空会话
        console.warn(`[localChat] 历史加载失败 ${taskUri}:`, e);
        notificationStore.addToast("error", "本地会话历史加载失败，将显示不完整并在下次进入时重试");
    }
}

async function open(taskUri: string) {
    setCurrentUri(taskUri);
    const st = stateFor(taskUri);
    void refreshActive(taskUri); // 进入会话立刻对一次真值，不等轮询第一拍
    if (st.loaded) return;
    // 并发去重（必需）：LocalChatPage 首挂时 onMount 与 uri 切换 effect 都会调 open，
    // 而 loaded 只在 await 之后置位 —— 没有这道闸门，两次 history 会被先后 fold 进同一个
    // store，表现为「每条消息内容整体重复一遍」。
    // 失败时清掉在途标记（不置 loaded），保留「下次进入自动重试」的既有语义。
    if (st.loading) return st.loading;
    st.setError(null);
    st.loading = loadHistory(st, taskUri).finally(() => {
        st.loading = undefined;
    });
    await st.loading;

    // 人物/模型清单由 personaStore 管（详情面板与试验场也要用），这里只确保它加载过
    void personaStore.load();
}

/**
 * 发送一轮：实时 fold Op 流（RPC JSON 行），状态只写本 task。
 *
 * 流带 AbortSignal：点「停止」时本地立刻结束等待（不干等服务端 end 帧 —— main 还可能要
 * 收尾写 llm 日志、追加上游慢响应），按钮因此马上回到发送态（任务 194 现象二）。
 */
async function send(taskUri: string, text: string): Promise<boolean> {
    const st = stateFor(taskUri);
    const msg = text.trim();
    if (!msg || !taskUri || st.running()) return false;
    st.setError(null);
    st.setRunning(true);
    st.setStopRequestedAt(null);
    const ctrl = new AbortController();
    st.abort = ctrl;
    try {
        // 不传 model/reasoningEffort：模型与参数由 main 按**任务绑定的人物**解析（配置真源唯一，
        // 见 main/services/local-agent.ts 的 chat）。renderer 只决定"要谁干活"（persona 字段）。
        const stream = await diyService.diy.agent.local.chat(
            {
                taskUri,
                message: msg,
                // 键必须出现（契约里 optional 字段也是必填键）：显式 undefined = 不覆盖人物配置
                model: undefined,
                reasoningEffort: undefined,
            },
            { signal: ctrl.signal },
        );
        for await (const raw of stream) {
            let op: Op;
            try {
                op = (typeof raw === "string" ? JSON.parse(raw) : raw) as Op;
            } catch (e) {
                // 坏行属数据层容错：跳过但必须留痕（main 侧日志重放同理，fold issues 另有计数）
                console.warn("[localChat] 丢弃无法解析的 op 行:", e, String(raw).slice(0, 120));
                continue;
            }
            st.store.apply(op);
            scheduleRefresh(st);
        }
        return true;
    } catch (e) {
        // 自己点的停止不算错误：signal 中断会让流正常收尾（不抛），这里只是防御
        if (ctrl.signal.aborted) return true;
        st.setError(e instanceof Error ? e.message : String(e));
        return false;
    } finally {
        // 无论正常结束/报错/中断：丢弃在途批并同步落最终快照。
        // 放在 finally 而非 try 尾部，是为保证取消与异常路径也不会丢掉最后一批 op
        // （否则 stopped/error 等终态字段要等下一次 rAF 才可见）。
        st.abort = null;
        flushRefresh(st);
        st.setRunning(false);
        // 轮末对一次真值：main 可能拒发（别人在跑）、也可能别人刚接手，界面按真值定格
        void refreshActive(taskUri);
    }
}

/**
 * 中断本 task 的生成（main 侧 AbortController → ai-sdk 停流）。
 *
 * 停止是**本地确定终态**，两条动作并行：
 *   ① 结束自己的等待（我在途的那轮）—— 按钮立刻回到发送态，不等服务端 end 帧；
 *   ② 发 cancel RPC —— 对**别人**发起的轮次（CLI / 另一窗口）这是唯一通路。
 * main 语义幂等：无在途返 false 不抛错。
 */
async function cancel(taskUri: string) {
    const st = stateFor(taskUri);
    st.setStopRequestedAt(Date.now());
    setNowMs(Date.now());
    st.abort?.abort();
    try {
        await diyService.diy.agent.local.cancel({ taskUri });
    } catch (e) {
        // 能报错就只剩传输层故障：「停止」没生效必须让用户知道
        console.error(`[localChat] cancel RPC 失败 ${taskUri}:`, e);
        notificationStore.addToast("error", "停止请求发送失败，生成可能仍在继续");
    }
    // 立刻对一次：main 已收尾 → 直接回发送态；还在收尾 → 走"停止中"宽限期
    await refreshActive(taskUri);
}

/** 清空本 task 会话（日志 + 内存，main 侧会先中断在途生成）；成功才重置本地，失败保持原样防状态分叉 */
async function clear(taskUri: string) {
    try {
        const r = await diyService.diy.agent.local.clear({ taskUri });
        if (!r.cleared) {
            // 不抛错但业务失败（main 删日志遇真故障）：领域返回值也要检查，同样不许静默
            console.error(`[localChat] clear 返回失败 ${taskUri}`);
            notificationStore.addToast("error", "服务端未能清空会话日志，界面未重置");
            return;
        }
    } catch (e) {
        console.error(`[localChat] clear RPC 失败 ${taskUri}:`, e);
        notificationStore.addToast("error", "清空会话失败，界面未重置");
        return;
    }
    const st = stateFor(taskUri);
    st.store = new BlockStore();
    st.loaded = true; // 文件已删，不必重拉
    st.setError(null);
    st.scroll = 0; // 会话清空，阅读位置一并归位
    refresh(st);
}

/** 记录某任务的阅读位置（切走会话时由组件保存滚动容器 scrollTop） */
function setScroll(taskUri: string, v: number): void {
    stateFor(taskUri).scroll = v;
}

/** 读取某任务的阅读位置（0=从未滚动过；只读不创建 state） */
function getScroll(taskUri: string): number {
    return states.get(taskUri)?.scroll ?? 0;
}

/** 记录某任务的详情面板 tab（切走时由面板保存） */
function setTab(taskUri: string, v: "local" | "info"): void {
    stateFor(taskUri).tab = v;
}

/** 读取某任务的详情面板 tab（未访问过 = local） */
function getTab(taskUri: string): "local" | "info" {
    return states.get(taskUri)?.tab ?? "local";
}

/** 记录某任务的详情 tab 滚动位置 */
function setDetailScroll(taskUri: string, v: number): void {
    stateFor(taskUri).detailScroll = v;
}

/** 读取某任务的详情 tab 滚动位置 */
function getDetailScroll(taskUri: string): number {
    return states.get(taskUri)?.detailScroll ?? 0;
}


// 输入框草稿已移出本 store：草稿是非缓存数据（丢了=用户白打），权威在任务目录
// .diy/drafts.yaml，由 store/draftStore.ts 负责（经 RPC 落盘、随任务删除、跨模式可见）。
// 本 store 只管会话（op 流，可重放重建）。
export const localChatStore = {
    get trees() {
        return cur()?.trees() ?? [];
    },
    /**
     * 运行态视图 —— UI 只该看它（真值优先）。
     * ⚠️ 别再用单看 `running` 的判据解释"这一轮是否活着"：那是本地私有推测。
     */
    get view(): SessionView {
        return viewOf(cur());
    },
    /** 直播中（main 报活跃，或我这轮在途）—— 中断警告/等待态的 gating */
    get live(): boolean {
        return viewOf(cur()).live;
    },
    /** 本地在途：我这轮自己发起的流（≠ 该任务的整体运行态） */
    get sending(): boolean {
        return cur()?.running() ?? false;
    },
    get running() {
        return cur()?.running() ?? false;
    },
    get error() {
        return cur()?.error() ?? null;
    },
    open,
    send,
    cancel,
    /** 会话页挂载期间对 main 真值（返回停止函数，由调用方 cleanup） */
    watch,
    /** 手动对一次真值（测试/调试用） */
    refreshActive,
    clear,
    setScroll,
    getScroll,
    setTab,
    getTab,
    setDetailScroll,
    getDetailScroll,
};
