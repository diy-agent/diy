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
import { BlockStore, toForest, type BlockNode, type Op } from "../../main/services/local-blocks";
// 插话队列项的类型在 core/drafts（与草稿同文件存储）；这里只要类型，故 type-only import
//（不会把 node:fs 依赖带进 renderer）
import type { SteerItem, SteerMode } from "../../main/core/drafts";
import { personaStore } from "./personaStore";
import { sessionView, type SessionView } from "../../shared/session-view";
// 用量账本类型：与 main 落盘、CLI 报表、看板共用同一份形状（shared/usage 是唯一口径处）
import type { StepUsageRecord } from "../../shared/usage";
import type { FlatCompactPolicy, HeadTailPolicy } from "../../shared/context/compaction";

/**
 * 已加载的一段窗口（任务 293）：一段从**轮首**开始的折叠 op 流 fold 出来的块树。
 *
 * 为什么分段而不是一个 store：上滚补一段时，**前面所有段的块对象引用不变** ——
 * `toForest` 的身份缓存（TreeCache）全保留，已渲染的轮不重建、折叠态不丢、
 * Markdown 不重解析（任务 236 的治本点，分段是它在分页下的延伸）。
 */
interface Segment {
    store: BlockStore;
    /** 本段的轮次 id 序列（升序）；段间拼接即全局轮次序 */
    ids: string[];
    /** 本段起点游标（main 签发的不透明 token）—— 上滚时回传它取更早一段 */
    cursor: string;
}

interface TaskState {
    /** 已加载的窗口段，**升序**（更早的在前）；尾部流式内容落在最后一段 */
    segments: Segment[];
    /** 末段起点游标（轮末刷新回传它重取**同一段**：起点固定，于是能增量并入） */
    tailCursor: string | null;
    /** 最老段之前是否还有更早的轮次（信号：UI 的「加载更早」提示条读它） */
    hasMore: () => boolean;
    setHasMore: (v: boolean) => void;
    /** 上滚补段在途（信号 + 并发去重：滚动事件会连发） */
    olderBusy: () => boolean;
    setOlderBusy: (v: boolean) => void;
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
    /** 待投递的插话（FIFO）。权威在任务目录 .diy/drafts.yaml，这里只是当前快照 */
    steers: () => SteerItem[];
    setSteers: (v: SteerItem[]) => void;
    /**
     * 队列快照的提交序号（防乱序覆盖）。
     *
     * 三个入口都会拿全量快照回来（add/cancel 的返回值、以及被投递后的 list 刷新），
     * 它们的响应可能**乱序到达**：例如「插话刚被投递→list 回来了新队列」之后，
     * 早先发出的 add 响应才到（旧队列），界面就会回退成一条早已投递的"待发送"，
     * 而用户会以为自己的话还没发出去。用递增序号只认最新一次发起的结果。
     */
    steerSeq: number;
    /** 已落地的最新序号（小于它的响应一律丢弃） */
    steerSettled: number;
    /** 阅读位置：会话块树滚动区 scrollTop（内存态，随会话保留；不落盘——重启后从最新看起） */
    scroll: number;
    /** 详情面板当前 tab（local=agent 对话 / info=任务详情），per-task 记忆 */
    tab: "local" | "info";
    /** 详情 tab 的滚动位置（info 滚动容器 scrollTop） */
    detailScroll: number;
    /** 历史加载在途 promise：open() 并发去重（见 open 内注释） */
    loading?: Promise<void>;
    /**
     * 逐步用量账本（`<key>.usage.jsonl` 的结构化镜像）。
     * 权威在盘上；这里是快照，打开会话时拉一次，轮次收尾（含别人的轮次）时再拉一次。
     * 对话流页脚**不依赖它**（页脚用 turn 块属性，实时就有）——它服务于明细与看板。
     */
    usage: () => StepUsageRecord[];
    setUsage: (v: StepUsageRecord[]) => void;
}

/**
 * 冷加载 / 上滚补段的字节预算（任务 293，**临时手段**）。
 *
 * 大会话（数十~数百 MB）不能整份 fold 也不能整量回包：按预算取「最近一段」，上滚再补。
 * 4MB 是取舍：窗口内实测 fold ~60ms（74.8MB 会话，见任务 ##293 实测表），一屏翻完
 * 通常不会再触发上滚；调大 = 首载变慢，调小 = 上滚更频繁。终局方案是「固定 step 数 + 补桩」。
 */
