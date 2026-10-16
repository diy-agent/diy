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
import type { OpsFrame } from "../../shared/ops-frame";
// 阅读位置锚点的形状（纯函数模块，零 DOM）：与滚动决策同源，故不在此另定一份
import type { ChatAnchor } from "../lib/chat-scroll";
// 插话队列项的类型在 core/drafts（与草稿同文件存储）；这里只要类型，故 type-only import
//（不会把 node:fs 依赖带进 renderer）
import type { SteerItem, SteerMode } from "../../main/core/drafts";
import { personaStore } from "./personaStore";
import { sessionView, type SessionView } from "../../shared/session-view";
import { StopTicker } from "../lib/stop-ticker";
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

/**
 * op 订阅健康度（##327 review1 R1）。
 *
 * 为什么需要这个状态位：单通道化（chat 流不再 apply）之后，**实时输出 100% 依赖订阅送达**，
 * 而"订阅坏了"在界面上与"模型正在想"完全同形 —— 没有这个位，谁也说不出"这一轮为什么没有字"。
 * 它同时是轮末自检（settleOpsAfterTurn）的判据：`live` 却不前进 = 流连着但一个帧也不来。
 *
 * `down` 的呈现（##354 ③）：**会话区常驻条**（LocalChatPage 的 `data-ops-down`），不是一次性
 * toast —— 故障瞬间切走窗口就错过，而"看不到实时字"这件事恰恰是那时最需要知道的。
 * 故它必须是**信号**（组件要能订阅到变化）。
 * ⚠️ `down` 是**粘性**的：一经置位，只有**真收到帧**（markOpsLive）才熄灭 —— 重连尝试期间
 * 保持 down（重订不退回 connecting）。否则重连那一瞬会把常驻条抹掉，用户看到的仍是"静默冻结"。
 */
