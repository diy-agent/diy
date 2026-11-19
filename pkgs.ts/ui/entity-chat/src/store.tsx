// store.tsx —— React 适配层：room / 选择（本包）+ 会话状态（chat-core 的 ConversationStore）。
//
// 词表：Room = 容器（项目/任务/股票…），Bot = 身份，BotSession = bot 在某个 room 里的对话（后端概念）。

import {
    ConversationStore,
    type AskAnswer,
    type Bot,
    type CompactOutcome,
    type Room,
    type SessionInfo,
} from '@diy-agent/chat-core';
import { HttpChatClient } from '@diy-agent/chat-transport-http';
import * as React from 'react';

import {
    addressOf,
    DEFAULT_PAGE,
    formatAddress,
    isCanonicalPath,
    knownPage,
    parseAddress,
    pickAddress,
    roomAddressOf,
    sameAddress,
} from './address';
import type { NavAddress } from './address';
import { drafts } from './drafts';
import type { TaskStatus } from './model';

const DEFAULT_MODEL = 'chen56@opencode-go/deepseek-v4.1-flash';

// ─── 会话（chat-core）─────────────────────────────────────────────

// 传输层唯一注入点：换 diy-rpc 时只改这一行
const client = new HttpChatClient({ base: '/api' });
const conversations = new Map<string, ConversationStore>();

/** 回答一次挂起的提问（整批一次提交）。失败会抛，由界面显示原因（含服务端说的差哪几题）。 */
export async function answerAsk(roomId: string, askId: string, answer: AskAnswer): Promise<void> {
    if (client.answerAsk === undefined) throw new Error('当前传输不支持回答提问');
    await client.answerAsk(roomId, askId, answer);
}

/**
 * 撤回一问：卡片失效、待回答计数减一，**不触发任何运行**。失败会抛，由界面显示原因。
 *
 * 跟 `conversationOf(roomId).cancel()` 是两件事：那条停的是「正在生成」，而 ask 不阻塞，
 * 点它时那一轮早就跑完了 —— 拿它当「不要这个提问」用，只会什么都不发生。
 */
export async function cancelAsk(roomId: string, askId: string): Promise<void> {
    if (client.cancelAsk === undefined) throw new Error('当前传输不支持撤回提问');
    await client.cancelAsk(roomId, askId);
}

export function conversationOf(roomId: string): ConversationStore {
    let store = conversations.get(roomId);
    if (store === undefined) {
        store = new ConversationStore(client, roomId);
        conversations.set(roomId, store);
        store.reload();
    } else {
        // 切走时释放过常驻流，回来要重新挂上
        store.attach();
    }
    return store;
}

// ─── room / 选择（这一层只做导航，属于 UI 壳）──────────────────────

interface ShellState {
    rooms: Room[];
    bots: Record<string, Bot>;
    /**
     * 「在看哪儿」的真相 —— 一个能写进地址栏的位置（`/room/task/t-001`）。
     *
     * `selectedId` 是它在 `room` 页上的**投影**，留着是因为侧栏/正文一路都在用它；
     * 但真相必须是 address：将来的 `task-run` 页同样「在看某个东西」，那时候没有 selectedId 可用。
     */
    address: NavAddress;
    selectedId: string;
    defaultModelKey: string;
    loaded: boolean;
    /** 各房间的上下文概况（每个 bot 的会话 + 最近压缩事件） */
    sessions: Record<string, SessionInfo[]>;
    /**
     * 容器 id → 最后一条消息的时刻（毫秒）。服务端 `/api/rooms` 的投影字段 `lastActivityAt`。
     *
     * 为什么不往 `Room.data` 里塞：它不是房间的事实，而是「这个容器里最后一条 item 什么时候
     * 来的」—— 跟 hasDraft 同性质，进领域类型就会有人当它能写。没聊过的容器不在这里。
     */
    lastActivity: Record<string, number>;
    error?: string;
}

let state: ShellState = {
    rooms: [],
    bots: {},
    // id 为空 = 「还没定」，首屏由 resolveAddress 从地址栏或第一个房间补上
    address: addressOf(DEFAULT_PAGE, ''),
    selectedId: '',
    defaultModelKey: loadDefaultModel(),
    loaded: false,
    sessions: {},
    lastActivity: {},
};
const listeners = new Set<() => void>();