const HISTORY_WINDOW_BYTES = 4 * 1024 * 1024;

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
        const [steers, setSteers] = createSignal<SteerItem[]>([]);
        const [usage, setUsage] = createSignal<StepUsageRecord[]>([]);
        const [hasMore, setHasMore] = createSignal(false);
        const [olderBusy, setOlderBusy] = createSignal(false);
        s = {
            segments: [], tailCursor: null, hasMore, setHasMore, olderBusy, setOlderBusy,
            loaded: false, trees, setTrees, running, setRunning,
            active, setActive, stopRequestedAt, setStopRequestedAt, abort: null,
            error, setError, steers, setSteers, usage, setUsage, steerSeq: 0, steerSettled: 0,
            scroll: 0, tab: "local", detailScroll: 0,
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

/**
 * 块树快照刷新。
 *
 * ⚠️ 不是"重建整棵树"了：`toForest` 对**未被 op 触碰过**的子树返回同一对象（身份缓存，
 * 见 local-blocks 的 TreeCache 头注），于是 Solid 的 `<For>` 只更新真正变化的那一轮，
 * 其余轮次的组件（连同其折叠态与 Markdown 解析结果）原地保留。
 * 这是任务 236 的治本点：以前每帧全量重建 → 折叠态被清、点击无响应、长回答卡顿。
 */
function refresh(st: TaskState) {
    // 段间拼接：每段已有自己的身份缓存，跨段拼出新数组只多一次 O(轮数) 遍历
    st.setTrees(st.segments.flatMap((seg) => toForest(seg.store)));
}

/** 一份 op 流里的轮次 id 序列（折叠流里 turn 的 `start` 即轮次边界） */
function turnIdsOf(ops: Op[]): string[] {
    return ops.filter((o) => o.op === "start" && o.kind === "turn").map((o) => o.id);
}

/**
 * 把 op 流并入某一段的块树。
 *
 * ⚠️ 「重复 apply 无副作用」**有前提**：store **不得领先于**这份快照（`patch` 无条件覆盖、
 * `delta` 只管追加，见 local-blocks 的 apply）。拿一份**早于在途流**的快照再喂一遍，会把
 * 更靠前的值写回去、后续 delta 追加在回退值上 ⇒ 丢一段，直到下次 reload 从盘上恢复。
 * 触发面：首载与在途流式并发（`doReload` 有 `running()` 挡着，首载没有）。
 */
function applyInto(seg: Segment, ops: Op[]): void {
    // 重复 apply 会给"重复 start"记 issue；渲染端不消费 issues，但别让它无界堆积
    if (seg.store.issues.length > 0) seg.store.issues.length = 0;
    for (const op of ops) seg.store.apply(op);
}

/** `prefix` 是不是 `arr` 的前缀（前缀守卫的判据；空前缀恒真） */
function isPrefix(prefix: readonly string[], arr: readonly string[]): boolean {
    if (prefix.length > arr.length) return false;
    for (let i = 0; i < prefix.length; i++) if (prefix[i] !== arr[i]) return false;
    return true;
}

/** 末段（尾部窗口所在的那一段）；还没有段时返回 undefined */
function tailSegment(st: TaskState): Segment | undefined {
    return st.segments[st.segments.length - 1];
}

/** 流式 op 的落点：末段；还不存在段时补建一个空段（首载失败也会先收到流） */
function tailForWrite(st: TaskState): Segment {
    let seg = tailSegment(st);
    if (!seg) {
        seg = { store: new BlockStore(), ids: [], cursor: "" };
        st.segments.push(seg);
    }
    return seg;
}

/**
 * 把一份**尾部窗口**（首载 / 轮末刷新）并入块树。**能增量就绝不重建** —— 这是治
 * 「轮末 GC 风暴」的关键（任务 236/290）。
 *
 * 旧实现每轮 reload 都 `new BlockStore()` 再全量 fold：新 store 里每个 BlockNode 都是新对象
 * → toForest 的身份缓存（TreeCache）全部失效 → Solid 的 `<For>` 把**每一轮**都销毁重建
 * （连同全量 Markdown re-parse）。而此刻真正变化的，通常只有刚跑完的那一轮。
 *
 * 折叠流是**幂等**的：`start` 重复被忽略、`patch` 值未变不写也不 touch、`stop` 幂等
 * （见 local-blocks 的 apply / compactOps）。所以整段再喂一遍安全且无副作用 ——
 * 没变的轮次引用不变，`<For>` 只更新真正变化的那轮。
 *
 * 前缀守卫（按段）：窗口的轮次序列只能以**末段的序列为前缀**（起点固定 ⇒ 只会变长）。
 * 对不上（被清空 / 换成别的会话 / 日志被外部改写 / 窗口起点漂移）⇒ 重置为**单段** ——
 * 宁可重来一次，也不把两段历史缝在一起。
 *
 * `stale` = **main 说游标失效、这一份是全量**（`HistoryWindow.stale`）。它必须像"前缀守卫
 * 不成立"一样**强制重置**，不能只靠前缀守卫兜：被覆盖写的全量若与末段轮次 id 巧合相容
 * （同会话重写 / 同 id 重放），前缀守卫会**放行**，于是前面那些属于旧日志的段被静默留在
 * 树里 —— 用户看到的是"上一份历史 + 这一份历史"缝在一起的东西。契约归契约，巧合不算数。
 */
function mergeWindow(st: TaskState, ops: Op[], cursor: string, hasMore: boolean, stale = false): void {
    const ids = turnIdsOf(ops);
    const tail = tailSegment(st);
    if (!stale && tail && isPrefix(tail.ids, ids)) {
        applyInto(tail, ops); // 增量：只有真正变化的那一轮换引用
        tail.ids = ids;
        tail.cursor = cursor;
        st.tailCursor = cursor;
        // ⚠️ 不动 hasMore：那是「**最老**段之前还有没有轮」，单段时才等于本窗口的 hasMore
        return;
    }
    const seg: Segment = { store: new BlockStore(), ids: [], cursor };
    applyInto(seg, ops);
    seg.ids = ids;
    st.segments = [seg];
    st.tailCursor = cursor;
    st.setHasMore(hasMore);
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
        // 带**末段游标**重取同一段（起点固定 ⇒ 只有尾巴变长 ⇒ 末段增量并入，不重建）。
        // 不带游标就得重新 seek，窗口起点会随文件增长往前漂 → 末段前缀守卫必然失败 → 整树重建。
        const r = await diyService.diy.agent.local.historyWindow({
            taskUri,
            cursor: st.tailCursor ?? undefined,
            budgetBytes: st.tailCursor ? undefined : HISTORY_WINDOW_BYTES,
        });
        // 游标失效（日志被清空 / 被覆盖写）⇒ main 给的是**全量**：必须整树重置。
        // 不重置的话，末段之外的更早段全是已然不存在于日志里的旧内容（见 mergeWindow 头注）。
        if (r.stale) {
            console.warn(`[localChat] 轮末重放游标失效，已重置块树 ${taskUri}`);
            notificationStore.addToast("info", "会话日志已被改写，已重新加载最近一段");
        }
        mergeWindow(st, r.ops as Op[], r.cursor, r.hasMore, r.stale);
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
        // 下降沿：main 刚收尾一轮 —— 它的 op 我这条流收不到，主动重放让树追上终态；
        // 用量账本同理（别人跑的轮次也要在看板/明细里看见，不能只有自己发的才算数）
        if (was && !active) {
            await reload(taskUri);
            void refreshUsage(taskUri);
        }
    } catch (e) {
        // 查询失败不改既有判断：宁可留着上一次的真值，也不能当作"没人跑"（那正是误报中断的成因）
        console.warn(`[localChat] 运行态查询失败 ${taskUri}:`, e);
    }
    setNowMs(Date.now());
}