export type OpsState = "idle" | "connecting" | "live" | "down";

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
    /**
     * 阅读位置：**视口顶部那个块的锚点**（块 id + 块内偏移），不是绝对 scrollTop（##331 ③）。
     *
     * 为什么不是像素：本页高度已知不稳定（`content-visibility:auto` 的估算高度 / Markdown 撑高），
     * 绝对像素在"保存"与"恢复"两个时刻指向的**内容**不是同一处 —— 实测切走切回偏 10 轮。
     * 块身份在高度怎么变的情况下都指同一行（与 ##293 的位置补偿同一思路）。
     * 内存态，随会话保留；不落盘 —— 重启后从最新看起。
     */
    scroll: ChatAnchor | null;
    /** 详情面板当前 tab（local=agent 对话 / info=任务详情），per-task 记忆 */
    tab: "local" | "info";
    /** 详情 tab 的滚动位置（info 滚动容器 scrollTop） */
    detailScroll: number;
    /** 历史加载在途 promise：open() 并发去重（见 open 内注释） */
    loading?: Promise<void>;
    /**
     * op 增量订阅的**已应用到第几行**（ops.jsonl 行号，1-based；0 = 尚无）。
     * 见 subscribeOps 头注：首载用 history（折叠流），增量用 opsWatch，两者按 seq 对齐。
     */
    appliedSeq: number;
    /** 已见会话代次（main 侧 clear 会换发 → 收到不符的帧说明历史被清空，须重建） */
    epoch: number;
    /** op 订阅的取消句柄（null = 未订阅）。切任务时取消，回来时按水位补发追平 */
    opsAbort: AbortController | null;
    /** op 订阅健康度（信号；见 OpsState 头注）：实时显示的唯一通道通不通 */
    opsState: () => OpsState;
    setOpsState: (v: OpsState) => void;
    /** 本段故障是否已浮到界面（一段故障只提示一次；恢复时清，下段故障还能提示） */
    opsDownNotified: boolean;
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
        const [opsState, setOpsState] = createSignal<OpsState>("idle");
        const [hasMore, setHasMore] = createSignal(false);
        const [olderBusy, setOlderBusy] = createSignal(false);
        s = {
            segments: [], tailCursor: null, hasMore, setHasMore, olderBusy, setOlderBusy,
            loaded: false, trees, setTrees, running, setRunning,
            active, setActive, stopRequestedAt, setStopRequestedAt, abort: null,
            error, setError, steers, setSteers, usage, setUsage, steerSeq: 0, steerSettled: 0,
            scroll: null, tab: "local", detailScroll: 0,
            appliedSeq: 0, epoch: -1, opsAbort: null, opsState, setOpsState, opsDownNotified: false,
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
    // 游标策略收口在此（**唯一**决定点）：`stale` 时 main 给的是**全量**，游标落在 at:0 ——
    // 它是个合法轮首，回传下去 main 会照收 ⇒ 此后每轮末都退全量（把"整量回包"贴回来）。
    // 故 stale 一律丢弃（下一轮按预算重新 seek；前缀守卫不符时自会重置成新窗口，无副作用）。
    // 注意 `seg.cursor` 仍 = 传入游标（末段自身可继续增量），只有**跨轮的 tailCursor** 被丢弃。
    st.tailCursor = stale ? null : cursor;
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
// ##307 起不再轮询：轮次边界 op 到达时对一次 main 真值即可（见 applyOpsFrame）。

/** 判据用的"现在"：让停止宽限期（shared/session-view.ts）能自己过期 */
const [nowMs, setNowMs] = createSignal(Date.now());

/**
 * 「停止收尾中」的时钟推进器（##307 review2 R2）。
 *
 * 删掉 2s 轮询后 nowMs 只在「refreshActive 返回 / cancel」前进；main 卡在工具里（不发 op、
 * 不落轮次边界）时它会冻住 → stoppingStuck 永假 → 「强制中断」出口成死代码（本地说"还在
 * 停止"，服务端也仍在跑，按钮却永不可点）。故**仅在**有任务处于停止收尾时保留一节克制的
 * tick，只推进 nowMs；无任务在停止即停表（不空转）。逻辑见 lib/stop-ticker.ts。
 */
const STOP_TICK_MS = 500;
const stopTicker = new StopTicker(() => setNowMs(Date.now()), { intervalMs: STOP_TICK_MS });

/** 是否有任务处于「已请求停止」（判据同 session-view 的 requested） */
function anyTaskStopping(): boolean {
    for (const st of states.values()) if (st.stopRequestedAt() !== null) return true;
    return false;
}

/** 对齐停止时钟（cancel / refreshActive 清掉停止态 / 页面卸载时调用）。幂等。 */
function syncStopTicker(): void {
    stopTicker.sync(anyTaskStopping());
}

/**
 * `stopRequestedAt` 的**唯一写点**：改值后立刻对齐停止时钟（幂等）。
 * 收口在此，杜绝「某处清了停止态却忘了同步 ticker」的漂移（review3 R6：
 * send 清停态未同步、watch/open 起始未同步，都会让 ticker 停在错的状态）。
 */
function setStopRequested(st: TaskState, v: number | null): void {
    st.setStopRequestedAt(v);
    syncStopTicker();
}

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
        // stale ⇒ 这份是全量，尾游标由 mergeWindow 统一丢弃（见其重置分支）；下一轮按预算重新 seek。
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
        if (!active) {
            // main 已收尾 → 停止态结束（helper 内同步对齐时钟）
            setStopRequested(st, null);
        }
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

/**
 * 会话页挂载期间对一次 main 真值；返回清理函数（组件 cleanup 调用）。
 *
 * ##307：原来的 2s 轮询已删。「别人正在跑」这件事现在由 **op 增量事件**发现 ——
 * 轮次边界 op 一到就 `refreshActive` 对一次真值（见 applyOpsFrame），不再有"最多迟 2s"的窗口，
 * 也不再有空转的定时器。清理函数保留（组件契约不变）：退订 + 对齐停止时钟。
 */
function watch(taskUri: string): () => void {
    // 起始对齐停止时钟（review3 R6）：切走再切回时，若该 task 仍在停止收尾，必须重新开表，
    // 否则 now 冻住 → stoppingStuck 恒假 → 「强制中断」出口再次成死代码。
    syncStopTicker();
    void refreshActive(taskUri);
    // 组件卸载（切走会话页 / 页面关闭）时退订，别让订阅悬着 ——
    // 悬着的订阅在页销毁时会以「Client disposed」形式炸日志（renderer 已死，流才断）
    return () => {
        unsubscribeOps(taskUri);
        // 页面卸载（切走 / 关闭）：本窗口不再显示停止态 → 停表（避免离开后 ticker 空转）。
        // 停止态本身留在 state 里；下次进入由 watch()/open() 起始的 syncStopTicker() 重新开表
        // （review3 R6：只停不开是缺陷，起始补 sync 即修）。
        stopTicker.stop();
    };
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

// ─── op 增量订阅（##307：写侧即推，取代 2s 轮询 / 轮末重放） ─────────────
//
// 帧形状与契约见 main 的 services/ops-feed.ts 与 api-def 的 opsWatch / opsWatermark。
//
// ⚠️ **本订阅是块树的唯一 apply 通道**（##327）：main 侧**同一个 op 走两条路**送达本窗口 ——
//   ① `opsFeed.publish` → 本订阅（广播，**带行号 seq**）；
//   ② `agent.local.chat` 的流（发起方专属，**不带 seq**，见 main 的 api-impl）。
// 两条都 apply = 同一条 delta 追加两遍 = **整段叠字**（实测：`先把现场看清楚` →
// `先把现场先把现场看清楚看清楚`）。症状只表现为文字、块结构却正常，是因为
// **delta 是纯追加、无唯一键、不幂等**，而 start / patch / stop 恰好幂等 ——
// 「重复 apply 无害」这个前提从来只对后三者成立。
// 故 `send()` 只**消费**那条流（拿"我这轮结束了/报错了"这一个信号），一个 op 都不落地；
// 实时显示（含插话投递后的队列刷新、轮次边界对真值）全部收口在本文件的 `applyOpsFrame`。
//
// 时序（必须按此序，否则会漏掉「首载期间」写入的 op）：
//   ① 取水位 wm = {epoch, seq}（ops.jsonl 当前行号）；
//   ② 拉 history（**折叠流**，大会话快路径）fold 成块树 —— 它覆盖范围 **≥ wm.seq**
//      （main 侧同步读文件，且①在②之前发起）；
//   ③ `appliedSeq = wm.seq`，建 opsWatch(since=wm.seq) → main 先补发 `(wm.seq, 现在]`，再接实时。
// ②③ 之间与补发段的重复由 seq 去重吸收 —— 但这份去重**只在本通道内成立**：它的依据是
// ops.jsonl 行号，而 chat 流的 op 没有行号、无从比对。这正是「chat 流不许 apply」的硬理由。
//
// ⚠️ 单通道的**代价**与兜底（##327 review1 R1）：订阅坏了 = 用户一个字也看不见（旧实现由
// chat 流兜住）。三条可达路径都不许当成"理论上不会发生"：
//   ① 订阅中断 / main 关流（有异常或流结束）→ 退避重订 + **界面出声**（notifyOpsDown）；
//   ② 退避窗口（OPS_RECONNECT_MS）内发的轮次 → 轮末自检发现水位没前进 → 立刻重订补发；
//   ③ 流"连着却一个帧也不来"（**无异常**，最阴的一种）→ 同样只有轮末自检能发现（settleOpsAfterTurn）。
// 补齐一律靠**重订**（main 的 subscribe 从 appliedSeq 同步读文件连续补发），
// 绝不把 chat 流请回来 apply —— 那条路的 op 没有行号，请回来就是双通道的老病。

/** 取会话 op 流水位（订阅起点的校准值） */
async function fetchWatermark(taskUri: string): Promise<{ epoch: number; seq: number }> {
    try {
        return (await diyService.diy.agent.local.opsWatermark({ taskUri })) as { epoch: number; seq: number };
    } catch (e) {
        // 拿不到水位不阻断会话：退化为「从 0 起订阅」—— 会全量补发（代价大但正确），
        // epoch 用 -1 表示「未知」，首帧 hello 会带回真值并触发一次重建校准。
        console.warn(`[localChat] op 水位读取失败 ${taskUri}:`, e);
        return { epoch: -1, seq: 0 };
    }
}

/**
 * 建立 op 增量订阅（**幂等**：已在订阅则直接返回）。
 *
 * 订阅句柄挂在 state 上，切任务时由 unsubscribeOps 取消 —— 后台任务的 op 不再进本窗口
 * （用户看不到，不必算），切回来时按 `appliedSeq` 水位补发追平（main 侧 subscribe 的补发段）。
 */
function ensureOpsSubscription(taskUri: string): void {
    const st = stateFor(taskUri);
    if (st.opsAbort) return;
    const ctrl = new AbortController();
    st.opsAbort = ctrl;
    // ⚠️ 已是 down 就**不退回 connecting**（##354 ③）：重订在**收到帧之前**并没有改变事实
    //   ——"通道断着"仍是真相，而"收到帧"才是恢复的唯一判据（见 markOpsLive）。
    //   若退回 connecting，常驻条会在重连期间一闪就没，恰好在用户最需要它的时候消失。
    if (st.opsState() !== "down") st.setOpsState("connecting");
    const since = st.appliedSeq;
    const epoch = st.epoch;
    void (async () => {
        // 非主动终止（中断 / main 侧关流）—— 与「被重订」「主动退订」分流，别混成一个布尔
        let broken = false;
        try {
            const stream = await diyService.diy.agent.local.opsWatch(
                { taskUri, since, epoch },
                { signal: ctrl.signal },
            );
            for await (const frame of stream) {
                // 已被重订（补洞）或退订：本流作废，别再处理它可能残留的帧
                //（否则会拿旧 since 的帧去撞新的 appliedSeq，误报缺口）
                if (st.opsAbort !== ctrl) break;
                // "通了"的判据是**收到帧**，不是调用返回：RPC 收下订阅≠main 那条推送路是通的
                // （subscribe 的首帧恒为 hello，见 ops-feed）。拿调用返回当健康，会在"流哑了"
                // 时给出假的"已恢复" —— 那正是 R1 要防的自欺。
                if (st.opsState() !== "live") markOpsLive(st);
                applyOpsFrame(taskUri, frame as OpsFrame);
            }
            // 循环正常退出：要么被重订（句柄已换，自有新流接手），要么 main 把流关了 —— 后者
            // 与中断同价（订阅没了 = 实时显示没了），**不能当"无事发生"**（旧实现就是这么静默的）。
            broken = st.opsAbort === ctrl;
            if (broken) console.warn(`[localChat] op 订阅被 main 关闭 ${taskUri}，将退避重连`);
        } catch (e) {
            // 正常退订（abort）与页面销毁（client disposed）都不是故障，别当异常刷日志
            const msg = e instanceof Error ? e.message : String(e);
            if (!ctrl.signal.aborted && !/disposed|abort/i.test(msg)) {
                console.warn(`[localChat] op 订阅中断 ${taskUri}，将退避重连:`, e);
                broken = true;
            }
        } finally {
            if (st.opsAbort === ctrl) {
                st.opsAbort = null;
                if (broken) {
                    notifyOpsDown(st); // 内含 setOpsState("down")
                    // ##307 review2 R3：非主动退订的中断若就此作罢，UI 会**静默冻结** ——
                    // reload 的触发源全是订阅事件，旧实现靠 2s 轮询兜底而轮询已删。
                    // 退避重订：从 appliedSeq 补发，断线期间的 op 不丢。
                    scheduleOpsReconnect(taskUri);
                } else {
                    st.setOpsState("idle");
                }
            }
        }
    })();
}

/**
 * 订阅**真的通**了（收到帧，见调用点）：记健康度；刚从故障里恢复则出一声"已恢复"
 * （**有始有终** —— 用户才知道现在可以看实时了；只报故障不报恢复，等于把"要不要刷新"留给用户猜）。
 */
function markOpsLive(st: TaskState): void {
    st.setOpsState("live");
    if (st.opsDownNotified) {
        st.opsDownNotified = false;
        notificationStore.addToast("success", "会话实时更新已恢复");
    }
}

/**
 * 显示通道不可用 → 记账（**每段故障一次**，恢复时由 markOpsLive 清）。
 *
 * 为什么非做不可（##327 review1 R1）：单通道化后订阅不可用 = 用户**一个字也看不到**，
 * 而这件事在界面上与"模型还在想"完全同形，只有 console.warn 的话用户永远不知道。
 * 真正的补齐由调用方负责（退避重订 / 轮末自检重订）。
 *
 * ⚠️ 呈现改由**界面常驻条**做（##354 ③，判据 = `opsState() === "down"`）：一次性 toast
 * 在"故障瞬间切走窗口"时必然错过，且它按类型自会消失 —— 而那正是用户最需要知道"现在没有实时字"
 * 的时刻。本函数退化为**记账 + 恢复提示的起点**（`opsDownNotified` 让 markOpsLive 知道
 * 该不该报"已恢复"），不再自己弹提示。
 */
function notifyOpsDown(st: TaskState): void {
    // 先亮常驻条（幂等）：**两条发现路径**都从这里过 —— ①流断了（ensureOpsSubscription 的
    // finally）②轮末自检发现水位没前进（settleOpsAfterTurn）。后者压根不经过 down 分支，
    // 若只在那里置位，静默订阅下常驻条永远不会亮。
    st.setOpsState("down");
    if (st.opsDownNotified) return;
    st.opsDownNotified = true;
    console.warn(`[localChat] 会话实时更新中断（常驻条已亮出，退回重连中）`);
}

/**
 * 轮末自检（##327 review1 R1）：这一轮产出过 op，**我的树就必须前进** —— 没前进就是"发出去
 * 却看不见"（chat 流的 op 已不落地，订阅是唯一通道）。
 *
 * 判据取**本地水位是否前进**（不问 main：省一次 RPC，也不搭"yield ⊆ publish"那条约定 ——
 * 那是 R2 的事，且 sink 落盘失败时它本来就允许分叉）。真值在我手上：本轮我确实从 chat 流里
 * 数到了 op，健康的订阅必然把同一批 op 也送进来。
 *
 * 先空等几拍再判（不是"等一会儿"）：同一连接上的帧**先于** chat 流的收尾写出
 * （main 侧 `sink` 落盘 → `publish` → 才 `yield`），故它们此时已在客户端，只差事件循环把
 * 它们投给订阅循环。空等一场若仍不前进，就不是在途、是真没来。
 * 误判的代价也只是多一次重订（幂等、不重复落地）—— 比"整轮看不见"便宜得多。
 */
async function settleOpsAfterTurn(taskUri: string, baseSeq: number): Promise<void> {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    const st = states.get(taskUri);
    if (!st) return;
    if (currentUri() !== taskUri) return; // 已切走：订阅本就该退订，别把它请回来
    if (st.running()) return; // 新一轮已在跑：它的轮末自检负责（别动在途那一条流）
    if (st.opsState() === "live" && st.appliedSeq > baseSeq) return; // 健康：这一轮经订阅送到了
    console.warn(
        `[localChat] 本轮 op 未经订阅送达 ${taskUri}：state=${st.opsState()} applied=${st.appliedSeq} base=${baseSeq}，重订补发`,
    );
    notifyOpsDown(st);
    // 重订 = abort 旧流 + 按 appliedSeq 重建：main 的 subscribe 会从该水位**连续补发**
    // （同步读文件，不走可能已坏的那条 publish 路），于是这一轮（乃至断线期间的一切）立刻补齐。
    resubscribeOps(taskUri);
}

/** op 订阅的退避重连句柄（每 task 至多一个在途重连） */
const opsReconnectAt = new Map<string, ReturnType<typeof setTimeout>>();

/** 退避重连间隔（ms）：非主动中断后按此重订；再次失败会再排下一次 */
const OPS_RECONNECT_MS = 1000;

/** 安排一次退避重连（幂等：已有在途则不重复排） */
function scheduleOpsReconnect(taskUri: string): void {
    if (opsReconnectAt.has(taskUri)) return;
    const t = setTimeout(() => {
        opsReconnectAt.delete(taskUri);
        const st = states.get(taskUri);
        if (!st || st.opsAbort) return; // 已退订（切任务）/ 已重订 → 放弃这次
        ensureOpsSubscription(taskUri);
    }, OPS_RECONNECT_MS);
    opsReconnectAt.set(taskUri, t);
}

/** 重订当前订阅（补洞用）：断旧流、按 appliedSeq 重建（main 侧连续补发缺口） */
function resubscribeOps(taskUri: string): void {
    const st = states.get(taskUri);
    if (!st) return;
    const ctrl = st.opsAbort;
    st.opsAbort = null; // 先清，让 ensure 能重建（旧流的 finally 因句柄已换而不会误清新句柄）
    ctrl?.abort();
    ensureOpsSubscription(taskUri);
}

/** 退订（切任务 / 清空时）。幂等。 */
function unsubscribeOps(taskUri: string): void {
    const st = states.get(taskUri);
    if (!st) return;
    const t = opsReconnectAt.get(taskUri);
    if (t !== undefined) {
        clearTimeout(t);
        opsReconnectAt.delete(taskUri);
    }
    st.opsAbort?.abort();
    st.opsAbort = null;
    st.setOpsState("idle"); // 主动退订（切任务/卸载）不是故障，不该留在 down 上
}

/** 落地一帧增量（判据全在此处，见上方时序注） */
function applyOpsFrame(taskUri: string, frame: OpsFrame): void {
    const st = states.get(taskUri);
    if (!st) return;
    if (frame.kind === "hello") {
        // 校准代次：epoch 不符时 main 会在本帧后紧跟一帧 reset（见 ops-feed.subscribe）
        st.epoch = frame.epoch;
        return;
    }
    if (frame.kind === "reset") {
        // 会话被清空（clear）：块树整棵作废，改由权威 history 重建（文件此刻是空/新内容）
        st.segments = [];
        st.tailCursor = null;
        st.setHasMore(false);
        st.appliedSeq = 0;
        st.epoch = frame.epoch;
        st.loaded = true;
        flushRefresh(st);
        void reload(taskUri);
        return;
    }
    // batch
    if (frame.epoch !== st.epoch) {
        // 代次不符（会话在订阅期间被清空过）→ 当前块树属于旧史书，丢掉重来
        st.segments = [];
        st.tailCursor = null;
        st.setHasMore(false);
        st.appliedSeq = 0;
        st.epoch = frame.epoch;
    }
    let ops = frame.ops;
    if (frame.fromSeq <= st.appliedSeq) {
        const skip = st.appliedSeq - frame.fromSeq + 1;
        if (skip >= ops.length) return; // 整批都已在树里（补发段/自发流的重叠）
        ops = ops.slice(skip);
    } else if (frame.fromSeq > st.appliedSeq + 1) {
        // 洞：缺的前文可能正是本批 patch/delta 的目标块的 start —— 按序并入会落成「未知块」。
        // 不猜、也不依赖可能被 running/loading 跳过的 reload（review2 R4）：abort 当前流、
        // 按 appliedSeq 重订，让 main 的 subscribe 把 (appliedSeq, now] **连续**补一遍
        // （补发是同步读文件，无跳过条件）。本批丢弃（重订后连同缺口一起重新送达），
        // 故**不推进** appliedSeq。
        console.warn(`[localChat] op 增量出现缺口 ${taskUri}: applied=${st.appliedSeq} got=${frame.fromSeq}，重订补发`);
        resubscribeOps(taskUri);
        return;
    }
    let sawTurnBoundary = false;
    // 插话被投递：main 落了带 steer 标记的 user 块（见 local-agent 的 steerBlockOps）→ 队列少
    // 一条，立刻重拉快照；否则横条一直挂着"待发送"，而模型其实已经看见了。
    // ##327：这条判定原先长在 send 的流循环里 —— apply 只剩本通道后判定随之内收
    //（留在 send 里就成了"一个已经不落地任何 op 的循环顺手刷队列"，职责错位）。
    let sawSteerDelivered = false;
    // 增量 op 落在**末段**（尾部窗口所在的那一段）：它接在 loadHistory 的窗口之后，
    // 与流式 op 同一落点（tailForWrite），故已有段的块对象引用不动（任务 293 分段语义）。
    const seg = tailForWrite(st);
    for (const op of ops) {
        seg.store.apply(op);
        if (op.op === "start" && op.kind === "turn") sawTurnBoundary = true;
        // stop 不带 kind：向块树查该 id 是不是轮次块（apply 后块仍在，仅 stopped 置位）
        else if (op.op === "stop" && seg.store.blocks.get(op.id)?.kind === "turn") sawTurnBoundary = true;
        else if (op.op === "start" && op.kind === "text" && op.meta?.["steer"]) sawSteerDelivered = true;
    }
    st.appliedSeq = frame.fromSeq + frame.ops.length - 1;
    scheduleRefresh(st);
    if (sawSteerDelivered) void refreshSteers(taskUri);
    // 轮次边界 → 立刻对一次真值（原 2s 轮询的职责，现在由事件驱动）。
    // 边界是稀有事件（一轮仅 start/stop 各一次），**不经节流**：短轮（<400ms）的 stop 边界
    // 若被节流吞掉，「别人在跑」会滞留到下一次活动（review3 R7）。
    if (sawTurnBoundary) void refreshActive(taskUri);
}

async function open(taskUri: string) {
    // 切走旧会话：取消它的订阅（回来时按水位补发追平 —— 见 ensureOpsSubscription）
    const prev = currentUri();
    if (prev && prev !== taskUri) unsubscribeOps(prev);
    setCurrentUri(taskUri);
    const st = stateFor(taskUri);
    syncStopTicker(); // 进入会话先对齐停止时钟（切回仍在收尾的任务需重新开表，review3 R6）
    void refreshActive(taskUri); // 进入会话立刻对一次真值
    // 队列与历史独立：loaded 与否都要拉（横条反映的是"当前待投递"，与历史加载进度无关）
    void refreshSteers(taskUri);
    // 用量账本同理独立：看板/明细要的是"这个会话花过多少"，与块树加载进度无关
    void refreshUsage(taskUri);
    if (st.loading) return st.loading;
    if (st.loaded) {
        // 已加载过（含切任务回来）：块树已在，只需确保增量订阅在（幂等）
        ensureOpsSubscription(taskUri);
        return;
    }
    // 并发去重（必需）：LocalChatPage 首挂时 onMount 与 uri 切换 effect 都会调 open，
    // 而 loaded 只在 await 之后置位 —— 没有这道闸门，两次 history 会被先后 fold 进同一个
    // store，表现为「每条消息内容整体重复一遍」。
    // 失败时清掉在途标记（不置 loaded），保留「下次进入自动重试」的既有语义。
    st.setError(null);
    st.loading = (async () => {
        // ① 水位 → ② history（覆盖 ≥ 水位）→ ③ 订阅（补发 ≤ 水位之后的）
        const wm = await fetchWatermark(taskUri);
        await loadHistory(st, taskUri);
        st.appliedSeq = wm.seq;
        st.epoch = wm.epoch;
        ensureOpsSubscription(taskUri);
    })().finally(() => {
        st.loading = undefined;
    });
    await st.loading;

    // 人物/模型清单由 personaStore 管（详情面板与试验场也要用），这里只确保它加载过
    void personaStore.load();
}

/**
 * 一条「可能开轮」的流的公共外壳：running / abort 的置位与收尾、错误分流、轮末真值对齐。
 *
 * 三条入口（发送 / 留言 / 立即发送）**都必须走它** —— 少走一处就会留下
 * 「界面显示生成中而服务端早就结束」或「横条挂着已投递的留言」这类分叉。
 *
 * ⚠️ 不复用自己那轮的 abort 句柄：调用方若已有在途流（自己发起的轮次），**别用这个函数**
 * （它会 setRunning 并覆盖 st.abort，把那轮的句柄抢走）。见 flushSteers 的自己的在途分支。
 */
async function runTurnStream(
    taskUri: string,
    start: (ctrl: AbortController) => Promise<AsyncIterable<unknown>>,
): Promise<boolean> {
    const st = stateFor(taskUri);
    if (st.running()) return false;
    st.setError(null);
    st.setRunning(true);
    setStopRequested(st, null); // 新一轮开始 → 清停止态（helper 同步对齐 ticker，review3 R6）
    const ctrl = new AbortController();
    st.abort = ctrl;
    // ##327：本流不再 apply，实时显示全交给 op 增量订阅 → 发之前确保订阅在（幂等：已订阅直接返回）。
    // 这层兜底必要：send 若跑在"没走 open"的路径上（订阅未建），少了它就是整轮输出"发出去却看不见"，
    // 要等轮末重放才补回来。
    ensureOpsSubscription(taskUri);
    // 轮末自检的基准：订阅让 appliedSeq 前进，才说明这一轮真经显示通道进了树（见 settleOpsAfterTurn）
    const baseSeq = st.appliedSeq;
    try {
        const stream = await start(ctrl);
        // ##327：**只消费，不 apply** —— 这批 op 与 opsWatch 订阅收到的是同一批（main 侧落盘后
        // `opsFeed.publish` 一次、再作为本流 yield 一次），两边都落地就是整段叠字（见本文件上方
        // 「唯一 apply 通道」）。本流剩下的职责只有一个：**"我这轮还活着 / 结束了"这个信号** ——
        // running 复位、轮末对真值、队列与用量刷新都在 finally，与流里的内容无关。
        // 相应地不再逐条 JSON.parse：那是为 apply 服务的解析，不再需要内容就不必付这份 CPU。
        for await (const op of stream) void op;
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
        // ##327 review1 R1：轮末自检显示通道（chat 流的 op 已不落地，订阅是唯一通道）。
        // 不能只靠上面那句 refreshActive：它的重建挂在"main 报下降沿"上，而这条**也**源于
        // 订阅事件 —— 订阅静默时两者一起失效，整轮输出就永远不出现。
        void settleOpsAfterTurn(taskUri, baseSeq);
    }
}

/**
 * 「只入队 / 只加急」路径的公共消费：**不接管** running / abort。
 *
 * 用在自己那轮已经在途的时候（生成中插嘴、一键加急）：那条轮的取消句柄属于它自己，
 * 提交留言的请求不许把它换掉（runTurnStream 会 setRunning + 覆盖 st.abort）。
 * 此路径服务端只会入队 / 加急，正常情况下**不产 op**；真产了（空闲竞态下开了轮）
 * 也由 opsWatch 那条唯一通道落地 —— 本流同样只当"请求还没结束"的信号，不 apply（##327）。
 */
async function consumeOwnTurnStream(
    taskUri: string,
    _st: TaskState,
    start: () => Promise<AsyncIterable<unknown>>,
): Promise<boolean> {
    try {
        const stream = await start();
        for await (const op of stream) void op;
        await refreshSteers(taskUri);
        return true;
    } catch (e) {
        console.error(`[localChat] 队列提交失败 ${taskUri}:`, e);
        return false;
    }
}

async function send(taskUri: string, text: string): Promise<boolean> {
    const st = stateFor(taskUri);
    const msg = text.trim();
    if (!msg || !taskUri || st.running()) return false;
    // 不传 model/reasoningEffort：模型与参数由 main 按**任务绑定的人物**解析（配置真源唯一，
    // 见 main/services/local-agent.ts 的 chat）。renderer 只决定"要谁干活"（persona 字段）。
    // 不给 mode = 开一轮（给出 mode 则先入队，见 submitSteer）。
    return runTurnStream(taskUri, (ctrl) =>
        diyService.diy.agent.local.chat(
            {
                taskUri,
                message: msg,
                // 键必须出现（契约里 optional 字段也是必填键）：显式 undefined = 不覆盖人物配置
                mode: undefined,
                model: undefined,
                reasoningEffort: undefined,
            },
            { signal: ctrl.signal },
        ),
    );
}

/**
 * 提交一条插话：走 `chat --mode`，投递时机由 mode 决定（next-step / next-turn，都是整批投）。
 *
 * 服务端行为有**两种**，这里必须都能接住（##303）：
 *   · 该任务已有活跃轮次 → 只入队（旧的唯一行为）；
 *   · 没有活跃轮次       → 入队后**立刻用队列开一轮**（留言 = 发一句话，空闲时本就该马上发出）——
 *     这时流里会有真的 op，界面要像普通发送那样实时显示、能停止。
 * 所以不能再"只把流拉完就丢"（那样空闲入队会变成界面看不见的暗发送）。
 *
 * 必须把流消费到结束：服务端先回 ACK 再执行入队，只 await 调用会在落盘前就 refresh，
 * 横条会短暂看不到这条（见 channel-server-binding 的 _startServerStream）。
 */
async function submitSteer(taskUri: string, mode: SteerMode, text: string): Promise<boolean> {
    const body = text.trim();
    if (!body || !taskUri) return false;
    const st = stateFor(taskUri);
    // 客户端类型要求每个键都在场：模型/推理只在开一轮时用，队列路径给 undefined
    const call = (ctrl?: AbortController) =>
        diyService.diy.agent.local.chat(
            { taskUri, message: body, mode, model: undefined, reasoningEffort: undefined },
            ctrl ? { signal: ctrl.signal } : undefined,
        );

    // 自己这轮在途 = **留言的主战场**（生成中插嘴）：只入队，不接管轮次的 running / abort。
    // ⚠️ 这条路径不能走 runTurnStream —— 它的 `st.running()` 守卫会把留言本身拦掉
    // （实测：点「留言」后毫无反应：输入框留着字、队列空、横条不出现）。
    if (st.running()) {
        const ok = await consumeOwnTurnStream(taskUri, st, () => call());
        if (!ok) notificationStore.addToast("error", "插话提交失败（未能落盘），内容未排队");
        return ok;
    }
    // 空闲：服务端可能**立刻用队列开一轮**（##303 的 c）→ 要像普通发送那样接管这一轮
    const ok = await runTurnStream(taskUri, (ctrl) => call(ctrl));
    if (!ok) {
        // 走到这里 = **入队就没成**（服务端"入队成功但开轮失败"的情况已在 main 侧吞掉，
        // 那种情况留言安好在队列里，不该报失败）→ 提示并保留输入框内容
        notificationStore.addToast("error", "插话提交失败（未能落盘），内容未排队");
    }
    return ok;
}

/**
 * 「立即发送」：把队列整批**现在就送出去**（##303 的 a 方案），不等轮末 / 下一步的时机。
 *
 * 服务端两个分支：有活跃轮次 → 全部加急为 next-step；空闲 → 立刻开一轮（队列作开场白）。
 */
async function flushSteers(taskUri: string): Promise<boolean> {
    const st = stateFor(taskUri);
    if (st.steers().length === 0) return false;
    // 自己这轮在途：**不能**走 runTurnStream（它会 setRunning 并抢走 st.abort 句柄，
    // 把我正在消费的那一轮的取消入口换掉）。此时服务端只会走"加急"分支（我就是那个活跃轮次），
    // 不产 op，故只需把流拉完 + 对齐快照。
    if (st.running()) {
        const ok = await consumeOwnTurnStream(taskUri, st, () =>
            diyService.diy.agent.local.steer.flush({ taskUri, model: undefined, reasoningEffort: undefined }),
        );
        if (!ok) notificationStore.addToast("error", "立即发送失败，留言仍在队列里");
        return ok;
    }
    return runTurnStream(taskUri, (ctrl) =>
        diyService.diy.agent.local.steer.flush(
            { taskUri, model: undefined, reasoningEffort: undefined },
            { signal: ctrl.signal },
        ),
    );
}

/**
 * 「修改」：把一条待投递留言**撤回编辑器** —— 从队列移除并返回它的内容（由调用方拼进输入框）。
 *
 * 失败返回 null 且队列原样保留：调用方**不得**在这种情况下改动输入框，
 * 否则同一句话会同时出现在输入框与横条上（用户再发一次就是重复投递）。
 */
async function takeSteer(taskUri: string, id: string): Promise<SteerItem | null> {
    const st = stateFor(taskUri);
    const item = st.steers().find((it) => it.id === id);
    if (!item) return null;
    const seq = nextSteerSeq(taskUri);
    try {
        const items = (await diyService.diy.agent.local.steer.cancel({ taskUri, id })) as SteerItem[];
        commitSteers(taskUri, seq, items);
        return item;
    } catch (e) {
        console.error(`[localChat] 撤回留言失败 ${taskUri}#${id}:`, e);
        notificationStore.addToast("error", "撤回失败，这条留言仍在队列里");
        return null;
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
    setNowMs(Date.now());
    setStopRequested(st, Date.now()); // 进入停止收尾 → 开表推进 now（helper 同步对齐，review3 R6）
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
    st.appliedSeq = 0; // 订阅游标归零（main 侧同一次 clear 也会 reset：epoch 换发 + 水位归零）
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
    st.scroll = null; // 会话清空，阅读位置一并归位
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
            // stale 的全量游标由 mergeWindow 统一丢弃（见其重置分支）：别粘住 ⇒ 下次重新 seek。
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

/** 记录某任务的阅读位置（切走会话时由组件保存「视口顶部块 + 块内偏移」，见 ChatAnchor） */
function setScroll(taskUri: string, v: ChatAnchor | null): void {
    stateFor(taskUri).scroll = v;
}

/** 读取某任务的阅读位置（null = 从未记录过；只读不创建 state） */
function getScroll(taskUri: string): ChatAnchor | null {
    return states.get(taskUri)?.scroll ?? null;
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
    return diyService.diy.agent.local.compact.preview({ taskUri, ...policyFlat(policy), summaryText });
}

/** 自动压缩检测（只读）：事实 / 触发理由 / 生效 TTL / 当前配置 */
async function autoCompactStatus(taskUri: string) {
    return diyService.diy.agent.local.autoCompactStatus({ taskUri });
}

/**
 * 写自动压缩配置（真源 = $DIY_HOME/auto-compact.yaml；patch = 部分字段，主进程浅合并）。
 * ⚠️ 级列表（`history.keep[]`）也走这里（`{ history: { keep } }`）—— 读侧在 `autoCompactStatus`
 * 的 `config.history`；UI 写前用 shared 的 `validateKeepStages` **本地校验**（同一判据，不打空 RPC）。
 * 命令行那三条（`compact plan get|set|check`）是给 CLI/脚本用的，renderer 不绕那一圈。
 */
async function autoCompactSetConfig(patch: Record<string, unknown>) {
    return diyService.diy.agent.local.autoCompactSetConfig({ patch });
}

/**
 * 重置装配管道为**出厂缺省**（##363）：走 `compact plan reset`（`via:"user"`，不受 agent 写闸约束）。
 * ⚠️ 与 `autoCompactSetConfig({ history: { keep: DEFAULT_KEEP } })` 的差别是**语义**：
 *   后者把缺省**写死**进配置（`source:"config"`，冻结在当时那版缺省）；reset 是**删键**
 *   （`source:"default"`，自动跟随将来缺省演进）。所以不能拿 patch 顶替。
 */
async function compactPlanReset(taskUri: string) {
    return diyService.diy.agent.local.compact.plan.reset({ taskUri });
}

/** 执行压缩（写边界账 + 落盘被裁原文 + 内存态重置）；成功后重建本地块树到新边界 */
async function compact(
    taskUri: string,
    policy: FlatCompactPolicy,
    summary?: { text: string; data: unknown; cost: number | null },
) {
    const rec = (await diyService.diy.agent.local.compact.run({
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
    const r = await diyService.diy.agent.local.compact.undo({ taskUri, ref });
    if (r.undone) await reload(taskUri);
    return r.undone;
}

/** 压缩事件账（历史页：不可变快照列表） */
async function compactEvents(taskUri: string) {
    return diyService.diy.agent.local.compact.events({ taskUri });
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
    /**
     * op 订阅健康度（响应式）：`down` = 实时显示通道断了 —— 会话区的**常驻条**读它（##354 ③）。
     * 单通道化后订阅是唯一通道，故这个位是"为什么一个字也不来"的唯一可见判据。
     */
    get opsState(): OpsState {
        return cur()?.opsState() ?? "idle";
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
    /** 立即发送（整批）；自己这轮在途时只加急，空闲时立刻开一轮 */
    flushSteers,
    cancelSteer,
    /** 撤回一条到编辑器（返回其内容；失败 null = 队列没动） */
    takeSteer,
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
    compactPlanReset,
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
