/**
 * localChatStore — 本地自定义 agent 会话状态（ai-sdk 块协议，独立于 ACP chatStore）
 *
 * Op 流（RPC serverStream / history 日志）→ BlockStore.fold → 块树信号。
 * wire = 存储 = 渲染输入：history 重放与实时流走同一条 fold 路径。
 *
 * 状态按 taskUri 隔离（Map）：切任务不 reset 在途会话、不串 running/cancel。
 * main 侧 LocalAgentManager 本来就是按 task 分会话，这里对齐它。
 */

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "./notificationStore";
import { BlockStore, toTree, type BlockNode, type Op } from "../../main/services/local-blocks";

interface TaskState {
    store: BlockStore;
    loaded: boolean;
    trees: () => BlockNode[];
    setTrees: (v: BlockNode[]) => void;
    running: () => boolean;
    setRunning: (v: boolean) => void;
    error: () => string | null;
    setError: (v: string | null) => void;
    /** 阅读位置：会话块树滚动区 scrollTop（内存态，随会话保留；不落盘——重启后从最新看起） */
    scroll: number;
    /** 详情面板当前 tab（local=agent 对话 / info=任务详情），per-task 记忆 */
    tab: "local" | "info";
    /** 详情 tab 的滚动位置（info 滚动容器 scrollTop） */
    detailScroll: number;
}

const states = new Map<string, TaskState>();
const [currentUri, setCurrentUri] = createSignal<string | null>(null);

function stateFor(taskUri: string): TaskState {
    let s = states.get(taskUri);
    if (!s) {
        const [trees, setTrees] = createSignal<BlockNode[]>([]);
        const [running, setRunning] = createSignal(false);
        const [error, setError] = createSignal<string | null>(null);
        s = { store: new BlockStore(), loaded: false, trees, setTrees, running, setRunning, error, setError, scroll: 0, tab: "local", detailScroll: 0 };
        states.set(taskUri, s);
    }
    return s;
}

/** 当前选中任务的状态（渲染层只读这个；切换任务自动切信号源） */
function cur(): TaskState | null {
    const u = currentUri();
    return u ? (states.get(u) ?? null) : null;
}

/** 块树快照刷新（op 粒度重建，demo 规模下开销可忽略） */
function refresh(st: TaskState) {
    st.setTrees(st.store.roots().map((r) => toTree(st.store, r.id)));
}

const [models, setModels] = createSignal<Array<{ id: string; name: string }>>([]);
const [activeModel, setActiveModel] = createSignal<string>("");

/** 切换/进入会话：首次加载持久化 Op 日志；已加载过的直接复用（含在途流式） */
async function open(taskUri: string) {
    setCurrentUri(taskUri);
    const st = stateFor(taskUri);
    if (st.loaded) return;
    st.setError(null);
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
    if (models().length === 0) {
        try {
            const ms = await diyService.diy.agent.local.models({});
            setModels(ms);
            if (!activeModel() && ms.length) setActiveModel(ms[0]!.id);
        } catch (e) {
            // 可观测降级：模型列表非关键路径，不阻塞对话；models() 仍空 → 下次 open 重试
            console.warn("[localChat] 模型列表加载失败（下次进入重试）:", e);
        }
    }
}

/** 发送一轮：实时 fold Op 流（RPC JSON 行），状态只写本 task */
async function send(taskUri: string, text: string): Promise<boolean> {
    const st = stateFor(taskUri);
    const msg = text.trim();
    if (!msg || !taskUri || st.running()) return false;
    st.setError(null);
    st.setRunning(true);
    try {
        const stream = await diyService.diy.agent.local.chat({
            taskUri,
            message: msg,
            model: activeModel() || undefined,
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
            refresh(st);
        }
        return true;
    } catch (e) {
        st.setError(e instanceof Error ? e.message : String(e));
        return false;
    } finally {
        st.setRunning(false);
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
    get models() {
        return models();
    },
    get activeModel() {
        return activeModel();
    },
    setActiveModel,
    open,
    send,
    cancel,
    clear,
    setScroll,
    getScroll,
    setTab,
    getTab,
    setDetailScroll,
    getDetailScroll,
};