/**
 * 拉用量的在途合并标记（同一 task 只保留一次在途请求）。
 * 与 refreshSteers 同一理由：轮末下降沿 / send 收尾 / open 首载三处都可能同时触发，
 * 而盘上的账是同一份 —— 重复拉只浪费 RPC。
 */
const usageInflight = new Set<string>();

/**
 * 拉取逐步用量账本（`<key>.usage.jsonl` 的结构化镜像）。
 *
 * 失败**不抛**也不清空：用量是观测数据，拉不到时界面应保留上一份快照（并把"可能不是最新"
 * 说出来），而不是把看板清成空表 —— 空表会被读成"这个会话没花过钱"，是假事实。
 */
async function refreshUsage(taskUri: string): Promise<void> {
    const st = states.get(taskUri);
    if (!st) return;
    if (usageInflight.has(taskUri)) return;
    usageInflight.add(taskUri);
    try {
        const rows = (await diyService.diy.agent.local.usage({ taskUri })) as StepUsageRecord[];
        st.setUsage(Array.isArray(rows) ? rows : []);
    } catch (e) {
        console.warn(`[localChat] 用量账本读取失败 ${taskUri}:`, e);
    } finally {
        usageInflight.delete(taskUri);
    }
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
/**
 * 时机切换失败的计数（纯 UI 用）。
 *
 * 为什么需要：横条上的开关是 `<input type=checkbox checked={...}>`，**受控**。用户点击时
 * 浏览器已经把 DOM 的 checked 翻过去了；若这次 RPC 失败，快照不变 → Solid 的 attribute
 * effect 重算出的值跟上次一样 → **不写 DOM** → 开关停在用户点出的那一侧，而盘上还是原值
 * （界面显示"已加急"，实际仍在排队）。这不是"显示旧值"，是"显示假值"。
 * 计数递增让订阅它的 effect 必定重跑，把 DOM 强制写回真实状态。
 */
const [steerToggleTick, setSteerToggleTick] = createSignal(0);

/** 切换/进入会话：首次加载持久化 Op 日志；已加载过的直接复用（含在途流式） */
/** 拉历史并 fold 进块树（open 的实际加载体，被在途去重包裹） */
async function loadHistory(st: TaskState, taskUri: string): Promise<void> {
    try {
        // 首载只取**最近一段**（按字节预算向上 seek 轮首）；更早的在用户上滚时再补（loadOlder）
        const r = await diyService.diy.agent.local.historyWindow({
            taskUri,
            budgetBytes: HISTORY_WINDOW_BYTES,
            cursor: undefined,
        });
        mergeWindow(st, r.ops as Op[], r.cursor, r.hasMore);
        refresh(st);
        st.loaded = true;
    } catch (e) {
        // 历史拉失败≠无历史：降级可见（toast）+ 不标 loaded（下次进入自动重试），绝不静默展示空会话
        console.warn(`[localChat] 历史加载失败 ${taskUri}:`, e);
        notificationStore.addToast("error", "本地会话历史加载失败，将显示不完整并在下次进入时重试");
    }
}

/**
 * 落地一个队列快照（带乱序保护）。
 *
 * 返回 false 表示这次结果是**过期的**（期间已有更晚发起的请求落地），调用方据此跳过后续处理。
 */
function commitSteers(taskUri: string, seq: number, items: SteerItem[]): boolean {
    const st = stateFor(taskUri);
    if (seq < st.steerSettled) return false;
    st.steerSettled = seq;
    st.setSteers(items);
    return true;
}

/** 领取一个提交序号（每次发起请求时调用，保证严格递增） */
function nextSteerSeq(taskUri: string): number {
    const st = stateFor(taskUri);
    return ++st.steerSeq;
}

/** 该 task 的队列拉取是否在途 / 在途期间是否又需要重拉（见 refreshSteers 的在途合并） */
const steerRefreshInflight = new Set<string>();
const steerRefreshDirty = new Set<string>();

/**
 * 拉取插话队列快照。
 *
 * 失败**不抛**也不清空已有快照：队列是用户已提交的内容，界面上把横条抹掉比留着旧数据更糟
 * （用户会以为自己的插话已经发出去了）。留旧值 + toast 告知。
 */
async function refreshSteers(taskUri: string): Promise<void> {
    // 在途合并：一轮里可能**整批**投递多条插话（每条落一个带 steer 的 start op），
    // 逐个拉就是 N 次 RPC + N 次快照提交，而只有最后一次的结果有意义。
    // 已有拉取在途时不排队再来一次，只记「还得再拉」—— 在途那次回来后再补一趟，
    // 这样既不丢最新快照，又把 N 次压到 2 次；也不引入时间片延迟（横条该下架时立刻下架）。
    if (steerRefreshInflight.has(taskUri)) {
        steerRefreshDirty.add(taskUri);
        return;
    }
    steerRefreshInflight.add(taskUri);
    try {
        do {
            steerRefreshDirty.delete(taskUri);
            const seq = nextSteerSeq(taskUri);
            try {
                const items = (await diyService.diy.agent.local.steer.list({ taskUri })) as SteerItem[];
                commitSteers(taskUri, seq, items);
            } catch (e) {
                console.error(`[localChat] 插话队列读取失败 ${taskUri}:`, e);
                notificationStore.addToast("error", "插话队列读取失败，横条可能不是最新（详见控制台）");
            }
            // 期间又有投递（dirty 被置上）→ 再拉一次对齐；没有则退出
        } while (steerRefreshDirty.has(taskUri));
    } finally {
        steerRefreshInflight.delete(taskUri);
    }
}

async function open(taskUri: string) {
    setCurrentUri(taskUri);
    const st = stateFor(taskUri);
    void refreshActive(taskUri); // 进入会话立刻对一次真值，不等轮询第一拍
    // 队列与历史独立：loaded 与否都要拉（横条反映的是"当前待投递"，与历史加载进度无关）
    void refreshSteers(taskUri);
    // 用量账本同理独立：看板/明细要的是"这个会话花过多少"，与块树加载进度无关
    void refreshUsage(taskUri);
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
                // 键必须出现（契约里 optional 字段也是必填键）：显式 undefined = 不覆盖人物配置；
                // 这里不给 mode = 开一轮（给出 mode 则只入队，见 submitSteer）
                mode: undefined,
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
            tailForWrite(st).store.apply(op);
            scheduleRefresh(st);
            // 插话被投递：main 落了带 steer 标记的 user 块（见 local-agent 的 steerBlockOps）→
            // 队列已经少了一条，立刻重拉快照。否则横条会一直挂着"待发送"，而模型其实已经看见了。
            if (op.op === "start" && op.kind === "text" && op.meta?.["steer"]) void refreshSteers(taskUri);
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
        // 轮次结束（含正常收尾/取消/报错）后对齐队列：本轮末尾可能投递了 turn 模式的插话，
        // 不刷新的话横条会一直挂着"待发送"，而模型其实已经看见了
        void refreshSteers(taskUri);
        // 用量同理：本轮的逐步账已写完，刷新让明细/看板立刻含上这一轮
        void refreshUsage(taskUri);
    }
}

