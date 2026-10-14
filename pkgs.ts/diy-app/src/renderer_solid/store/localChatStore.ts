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
// 插话队列项的类型在 core/drafts（与草稿同文件存储）；这里只要类型，故 type-only import
//（不会把 node:fs 依赖带进 renderer）
import type { SteerItem, SteerMode } from "../../main/core/drafts";
import { personaStore } from "./personaStore";
import { sessionView, type SessionView } from "../../shared/session-view";
import { StopTicker } from "../lib/stop-ticker";
// 用量账本类型：与 main 落盘、CLI 报表、看板共用同一份形状（shared/usage 是唯一口径处）
import type { StepUsageRecord } from "../../shared/usage";
import type { FlatCompactPolicy, HeadTailPolicy } from "../../shared/context/compaction";

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
    /** 上一次并入的**轮次 id 序列**（foldInto 的前缀守卫：只能往后追加，对不上就重建） */
    turnIds?: string[];
    /**
     * op 增量订阅的**已应用到第几行**（ops.jsonl 行号，1-based；0 = 尚无）。
     * 见 subscribeOps 头注：首载用 history（折叠流），增量用 opsWatch，两者按 seq 对齐。
     */
    appliedSeq: number;
    /** 已见会话代次（main 侧 clear 会换发 → 收到不符的帧说明历史被清空，须重建） */
    epoch: number;
    /** op 订阅的取消句柄（null = 未订阅）。切任务时取消，回来时按水位补发追平 */
    opsAbort: AbortController | null;
    /**
     * 逐步用量账本（`<key>.usage.jsonl` 的结构化镜像）。
     * 权威在盘上；这里是快照，打开会话时拉一次，轮次收尾（含别人的轮次）时再拉一次。
     * 对话流页脚**不依赖它**（页脚用 turn 块属性，实时就有）——它服务于明细与看板。
     */
    usage: () => StepUsageRecord[];
    setUsage: (v: StepUsageRecord[]) => void;
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
        const [steers, setSteers] = createSignal<SteerItem[]>([]);
        const [usage, setUsage] = createSignal<StepUsageRecord[]>([]);
        s = {
            store: new BlockStore(), loaded: false, trees, setTrees, running, setRunning,
            active, setActive, stopRequestedAt, setStopRequestedAt, abort: null,
            error, setError, steers, setSteers, usage, setUsage, steerSeq: 0, steerSettled: 0,
            scroll: 0, tab: "local", detailScroll: 0,
            appliedSeq: 0, epoch: -1, opsAbort: null,
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
    st.setTrees(toForest(st.store));
}

/**
 * 把一份（已折叠的）历史 op 流并入现有块树。**不重建 store** —— 这是治「轮末 GC 风暴」的关键。
 *
 * 旧实现每轮 reload 都 `new BlockStore()` 再全量 fold：新 store 里每个 BlockNode 都是新对象
 * → toForest 的身份缓存（TreeCache）全部失效 → Solid 的 `<For>` 把**每一轮**都销毁重建
 * （连同全量 Markdown re-parse）。而此刻真正变化的，通常只有刚跑完的那一轮。
 *
 * 折叠流是**幂等**的：`start` 重复被忽略、`patch` 值未变不写也不 touch、`stop` 幂等
 * （见 local-blocks 的 apply / compactOps）。所以整份再喂一遍安全且无副作用 ——
 * 没变的轮次引用不变，`<For>` 只更新真正变化的那轮。
 *
 * 前缀守卫：折叠流的**轮次序列只能往后追加**。对不上（被清空 / 换成别的会话 / 日志被
 * 外部改写）就退回重建 —— 宁可重来一次，也不把两段历史缝在一起。
 */
