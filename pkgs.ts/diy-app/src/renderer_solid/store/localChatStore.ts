/**
 * localChatStore — 本地自定义 agent 会话状态（ai-sdk 块协议，独立于 ACP chatStore）
 *
 * Op 流（RPC serverStream / history 日志）→ BlockStore.fold → 块树信号。
 * wire = 存储 = 渲染输入：history 重放与实时流走同一条 fold 路径。
 *
 * 状态按 taskUri 隔离（Map）：切任务不 reset 在途会话、不串 running/cancel。
 * main 侧 LocalAgentManager 本来就是按 task 分会话，这里对齐它。
 *
 * 模型与人物**不在这里**：模型属于人物（配置实体），本 store 只负责"某个任务的会话流"，
 * 谁干活由任务 frontmatter 的 persona 决定（见 store/personaStore.ts 与 shared/persona.ts）。
 */

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "./notificationStore";
import { BlockStore, toTree, type BlockNode, type Op } from "../../main/services/local-blocks";
// 插话队列项的类型在 core/drafts（与草稿同文件存储）；这里只要类型，故 type-only import
//（不会把 node:fs 依赖带进 renderer）
import type { SteerItem, SteerMode } from "../../main/core/drafts";
import { personaStore } from "./personaStore";

interface TaskState {
    store: BlockStore;
    loaded: boolean;
    trees: () => BlockNode[];
    setTrees: (v: BlockNode[]) => void;
    running: () => boolean;
    setRunning: (v: boolean) => void;
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
}

const states = new Map<string, TaskState>();
const [currentUri, setCurrentUri] = createSignal<string | null>(null);

function stateFor(taskUri: string): TaskState {
    let s = states.get(taskUri);
    if (!s) {
        const [trees, setTrees] = createSignal<BlockNode[]>([]);
        const [running, setRunning] = createSignal(false);
        const [error, setError] = createSignal<string | null>(null);
        const [steers, setSteers] = createSignal<SteerItem[]>([]);
        s = { store: new BlockStore(), loaded: false, trees, setTrees, running, setRunning, error, setError, steers, setSteers, steerSeq: 0, steerSettled: 0, scroll: 0, tab: "local", detailScroll: 0 };
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
        for (const op of ops) st.store.apply(op);
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
    // 队列与历史独立：loaded 与否都要拉（横条反映的是"当前待投递"，与历史加载进度无关）
    void refreshSteers(taskUri);
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

/** 发送一轮：实时 fold Op 流（RPC JSON 行），状态只写本 task */
async function send(taskUri: string, text: string): Promise<boolean> {
    const st = stateFor(taskUri);
    const msg = text.trim();
    if (!msg || !taskUri || st.running()) return false;
    st.setError(null);
    st.setRunning(true);
    try {
        // 不传 model/reasoningEffort：模型与参数由 main 按**任务绑定的人物**解析（配置真源唯一，
        // 见 main/services/local-agent.ts 的 chat）。renderer 只决定"要谁干活"（persona 字段）。
        const stream = await diyService.diy.agent.local.chat({
            taskUri,
            message: msg,
            // 键必须出现（契约里 optional 字段也是必填键）：显式 undefined = 不覆盖人物配置；
            // 这里不给 mode = 开一轮（给出 mode 则只入队，见 submitSteer）
            mode: undefined,
            model: undefined,
            reasoningEffort: undefined,
        });
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
        st.setError(e instanceof Error ? e.message : String(e));
        return false;
    } finally {
        // 无论正常结束/报错/中断：丢弃在途批并同步落最终快照。
        // 放在 finally 而非 try 尾部，是为保证取消与异常路径也不会丢掉最后一批 op
        // （否则 stopped/error 等终态字段要等下一次 rAF 才可见）。
        flushRefresh(st);
        st.setRunning(false);
        // 轮次结束（含正常收尾/取消/报错）后对齐队列：本轮末尾可能投递了 turn 模式的插话，
        // 不刷新的话横条会一直挂着"待发送"，而模型其实已经看见了
        void refreshSteers(taskUri);
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

/** 中断本 task 的生成（main 侧 AbortController → ai-sdk 停流）。main 语义幂等：无在途返 false 不抛错 */
async function cancel(taskUri: string) {
    try {
        await diyService.diy.agent.local.cancel({ taskUri });
    } catch (e) {
        // 能报错就只剩传输层故障：「停止」没生效必须让用户知道
        console.error(`[localChat] cancel RPC 失败 ${taskUri}:`, e);
        notificationStore.addToast("error", "停止请求发送失败，生成可能仍在继续");
    }
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
    st.setSteers([]); // 会话已清，排队中的插话也被 main 一并清掉（见 local-agent 的 clear()）
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


// 输入框草稿已移出本 store：草稿是非缓存数据（丢了=用户白打），权威在任务目录
// .diy/drafts.yaml，由 store/draftStore.ts 负责（经 RPC 落盘、随任务删除、跨模式可见）。
// 本 store 只管会话（op 流，可重放重建）。
export const localChatStore = {
    get trees() {
        return cur()?.trees() ?? [];
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
    open,
    send,
    cancel,
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
    setScroll,
    getScroll,
    setTab,
    getTab,
    setDetailScroll,
    getDetailScroll,
};