/**
 * 提交一条插话：走 `chat --mode`，服务端只入队（不启动轮次），投递时机由 mode 决定。
 *
 * 必须把流消费到结束：服务端先回 ACK 再执行入队，只 await 调用会在落盘前就 refresh，
 * 横条会短暂看不到这条（见 channel-server-binding 的 _startServerStream）。
 */
async function submitSteer(taskUri: string, mode: SteerMode, text: string): Promise<boolean> {
    const body = text.trim();
    if (!body) return false;
    try {
        // 客户端类型要求每个键都在场：模型/推理只在开一轮时用，队列路径给 undefined
        const stream = await diyService.diy.agent.local.chat({
            taskUri,
            message: body,
            mode,
            model: undefined,
            reasoningEffort: undefined,
        });
        for await (const op of stream) void op; // 队列路径不产 op，走到 end 即入队完成
        await refreshSteers(taskUri);
        return true;
    } catch (e) {
        console.error(`[localChat] 插话提交失败 ${taskUri}:`, e);
        notificationStore.addToast("error", "插话提交失败（未能落盘），内容未排队");
        return false;
    }
}

/** 切换留言的投递时机（下一轮 ⇄ 下一步）；失败保留原快照。 */
async function toggleSteerMode(taskUri: string, id: string): Promise<void> {
    const seq = nextSteerSeq(taskUri);
    try {
        const items = (await diyService.diy.agent.local.steer.toggleMode({ taskUri, id })) as SteerItem[];
        commitSteers(taskUri, seq, items);
    } catch (e) {
        console.error(`[localChat] 插话时机切换失败 ${taskUri}#${id}:`, e);
        notificationStore.addToast("error", "切换时机失败，留言仍保持原状态");
        // 通知 UI 把受控开关写回真实状态（见 steerToggleTick 头注）
        setSteerToggleTick((t) => t + 1);
    }
}