function emit(next: ShellState): void {
    state = next;
    for (const listener of listeners) listener();
}

export function useShell(): ShellState {
    return React.useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => state,
        () => state,
    );
}

export const useStore = useShell;

/** 当前快照的只读视图 —— 给测试与调试用（界面里请用 `useShell` 订阅，别读这个） */
export function shellSnapshot(): ShellState {
    return state;
}

export function roomOf(id: string): Room | undefined {
    return state.rooms.find((room) => room.id === id);
}

/**
 * 这一项是不是「正在看的那个容器」—— 比的是**地址**，不是 selectedId。
 *
 * 只比 id 早晚要错：将来 `task-run` 页同样在看 `task:t-001`，那时 selectedId 是空字符串，
 * 侧栏这一行的高亮就会消失。地址是位置的真相，selectedId 只是它在 room 页上的投影。
 */
export function isCurrentRoom(address: NavAddress, room: { id: string }): boolean {
    return sameAddress(address, roomAddressOf(room));
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return (await res.json()) as T;
}

// ─── 地址栏同步（只在这里碰 window）───────────────────────────────
//
// 真相在 `state.address`，地址栏是它的投影。两个方向：
//   内存 → 地址栏：`writeAddress`（navigate / refresh 时）
//   地址栏 → 内存：`popstate` 监听（用户按前进后退）

/**
 * 把地址写进地址栏。
 *
 * `replace` 用严格判定（写法不对就改写）：首屏从 `/` 落到第一个房间、老地址
 * `/room/task:t-001` 收编成 `/room/task/t-001`、目标房间已删 —— 这些都是「地址栏现在是
 * 谎话」，必须纠正，而 replaceState 不往历史里堆东西，多写一次没有代价。
 *
 * 用户主动换位置（`replace` 缺省）时只比**位置**：浏览器会把 pathname 规范化（中文转
 * `%XX`），字符串直比会把同一个位置误判成变了，多堆一条历史。
 */
function writeAddress(target: NavAddress, replace: boolean): void {
    if (typeof window === 'undefined') return;
    if (replace) {
        if (isCanonicalPath(window.location.pathname, target)) return;
        window.history.replaceState(null, '', formatAddress(target));
        return;
    }
    if (sameAddress(parseAddress(window.location.pathname), target)) return;
    window.history.pushState(null, '', formatAddress(target));
}

/**
 * 刷新后重新确定「在看哪儿」，顺序是**地址优先**：
 *
 *   1. 内存里已有合法位置 → 保持（改名 / 改状态触发的 refresh 不该动位置）；
 *   2. 地址栏里有 → 用它（首屏、别人贴进来的链接）；
 *   3. 都没有（或那个房间已经不存在）→ 第一个房间。
 *
 * 三步的优先级在 address.ts 的 `pickAddress` 里 —— 它依赖 window 之外的只是这份 rooms，
 * 所以纯函数才测得动。这里的 `known` 就是「位置还有效吗」：页类型已注册 + 房间还在。
 */
function isKnown(address: NavAddress, rooms: Room[]): boolean {
    if (!knownPage(address.page)) return false;
    return address.page !== DEFAULT_PAGE || rooms.some((room) => room.id === address.id);
}

/** 一个房间都没有时的空地址（首屏还在加载，或后端一个房间都没建） */
function fallbackAddress(rooms: Room[]): NavAddress {
    const first = rooms[0];
    return first === undefined ? addressOf(DEFAULT_PAGE, '') : roomAddressOf(first);
}

function resolveAddress(rooms: Room[]): NavAddress {
    return pickAddress({
        current: state.address,
        fromUrl: typeof window === 'undefined' ? undefined : parseAddress(window.location.pathname),
        known: (candidate) => isKnown(candidate, rooms),
        fallback: fallbackAddress(rooms),
    });
}

let addressHooksInstalled = false;