function foldInto(st: TaskState, ops: Op[]): void {
    const ids = ops.filter((o) => o.op === "start" && o.kind === "turn").map((o) => o.id);
    const prev = st.turnIds ?? [];
    const isAppend = prev.length <= ids.length && prev.every((id, i) => id === ids[i]);
    if (!isAppend) st.store = new BlockStore();
    // 重复 apply 会给"重复 start"记 issue；渲染端不消费 issues，但别让它无界堆积
    if (st.store.issues.length > 0) st.store.issues.length = 0;
    for (const op of ops) st.store.apply(op);
    st.turnIds = ids;
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
        const ops = (await diyService.diy.agent.local.history({ taskUri })) as Op[];
        // 并进现有块树（幂等），不重建：只有真正变化的轮次会换引用 → <For> 只重建它
        foldInto(st, ops);
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
        const ops = (await diyService.diy.agent.local.history({ taskUri })) as Op[];
        foldInto(st, ops);
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
// 时序（必须按此序，否则会漏掉「首载期间」写入的 op）：
//   ① 取水位 wm = {epoch, seq}（ops.jsonl 当前行号）；
//   ② 拉 history（**折叠流**，大会话快路径）fold 成块树 —— 它覆盖范围 **≥ wm.seq**
//      （main 侧同步读文件，且①在②之前发起）；
//   ③ `appliedSeq = wm.seq`，建 opsWatch(since=wm.seq) → main 先补发 `(wm.seq, 现在]`，再接实时。
// ②③ 之间与补发段的重复由 seq 去重吸收；即便漏掉去重，`BlockStore.apply` 本身幂等
//（重复 start / patch / stop 都是 no-op），所以这条路径「重不重」都不出错，只是别重复算。

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
    const since = st.appliedSeq;
    const epoch = st.epoch;
    void (async () => {
        try {
            const stream = await diyService.diy.agent.local.opsWatch(
                { taskUri, since, epoch },
                { signal: ctrl.signal },
            );
            for await (const frame of stream) {
                // 已被重订（补洞）或退订：本流作废，别再处理它可能残留的帧
                //（否则会拿旧 since 的帧去撞新的 appliedSeq，误报缺口）
                if (st.opsAbort !== ctrl) break;
                applyOpsFrame(taskUri, frame as OpsFrame);
            }
        } catch (e) {
            // 正常退订（abort）与页面销毁（client disposed）都不是故障，别当异常刷日志
            const msg = e instanceof Error ? e.message : String(e);
            if (!ctrl.signal.aborted && !/disposed|abort/i.test(msg)) {
                console.warn(`[localChat] op 订阅中断 ${taskUri}，将退避重连:`, e);
                // ##307 review2 R3：非主动退订的中断若就此作罢，UI 会**静默冻结** ——
                // reload 的触发源全是订阅事件，旧实现靠 2s 轮询兜底而轮询已删。
                // 退避重订：从 appliedSeq 补发，断线期间的 op 不丢。
                scheduleOpsReconnect(taskUri);
            }
        } finally {
            if (st.opsAbort === ctrl) st.opsAbort = null;
        }
    })();
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
        st.store = new BlockStore();
        st.turnIds = undefined;
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
        st.store = new BlockStore();
        st.turnIds = undefined;
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
    for (const op of ops) {
        st.store.apply(op);
        if (op.op === "start" && op.kind === "turn") sawTurnBoundary = true;
        // stop 不带 kind：向块树查该 id 是不是轮次块（apply 后块仍在，仅 stopped 置位）
        else if (op.op === "stop" && st.store.blocks.get(op.id)?.kind === "turn") sawTurnBoundary = true;
    }
    st.appliedSeq = frame.fromSeq + frame.ops.length - 1;
    scheduleRefresh(st);
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
    setStopRequested(st, null); // 新一轮开始 → 清停止态（helper 同步对齐 ticker，review3 R6）
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
            st.store.apply(op);
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
    st.store = new BlockStore();
    st.turnIds = undefined; // 前缀守卫一并归零：新会话从空开始（下次并入必走重建那条）
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
    setScroll,
    getScroll,
    setTab,
    getTab,
    setDetailScroll,
    getDetailScroll,
};