/**
 * 重排待投递插话的顺序（横条上的拖拽排序；顺序即投递顺序）。
 *
 * 提交**完整顺序**而非"从 i 移到 j"：服务端不必猜移除源项后的下标该怎么算，
 * 界面也已经把目标排列算出来了。失败保留原快照（显示旧顺序 > 显示假顺序）。
 */
async function reorderSteers(taskUri: string, ids: string[]): Promise<void> {
    const seq = nextSteerSeq(taskUri);
    try {
        const items = (await diyService.diy.agent.local.steer.reorder({ taskUri, ids })) as SteerItem[];
        commitSteers(taskUri, seq, items);
    } catch (e) {
        console.error(`[localChat] 插话重排失败 ${taskUri}:`, e);
        notificationStore.addToast("error", "调整顺序失败，队列顺序未变");
    }
}

/** 取消一条待投递插话（幂等；失败保留原快照，避免界面与盘上不一致） */
async function cancelSteer(taskUri: string, id: string): Promise<void> {
    const seq = nextSteerSeq(taskUri);
    try {
        const items = (await diyService.diy.agent.local.steer.cancel({ taskUri, id })) as SteerItem[];
        commitSteers(taskUri, seq, items);
    } catch (e) {
        console.error(`[localChat] 插话取消失败 ${taskUri}#${id}:`, e);
        notificationStore.addToast("error", "插话取消失败，仍在队列中");
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
    st.segments = []; // 前缀守卫一并归零：新会话从空开始（下次并入必走重建那条）
    st.tailCursor = null;
    st.setHasMore(false);
    st.loaded = true; // 文件已删，不必重拉
    st.setError(null);
    st.setSteers([]); // 会话已清，排队中的插话也被 main 一并清掉（见 local-agent 的 clear()）
    st.setUsage([]); // 用量账本随会话日志一并删除（否则看板会把已清会话的花费继续算着）
    // ⚠️ 序号**不归零**：归零 = 把乱序保护的挡板撤掉 —— clear 之前发出的在途 `list` 响应带着
    // 旧序号（`commitSteers` 的判据是 `seq < steerSettled` 就丢弃），归零后它反而"比挡板新"
    // → 被接收 → 把已清空的队列写回界面（横条复活已清的插话，盘上其实已删）。
    // 保持序号单调递增，旧响应才会一律被判过期；再用一次真实拉取把界面与盘上对齐
    // （盘上此刻确实是空队列；刷新走自己的新序号，于是它在途里的旧响应全部作废）。
    void refreshSteers(taskUri);
    st.scroll = 0; // 会话清空，阅读位置一并归位
    refresh(st);
}

/**
 * 上滚补一段历史（任务 293）：取**最老段之前**的一段，前插进段列表。
 *
 * 返回 `true` 表示**真的插入了内容** —— 调用方据此做滚动位置补偿：内容插在视口上方会把
 * 正在看的那一行顶走（浏览器不会替我们保持位置），必须自己把 scrollTop 推回去。
 *
 * 不插入的三种情形（都返回 false，且都不该补偿）：
 *   · 没有更早的（`hasMore` false）或在途 / 首载未完成；
 *   · 取回来的段里没有轮次（前面只剩非轮内容）⇒ 顺带把 `hasMore` 置 false，别再请求；
 *   · main 报 `stale`（游标失效 ⇒ 给的是全量）或两段轮次重叠（防线）⇒ 按重置处理（见下）。
 *
 * ⚠️ **不要**用"新段与现有段的轮次构成前缀关系"判连续性：两段在字节上是切分的、
 * 轮次**不重叠**，那个判据恒假 ⇒ 每次上滚都会误重置（##293 踩过）。连续性由 main 的
 * 游标校验保证（decodeCursor + 轮首检查），渲染端只需认 `stale` 这一个信号。
 *
 * `beforeApply`：**紧贴前插落 DOM 之前**同步回调一次（拿到的是「插入前」的视口量）。
 * 位置补偿的基准必须在这里取，不能在 `loadOlder` 之前取 —— 取历史要走 RPC，这段
 * 时间里用户还在上滚，拿旧基准算出的**绝对**滚动位置会把用户这段滚动吞掉（##293 现象二：
 * 滚到顶继续滚，补段后又被拽回触发那一刻）。改由调用方在这里量、在插入后按**增量**补。
 */
async function loadOlder(taskUri: string, beforeApply?: () => void): Promise<boolean> {
    const st = states.get(taskUri);
    if (!st || !st.loaded || !st.hasMore() || st.olderBusy()) return false;
    const oldest = st.segments[0];
    if (!oldest) return false;
    st.setOlderBusy(true);
    try {
        const r = await diyService.diy.agent.local.historyOlder({
            taskUri,
            cursor: oldest.cursor,
            budgetBytes: HISTORY_WINDOW_BYTES,
        });
        const ops = r.ops as Op[];
        const ids = turnIdsOf(ops);
        if (ids.length === 0) {
            st.setHasMore(false); // 到顶：别再多跑一次白工
            return false;
        }
        // 重叠防线：正常补段取的是 [新起点, 最老段起点)，与现有轮次必然不相交。
        // 相交 = main 给的不是"更早一段"（游标失效退了全量）⇒ 两段不许缝在一起（与 mergeWindow 同一取向）：
        // 重置为这一段，并**说出来** —— 用户看到历史被复位，必须知道是为什么。
        if (r.stale || ids.some((id) => oldest.ids.includes(id))) {
            console.warn(`[localChat] 上滚补段游标失效/重叠，已重置块树 ${taskUri}`);
            notificationStore.addToast("info", "会话日志已被改写，已重新加载最近一段");
            st.segments = [];
            mergeWindow(st, ops, r.cursor, r.hasMore, r.stale);
            flushRefresh(st);
            return false; // 重建不是前插 ⇒ 不做位置补偿（视口本就该挪到新内容上）
        }
        const seg: Segment = { store: new BlockStore(), ids: [], cursor: r.cursor };
        applyInto(seg, ops);
        seg.ids = ids;
        st.segments.unshift(seg); // 前插：**已有段的块对象引用一个都不动** → 折叠态/渲染不重来
        st.setHasMore(r.hasMore);
        beforeApply?.(); // 基准取样点：必须紧贴 flushRefresh（此刻 DOM 还是「插入前」）
        flushRefresh(st);
        return true;
    } catch (e) {
        console.warn(`[localChat] 上滚补段失败 ${taskUri}:`, e);
        notificationStore.addToast("error", "更早的会话历史加载失败");
        return false;
    } finally {
        st.setOlderBusy(false);
    }
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


// ─── 压缩（compact）：少发 ≠ 销毁 ──────────────────────
//
// 语义提醒（与 clear 正交）：
//   compact = 只改「发给模型的上下文」（按字节预算保留历史 + 可选裁工具输出），
//             **不删任何历史**，旧内容仍在 ops 里、可查、可撤销；
//   clear   = 物理删除所有会话日志（不可恢复）—— 那是另一条路，与压缩无关。
// 全部计算在 main（预览与真发共用同一份纯函数），renderer 只负责把结果画出来。

/** 压缩预览（只算不写）：返回 base（未压缩全量）与 mod（当前预算）两个请求 + 事实表 */
async function compactPreview(taskUri: string, policy: FlatCompactPolicy, summaryText?: string) {
    return diyService.diy.agent.local.compactPreview({ taskUri, ...policyFlat(policy), summaryText });
}

/** 自动压缩检测（只读）：事实 / 触发理由 / 生效 TTL / 当前配置 */
async function autoCompactStatus(taskUri: string) {
    return diyService.diy.agent.local.autoCompactStatus({ taskUri });
}

/** 写自动压缩配置（真源 = $DIY_HOME/auto-compact.yaml；patch = 部分字段，主进程浅合并） */
async function autoCompactSetConfig(patch: Record<string, unknown>) {
    return diyService.diy.agent.local.autoCompactSetConfig({ patch });
}

/** 执行压缩（写边界账 + 落盘被裁原文 + 内存态重置）；成功后重建本地块树到新边界 */
async function compact(
    taskUri: string,
    policy: FlatCompactPolicy,
    summary?: { text: string; data: unknown; cost: number | null },
) {
    const rec = (await diyService.diy.agent.local.compact({
        taskUri,
        ...policyFlat(policy),
        ...(summary ? { summaryText: summary.text, summaryData: summary.data, summaryCost: summary.cost } : {}),
    } as never)) as { noop?: boolean } | undefined;
    // 压缩后当前会话视图变了（只含边界后的轮）→ 重建块树，让界面立刻反映新会话
    await reload(taskUri);
    return rec;
}

/** 撤销一次压缩（append-only 的 undo）；成功后重建到恢复后的边界 */
async function undoCompact(taskUri: string, ref: string) {
    const r = await diyService.diy.agent.local.undoCompact({ taskUri, ref });
    if (r.undone) await reload(taskUri);
    return r.undone;
}

/** 压缩事件账（历史页：不可变快照列表） */
async function compactEvents(taskUri: string) {
    return diyService.diy.agent.local.compactEvents({ taskUri });
}

/** 策略对象 → RPC 扁平参数（headtail 展开成顶层字段，与 api-def 的 cliOption 对齐） */
function policyFlat(p: FlatCompactPolicy): {
    budgetBytes: number;
    toolResult: "asis" | "headtail" | "callpath";
    triggerLines: number | undefined;
    headLines: number | undefined;
    tailLines: number | undefined;
    maxLineChars: number | undefined;
    maxKeepBytes: number | undefined;
    summary: boolean;
} {
    const ht: Partial<HeadTailPolicy> = p.headtail ?? {};
    return {
        budgetBytes: p.budgetBytes,
        toolResult: p.toolResult,
        triggerLines: ht.triggerLines,
        headLines: ht.headLines,
        tailLines: ht.tailLines,
        maxLineChars: ht.maxLineChars,
        maxKeepBytes: ht.maxKeepBytes,
        summary: p.summary,
    };
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
    /** 当前任务的待投递插话（FIFO） */
    get steers(): SteerItem[] {
        return cur()?.steers() ?? [];
    },
    /** 当前任务的逐步用量账本（快照；权威在盘上，见 refreshUsage） */
    get usage(): StepUsageRecord[] {
        return cur()?.usage() ?? [];
    },
    /** 当前打开的会话 URI（null = 没选任务）。供组件触发 refreshUsage 时用 */
    get currentUri(): string | null {
        return currentUri();
    },
    /** 手动刷新用量账本（看板打开/调试用） */
    refreshUsage,
    open,
    send,
    cancel,
    /** 会话页挂载期间对 main 真值（返回停止函数，由调用方 cleanup） */
    watch,
    /** 手动对一次真值（测试/调试用） */
    refreshActive,
    submitSteer,
    cancelSteer,
    toggleSteerMode,
    reorderSteers,
    /** 时机切换失败计数：UI 订阅它把受控开关写回真实状态（见其定义处头注） */
    get steerToggleTick() {
        return steerToggleTick();
    },
    refreshSteers,
    clear,
    /** 压缩：预览（只算）/ 执行 / 撤销 / 压缩历史（事件快照列表，只读查看）*/
    compactPreview,
    compact,
    autoCompactStatus,
    autoCompactSetConfig,
    undoCompact,
    compactEvents,
    /** 上滚补一段更早的历史；返回是否真的插入了内容（调用方据此做滚动位置补偿） */
    loadOlder,
    /** 更早还有没有轮次（响应式：UI 的「加载更早」提示条读它） */
    get hasOlder(): boolean {
        return cur()?.hasMore() ?? false;
    },
    /** 上滚补段在途（响应式） */
    get olderLoading(): boolean {
        return cur()?.olderBusy() ?? false;
    },
    setScroll,
    getScroll,
    setTab,
    getTab,
    setDetailScroll,
    getDetailScroll,
};