/**
 * 浏览器前进 / 后退 → 跟着换位置。
 *
 * **只**监听 `popstate`：`pushState` / `replaceState` 自己不发事件，而这两处只有 navigate 在调，
 * 状态本来就是对的。真去监听 hashchange 或轮询 pathname，会让「自己发起的变更」再触发一次导航。
 */
function installAddressHooks(): void {
    if (addressHooksInstalled || typeof window === 'undefined') return;
    addressHooksInstalled = true;
    window.addEventListener('popstate', () => {
        const target = parseAddress(window.location.pathname);
        // 退到一个认不得的地址（初始的 `/`、手改的 `/foo/bar`）：落回第一个房间，
        // 不要把界面清空
        if (target === undefined || !isKnown(target, state.rooms)) {
            const fallback = fallbackAddress(state.rooms);
            if (fallback.id !== '') actions.navigate(fallback, { replace: true });
            return;
        }
        // 这次是浏览器已经在改地址了，我们只对齐内存 —— 不能再 push 一条
        actions.navigate(target, { replace: true });
    });
}

// ─── 侧栏的「最后活动」跟着消息走 ────────────────────────────
//
// `refresh()` 里那份 `/rooms` 投影是 lastActivity 唯一的**服务端**来源，但当前房间收到消息
// 走的是 ConversationStore 的常驻 SSE，壳完全听不到。后果：正在聊的任务，侧栏行尾停在
// 几小时前（发一堆消息也不出现「刚刚」）；新建任务发完第一条，行尾还是「—」。
// 这里订阅当前房间的会话流，把最新的 item.at 抬上去；服务端投影追上后两边一致。

let activityUnsub: (() => void) | undefined;
let activityRoomId = '';

/** 只跟当前房间：切走就退订，别让看过的每个房间各留一个订阅 */
function watchActivity(roomId: string): void {
    if (roomId === activityRoomId) return;
    activityUnsub?.();
    activityUnsub = undefined;
    activityRoomId = roomId;
    if (roomId === '') return;
    const store = conversationOf(roomId);
    activityUnsub = store.subscribe(() => {
        // 取最大而不是最后一条：跨 bot 的消息按 order 插入，数组尾巴不是最新的那个时刻
        let at = 0;
        for (const item of store.get().items) if (item.at > at) at = item.at;
        if (at === 0 || at <= (state.lastActivity[roomId] ?? 0)) return;
        emit({ ...state, lastActivity: { ...state.lastActivity, [roomId]: at } });
    });
}

async function refresh(opts: { keepError?: boolean } = {}): Promise<void> {
    const [rooms, bots] = await Promise.all([
        jsonFetch<Array<Room & { hasDraft?: boolean; lastActivityAt?: number }>>('/rooms'),
        jsonFetch<Bot[]>('/bots'),
    ]);
    // 侧栏 ✎ 的初始值：不用打开过房间；本端改过的 owner 由 drafts 自己说了算
    drafts.seed(rooms);
    // 「最后活动」跟着同一次列表请求回来，不逐房间查（那会是 N+1）
    const lastActivity: Record<string, number> = {};
    for (const room of rooms) {
        if (typeof room.lastActivityAt === 'number') lastActivity[room.id] = room.lastActivityAt;
        // 本地刚从会话流抬起来的时刻比服务端投影新（消息刚到、`/rooms` 还没算）—— 别盖回去
        const local = state.lastActivity[room.id];
        if (local !== undefined && local > (lastActivity[room.id] ?? 0)) lastActivity[room.id] = local;
    }
    const address = resolveAddress(rooms);
    emit({
        ...state,
        rooms,
        lastActivity,
        bots: Object.fromEntries(bots.map((bot) => [bot.id, bot])),
        loaded: true,
        address,
        selectedId: address.page === DEFAULT_PAGE ? address.id : '',
        // 轮询成功不该抹掉用户还没看到的错误（改名失败这类和「服务端在不在」无关）
        error: opts.keepError === true ? state.error : undefined,
    });
    // 地址栏对齐内存里的真相：首屏从 `/` 落到第一个房间、旧链接里的房间已被删 ——
    // 这两种都该把地址栏改写成真正在看的位置（replace，不往历史里堆一条）
    writeAddress(address, true);
}

// ─── 首屏连接：失败就一直退避重试 ────────────────────────────────────
//
// 之前只试一次：dev 脚本先起 UI、后起 API（tsx 冷启动要几秒），页面先加载就
// 永久停在"连接 diy2 后端…"，后端起来了也不会自己接上，只能手动刷新。
//
// 重试策略：0.5s 起步翻倍、5s 封顶；另外窗口重新可见 / 网络恢复时立刻补一次
// （最常见的就是切回标签页时后端已经重启完了）。
let bootTimer: ReturnType<typeof setTimeout> | undefined;
let bootAttempt = 0;

function scheduleBootstrapRetry(delayMs?: number): void {
    if (bootTimer !== undefined) return;
    const delay = delayMs ?? Math.min(5_000, 500 * 2 ** Math.min(bootAttempt, 4));
    bootAttempt += 1;
    bootTimer = setTimeout(() => {
        bootTimer = undefined;
        void runBootstrap();
    }, delay);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function runBootstrap(): Promise<void> {
    try {
        await refresh();
        bootAttempt = 0;
        // 连上之后就开始盯着别的房间（只盖当前房间的是 watchActivity 那条 SSE）
        startRoomsPoll();
    } catch (error) {
        // loaded 保持 false：界面继续显示"连接中"并带上失败原因，而不是变成半死的空壳
        emit({ ...state, error: messageOf(error) });
        scheduleBootstrapRetry();
    }
}

/** 已经连上之后再失败（后端重启）：留着现有界面，同样排队重试 */
function bootstrapIfNeeded(): void {
    if (bootTimer !== undefined) return;
    if (state.loaded) return;
    void runBootstrap();
}

// ─── 别的房间有新消息：轻轮询 ───────────────────────────
//
// `watchActivity` 只盖住**当前**房间（那是 SSE）。别的房间来了消息，壳收不到任何东西：
// 侧栏停在几小时前，非得手动刷新才更新。`/api/rooms` 一次聚合（服务端算 lastActivityAt），
// 50 个房间也是毫秒级 —— 30s 拉一遍的代价可以忽略。
//
// 两个前提：已连上（没连上时 runBootstrap 自己在重试，别叠两层轮询）、页面可见
// （后台标签页每 30s 打一次接口纯属浪费，而且没人看）。

const ROOMS_POLL_MS = 30_000;
let pollTimer: ReturnType<typeof setInterval> | undefined;

/** 静默刷新：失败不写 error（后端重启时每 30s 弹一条错误太吵；连不上的判定归 runBootstrap） */
function refreshQuietly(): void {
    void refresh({ keepError: true }).catch(() => undefined);
}

function startRoomsPoll(): void {
    if (pollTimer !== undefined || typeof window === 'undefined') return;
    pollTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        refreshQuietly();
    }, ROOMS_POLL_MS);
}

let hooksInstalled = false;

/** 事件兜底：切回标签页 / 网络恢复时补一次（后端重启最常见的就是这两种时机） */
function installBootstrapHooks(): void {
    if (hooksInstalled || typeof window === 'undefined') return;
    hooksInstalled = true;
    window.addEventListener('online', () => {
        // 断网期间最可能来了消息：先把列表补一次，再谈要不要重连
        if (state.loaded) refreshQuietly();
        bootstrapIfNeeded();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (state.loaded) refreshQuietly();
        bootstrapIfNeeded();
    });
}

export const actions = {
    bootstrap(): void {
        // 首屏：连不上后端就一直退避重试，直到成功（见 runBootstrap）
        if (bootTimer !== undefined) return;
        void runBootstrap();
        installBootstrapHooks();
        installAddressHooks();
    },

    /**
     * 导航 —— **唯一**的页面切换入口。侧栏点击、代码跳转、浏览器前进后退全汇到这里。
     *
     * `replace` 用于「不是用户主动换位置」的场合（首屏对齐、浏览器回退、目标已不存在），
     * 否则 `pushState` 会把历史堆满 —— 用户按一次返回还在同一个房间。
     */
    navigate(target: NavAddress, opts: { replace?: boolean } = {}): void {
        if (sameAddress(state.address, target)) return;
        // 目标不存在（别人贴来的旧链接 / 刚被删的房间 / 未注册的页）→ 落到第一个房间。
        // 首屏 rooms 还没加载时不判 —— 那时「不存在」只是因为还没拉回来。
        const knownEmpty = state.rooms.length === 0;
        const next =
            !knownPage(target.page) || (target.page === DEFAULT_PAGE && !knownEmpty && !isKnown(target, state.rooms))
                ? fallbackAddress(state.rooms)
                : target;
        if (next.id === '' || sameAddress(state.address, next)) return;
        writeAddress(next, opts.replace === true);
        const roomId = next.page === DEFAULT_PAGE ? next.id : '';
        // 切走前把输入框里还没写出去的字立即落盘（防抖计时器可能还差几百毫秒）
        void drafts.flush(state.selectedId === '' ? undefined : state.selectedId);
        // 只让当前房间订着话题，其余退订。连接是共用的（一条就够），这里省的是**事件**：
        // 看过的房间不该还在往这条连接上推东西
        for (const [id, store] of conversations) {
            if (id !== roomId) store.dispose();
        }
        emit({ ...state, address: next, selectedId: roomId });
        watchActivity(roomId);
    },

    /** 兼容旧名：`select(roomId)` == 导航到那个 room 页。调用点有二十多处，先留着 */
    select(id: string): void {
        actions.navigate(roomAddressOf({ id }));
    },

    /** 改名。空名字 = 不提交（名字是侧栏唯一能认出容器的东西）；失败把原因亮出来，别静默 */
    renameRoom(id: string, name: string): Promise<void> {
        const next = name.trim();
        if (next === '') return Promise.resolve();
        return jsonFetch(`/rooms/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: next }),
        })
            .then(() => refresh())
            .catch((error: unknown) => {
                emit({ ...state, error: `改名失败：${messageOf(error)}` });
            });
    },

    /**
     * 任务状态（room.data.status）：只改这一个键，别的 data 不动。
     *
     * 关闭时顺手盖 `closedAt`：「已关闭」表按它倒序。重开时传 `null` ——
     * `RoomActor.update` 把 null 当删除，老数据里那个时刻也不该留成脏值。
     * 时刻只在这里盖：CLI / 手改 data 直接改 status 不会带时间（表里显示「—」），
     * 这是有意的 —— 枚举归 UI，不把任务语义塞进通用的 actor。
     */
    setRoomStatus(id: string, status: TaskStatus): Promise<void> {
        return jsonFetch(`/rooms/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ data: { status, closedAt: status === 'closed' ? Date.now() : null } }),
        })
            .then(() => refresh())
            .catch((error: unknown) => {
                emit({ ...state, error: `改状态失败：${messageOf(error)}` });
            });
    },

    /**
     * 删容器（服务端是硬删，项目会连带它的任务）。
     * 删完要把选中项和会话池一起收拾：留着指向已删房间的 selectedId，界面会停在
     * 「左侧选择一个容器」还找不到原因（那个 id 已经不存在了）。
     */
    deleteRoom(id: string): Promise<void> {
        return jsonFetch<{ deleted?: string[] }>(`/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' })
            .then((result) => {
                const gone = new Set(result.deleted ?? [id]);
                for (const roomId of gone) {
                    conversations.get(roomId)?.dispose();
                    conversations.delete(roomId);
                }
                // 看的那间被删了 → 退掉它的活动订阅（store 已 dispose，别留着 listener）
                if (gone.has(activityRoomId)) watchActivity('');
                const selectedId = gone.has(state.selectedId) ? '' : state.selectedId;
                // 看的那间被删了 → 地址也清空，交给紧随其后的 refresh 落回第一个
                const address = gone.has(state.address.id) ? addressOf(DEFAULT_PAGE, '') : state.address;
                const sessions = { ...state.sessions };
                for (const roomId of gone) delete sessions[roomId];
                emit({ ...state, address, selectedId, sessions });
                return refresh();
            })
            .catch((error: unknown) => {
                emit({ ...state, error: `删除失败：${messageOf(error)}` });
            });
    },

    setRoomModel(id: string, modelKey: string): void {
        void jsonFetch(`/rooms/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ modelKey }) })
            .then(() => refresh())
            .catch(() => undefined);
    },

    setDefaultModel(modelKey: string): void {
        try {
            localStorage.setItem('entity-chat:default-model', modelKey);
        } catch {
            /* 忽略 */
        }
        emit({ ...state, defaultModelKey: modelKey });
    },

    createProject(input: { name: string; dir: string }): void {
        void jsonFetch<Room>('/rooms', {
            method: 'POST',
            // 带上默认模型：SettingsDialog 里"新建的都继承它"才成立
            body: JSON.stringify({
                type: 'project',
                name: input.name,
                modelKey: state.defaultModelKey,
                data: { dir: input.dir },
            }),
        })
            .then((room) => refresh().then(() => actions.navigate(roomAddressOf(room))))
            .catch(() => undefined);
    },

    /**
     * 新建任务：名字由调用方给（对话框），缺省「新任务 N」由 UI 算。
     *
     * 失败会 rethrow（同时也写 state.error）：对话框要靠这个信号决定「描述草稿清不清」——
     * 建任务失败还清掉草稿，等于把用户写的一大段话丢了一次。
     */
    createTask(projectId: string, name: string, extra: Record<string, unknown> = {}): Promise<void> {
        const project = roomOf(projectId);
        const trimmed = name.trim();
        if (trimmed === '') return Promise.resolve();
        return jsonFetch<Room>('/rooms', {
            method: 'POST',
            body: JSON.stringify({
                type: 'task',
                name: trimmed,
                modelKey: state.defaultModelKey,
                data: { projectId, dir: project?.data['dir'], ...extra },
            }),
        })
            .then((room) => refresh().then(() => actions.navigate(roomAddressOf(room))))
            .catch((error: unknown) => {
                emit({ ...state, error: `新建任务失败：${messageOf(error)}` });
                throw error;
            });
    },

    addBot(roomId: string, name: string): void {
        if (name.trim() === '') return;
        void jsonFetch<Bot>('/bots', {
            method: 'POST',
            body: JSON.stringify({ name: name.trim(), homeRoomId: roomId, modelKey: state.defaultModelKey }),
        })
            .then((bot) =>
                jsonFetch(`/rooms/${encodeURIComponent(roomId)}/bots`, {
                    method: 'POST',
                    body: JSON.stringify({ botId: bot.id }),
                }),
            )
            .then(() => refresh())
            .catch(() => undefined);
    },

    /** 拉一次某个房间的上下文概况（面板打开 / 定时刷新时用） */
    refreshSessions(roomId: string): void {
        if (client.sessions === undefined) return;
        void client
            .sessions(roomId)
            .then((list) => emit({ ...state, sessions: { ...state.sessions, [roomId]: list } }))
            .catch(() => undefined);
    },

    /** 手动压一个 bot 的上下文：只影响它自己，不触发运行 */
    compactSession(
        roomId: string,
        botId: string,
        options: { keepLast?: number; maxChars?: number } = {},
    ): Promise<CompactOutcome | null> {
        if (client.compact === undefined) return Promise.resolve(null);
        return client
            .compact(roomId, botId, options)
            .then((outcome) => {
                actions.refreshSessions(roomId);
                return outcome;
            })
            .catch(() => null);
    },

    addExistingBot(roomId: string, botId: string): void {
        void jsonFetch(`/rooms/${encodeURIComponent(roomId)}/bots`, { method: 'POST', body: JSON.stringify({ botId }) })
            .then(() => refresh())
            .catch(() => undefined);
    },
};

/**
 * 代码级导航（与 `actions.navigate` 同一实现）。
 *
 * 单独导出而不是把整个 `actions` 露出去：view / 插件只需要「去某个位置」，不需要
 * 改名、删房、压上下文那些。接口面越小，越不容易被当成内部实现来依赖。
 */
export function navigate(target: NavAddress, options: { replace?: boolean } = {}): void {
    actions.navigate(target, options);
}

function loadDefaultModel(): string {
    try {
        return localStorage.getItem('entity-chat:default-model') ?? DEFAULT_MODEL;
    } catch {
        return DEFAULT_MODEL;
    }
}
