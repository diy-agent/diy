// store.tsx —— React 适配层：room / 选择（本包）+ 会话状态（chat-core 的 ConversationStore）。
//
// 词表：Room = 容器（项目/任务/股票…），BotRole = 类型的固定席位（全局表），
// Bot = 角色在某个房间里的化身（`botOfRole` 派生），BotSession = 它在那个房间里的对话。

import {
    ConversationStore,
    type AskAnswer,
    type Bot,
    type CompactOutcome,
    type Room,
    type SessionInfo,
} from '@diy-agent/chat-core';
import { RpcChatClient } from '@diy-agent/chat-transport-rpc';
import { botOfRole, type BotRole } from '@diy-agent/protocol';
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
import { firstUsableModelKey, type ModelCatalogPayload, type ModelSetup, type Provider } from './models';
import { mergePendingAsks } from './pendingAsk';

// ─── 会话（chat-core）─────────────────────────────────────────────

// 传输层唯一注入点：换 diy-rpc 时只改这一行
let client = new RpcChatClient();
/** 命令面出口：TaskPanel / drafts 用它（同一条 RPC 连接） */
export { client as diy2 };
drafts.configure(client.drafts);

/** 测试用：替换成假客户端（生产路径永远不调） */
export function setDiy2Client(next: typeof client): void {
    client = next;
    drafts.configure(next.drafts);
}

/** 本端缺省模型覆盖的存储键（`localStorage`；与 `model.yaml` 的 `defaultModel` 不是一回事） */
const DEFAULT_MODEL_OVERRIDE_KEY = 'entity-chat:default-model';
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
    /** 角色表（真源 `bot_roles`）：成员由它与房间类型派生，界面上「谁在这个房间」靠它 */
    roles: BotRole[];
    /** 角色 id → 房间里的化身。派生的投影，让老代码（按 bot 查名字/颜色）不用改 */
    bots: Record<string, Bot>;
    /**
     * 「在看哪儿」的真相 —— 一个能写进地址栏的位置（`/room/task/t-001`）。
     *
     * `selectedId` 是它在 `room` 页上的**投影**，留着是因为侧栏/正文一路都在用它；
     * 但真相必须是 address：将来的 `task-run` 页同样「在看某个东西」，那时候没有 selectedId 可用。
     */
    address: NavAddress;
    selectedId: string;
    /**
     * 缺省模型（新房间继承的那个）。来源三条，优先级从高到低：
     *   本端 localStorage（用户在这里改过） → 服务端 `diy2.models.list` 的 `defaultModelKey`
     *   （= `model.yaml` 的 `defaultModel`） → 目录里第一个配了 key 的模型。
     *
     * 以前是界面里一个写死的常量 —— 与 `model.yaml` 各自演进，换机器就莫名变了。
     */
    defaultModelKey: string;
    /**
     * 模型目录（`diy2.models.list`；真源 `model.yaml`）。页面不再自带 provider 表：
     * 选模型器 / 上下文窗口 / 模型名全部从这里取，界面只认形状。
     */
    providers: Provider[];
    /**
     * 这份目录是从**什么状态**的配置里读出来的（没 model.yaml / 缺快照 / 正常）。
     *
     * 与 `providers` 分开的原因见 `models.ts` 的 `ModelSetup`：空目录有三种成因，出路不同。
     */
    modelSetup: ModelSetup;
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
    /**
     * 容器 id → 还有几个提问在等回答（侧栏 ?）。服务端 `/api/rooms` 的投影字段 `pendingAsks`；
     * 当前房间另由会话流现算 —— 答完那一刻 gate 就结算了，不该等 30 秒轮询才灭。
     * 只有「正在看」的房间交给流，其余（含看过的）以服务端为准，见 `mergePendingAsks`。
     */
    pendingAsks: Record<string, number>;
    /**
     * 容器 id → 那些待答提问的**第一句题干**（侧栏 `?` 的 tooltip：`?` 只说几个，
     * 这里说问的是什么 —— 用户报的「进会话不知道是哪个」就是这一步缺的）。
     *
     * 同样来自 `diy2.rooms.list` 的投影（服务端一次算好，别逐房间问）；当前房间由会话流同步更新。
     */
    pendingAskTitles: Record<string, string[]>;
    error?: string;
}

let state: ShellState = {
    rooms: [],
    roles: [],
    bots: {},
    // id 为空 = 「还没定」，首屏由 resolveAddress 从地址栏或第一个房间补上
    address: addressOf(DEFAULT_PAGE, ''),
    selectedId: '',
    // 空串 = 「还不知道」：首屏 refresh 会从服务端（model.yaml）补上
    defaultModelKey: loadDefaultModelOverride() ?? '',
    providers: [],
    // 首屏之前不指控：没问过服务端就说「你没配置」会在每次刷新时闪一下横幅
    modelSetup: { configured: true, modelConfigPath: '', snapshotMissing: false },
    loaded: false,
    sessions: {},
    lastActivity: {},
    pendingAsks: {},
    pendingAskTitles: {},
};
const listeners = new Set<() => void>();

function emit(next: ShellState): void {
    state = next;
    for (const listener of listeners) listener();
}

/**
 * 订阅回调提成模块级常量：每次 render 传一个新函数，`useSyncExternalStore` 会每轮
 * 退订再订阅一遍（它对 subscribe 的引用做比较）。下面的几个 hook 共用同一个。
 */
function subscribeShell(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * 整份快照。**这是兜底，不是默认**：它每次 `emit` 都会让调用者重渲，因为快照对象
 * 每次都是新的。界面里能说清「我要哪个值」的，就用下面那些窄选择器。
 *
 * 现在还剩：正文 / 对话框 / 表面（它们本来就跟着会话和错误一起变）。壳和侧栏
 * 一行都不用这个 —— 一行重渲是由「这一行看到的值变了」决定的。
 */
export function useShell(): ShellState {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state,
        () => state,
    );
}

export const useStore = useShell;

/**
 * 只订阅「当前地址」。侧栏每一行都要判断自己是不是当前那一行，用 `useShell()` 就是
 * 整份快照：某个房间的最后活动变了、一条错误来了，整张表跟着重渲。
 *
 * 返回的引用只在地址真的换了时才变 —— `pickAddress` 在旧地址还合法时原样返回它。
 */
export function useAddress(): NavAddress {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.address,
        () => state.address,
    );
}

/**
 * 只订阅房间列表本身。`emit` 换掉的是 `lastActivity` / `pendingAsks` / `error` 这些
 * 字段（浅拷贝），`rooms` 引用不变 —— 侧栏三块因此不会因为「某个房间来了条消息」重渲。
 * 列表真的变了（改名 / 增删 / 改状态）时才会。
 */
export function useRooms(): Room[] {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.rooms,
        () => state.rooms,
    );
}

/** 只订阅角色表（设置页「角色」那一段用）。成员名单由它与房间类型派生。 */
export function useRoles(): BotRole[] {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.roles,
        () => state.roles,
    );
}

/** 只订阅 bot 表（头部成员胶囊用）。同理：别的字段变了，引用不变。 */
export function useBots(): Record<string, Bot> {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.bots,
        () => state.bots,
    );
}

/** 只订阅 `loaded`（首屏「连接中」/ 空壳两态）。 */
export function useLoaded(): boolean {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.loaded,
        () => state.loaded,
    );
}

/** 只订阅当前错误串。没有错误时是 `undefined`（同一个值），错误清了才变。 */
export function useError(): string | undefined {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.error,
        () => state.error,
    );
}

/**
 * 只订阅默认模型（对话框与新建时用）。
 *
 * 注意它和「当前房间的 modelKey」是两件事：后者在 `Room` 对象上，跟着 `useRooms()` 走。
 */
/** 模型目录（`diy2.models.list` 的 providers；形状见 `models.ts`） */
export function useProviders(): Provider[] {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.providers,
        () => state.providers,
    );
}

export function useDefaultModelKey(): string {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.defaultModelKey,
        () => state.defaultModelKey,
    );
}

/**
 * 模型配置的状态（没 model.yaml / 缺目录快照）。
 *
 * 宿主拿它画横幅：没配置是个**要看见**的状态，不是「目录恰好空着」的副作用。
 */
export function useModelSetup(): ModelSetup {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.modelSetup,
        () => state.modelSetup,
    );
}

/**
 * 只订阅「正在看的那个房间」。快照是 `rooms` 数组里的**那个元素**，引用稳定 ——
 * 列表里别的房间变了（新消息、改了状态）不会把正文头部重渲一遍。
 *
 * 用元素而不是 `find(...)` 的结果包一层：包出来的新对象每次都不等，等于整份快照。
 */
export function useSelectedRoom(): Room | undefined {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.rooms.find((room) => room.id === state.selectedId),
        () => state.rooms.find((room) => room.id === state.selectedId),
    );
}

/**
 * 只订阅「这一行是不是当前行」（布尔）。
 *
 * 为什么不给每一行 `useAddress()`：地址一变，所有行拿到的快照都是新对象，整张表
 * 跟着重渲 —— 而实际要变的只有「旧的高亮灭掉、新的亮起来」这两行。这里比完
 * 只剩一个 true/false，没翻转的行不会被通知。
 */
export function useIsCurrentRoom(roomId: string): boolean {
    return React.useSyncExternalStore(
        subscribeShell,
        () => isCurrentRoom(state.address, { id: roomId }),
        // 服务端渲染时按已有快照算，而不是一律 false：SSR 出来的第一屏也要有高亮
        () => isCurrentRoom(state.address, { id: roomId }),
    );
}

/**
 * 只订阅一个房间的最后活动。`emit` 每次换掉 `lastActivity` 的整份记录（浅拷贝），
 * 但这里取到的是单个毫秒数：React 用 `Object.is` 比快照，数没变就不重渲这一行。
 */
export function useLastActivityOf(roomId: string): number | undefined {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.lastActivity[roomId],
        () => state.lastActivity[roomId],
    );
}

/**
 * 只订阅一个房间的「还有几个提问在等我答」（侧栏 ?）。和 `useLastActivityOf` 同理：
 * 取到的是单个数字，别的房间加减提问不会重渲这一行。
 */
export function usePendingAskOf(roomId: string): number {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.pendingAsks[roomId] ?? 0,
        () => state.pendingAsks[roomId] ?? 0,
    );
}

/** 稳定的空数组：每次 `?? []` 都造新对象会让 useSyncExternalStore 每轮都判"变了" */
const EMPTY_TITLES: readonly string[] = [];

/** 那些待答提问的题干（侧栏 `?` 的 tooltip）。与计数分开订阅：题干变不影响别人的行 */
export function usePendingAskTitlesOf(roomId: string): readonly string[] {
    return React.useSyncExternalStore(
        subscribeShell,
        () => state.pendingAskTitles[roomId] ?? EMPTY_TITLES,
        () => state.pendingAskTitles[roomId] ?? EMPTY_TITLES,
    );
}

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

// ─── 地址栏同步（只在这里碰 window）───────────────────────────────
//
// 真相在 `state.address`，地址栏是它的投影。两个方向：
//   内存 → 地址栏：`writeAddress`（navigate / refresh 时）
//   地址栏 → 内存：`popstate` 监听（用户按前进后退）

/**
 * 位置同步开关：true = store 读写地址栏（App 的默认形态，URL 就是路由）。
 *
 * 宿主挂在**自己的**路由页上时关掉它（见 bootstrapStore 的 syncAddress）：那种壳的地址
 * 另有含义，store 一 bootstrap 就 replaceState 成 /room/xxx，会把壳的地址顶掉。
 * 工作台不关 —— 它的 URL 就是「在看哪个房间」。
 */
let addressSync = true;

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
    if (!addressSync) return;
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
        fromUrl: addressSync && typeof window !== 'undefined' ? parseAddress(window.location.pathname) : undefined,
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
    if (addressHooksInstalled || typeof window === 'undefined' || !addressSync) return;
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
/**
 * 已经「热」过的房间：**当前这条订阅**至少到过一份快照。
 *
 * 刚调 `conversationOf()` 时 asks 还是空的（快照在路上），这时它的计数不能盖住
 * `/api/rooms` 的投影 —— 否则每切进一个有提问的房间，? 都会先灭一下再亮起来。
 *
 * 离开就销号（见 `watchActivity`）：`conversations` 是按房间复用的，切走时只是
 * `dispose()` 摘流，缓存里还留着离开前那份 asks。留着「热」标记的话，切回去的瞬间
 * 会先按旧快照报一次数，可能把服务端的 0 又盖回成一个旧的正数。
 */
const warmRooms = new Set<string>();

/**
 * 只跟当前房间：切走就退订，别让看过的每个房间各留一个订阅。
 * 一份订阅喂两个标记：最后活动（⌚ 行尾）+ 待答提问（?）。
 */
function watchActivity(roomId: string): void {
    if (roomId === activityRoomId) return;
    activityUnsub?.();
    activityUnsub = undefined;
    // 这条订阅到此为止：它送过的快照从这一刻起不再作数（复用的 store 里还留着旧数）
    if (activityRoomId !== '') warmRooms.delete(activityRoomId);
    activityRoomId = roomId;
    if (roomId === '') return;
    const store = conversationOf(roomId);
    activityUnsub = store.subscribe(() => {
        const snapshot = store.get();
        // 快照到了（有 item / 有 seq / 有提问）才算热：此后以这条流为准
        if (snapshot.items.length > 0 || snapshot.seq > 0 || snapshot.asks.length > 0) warmRooms.add(roomId);
        // 取最大而不是最后一条：跨 bot 的消息按 order 插入，数组尾巴不是最新的那个时刻
        let at = 0;
        for (const item of snapshot.items) if (item.at > at) at = item.at;
        const next: Partial<ShellState> = {};
        if (at > 0 && at > (state.lastActivity[roomId] ?? 0)) {
            next.lastActivity = { ...state.lastActivity, [roomId]: at };
        }
        if (warmRooms.has(roomId) && (state.pendingAsks[roomId] ?? 0) !== snapshot.asks.length) {
            next.pendingAsks = { ...state.pendingAsks, [roomId]: snapshot.asks.length };
        }
        // 题干也跟着流走：新提问在服务端投影追上之前（30 秒）也得能看到问的是什么
        if (warmRooms.has(roomId)) {
            const titles = snapshot.asks.map((request) => request.questions[0]?.question ?? '');
            const current = state.pendingAskTitles[roomId] ?? EMPTY_TITLES;
            if (titles.join('\u0000') !== current.join('\u0000')) {
                next.pendingAskTitles = { ...state.pendingAskTitles, [roomId]: titles };
            }
        }
        if (next.lastActivity === undefined && next.pendingAsks === undefined && next.pendingAskTitles === undefined)
            return;
        emit({ ...state, ...next });
    });
}

/**
 * 重拉**模型面**（配置页写完调）：`providers`（选模型器）+ `modelSetup`（横幅）+ 缺省模型。
 *
 * 刻意不重拉 rooms、不动地址：写完一次配置不该把用户看的位置挪走。缺省模型的算法与
 * `refresh()` 同一口径（本端覆盖 > model.yaml > 目录里第一个可用的），别在这里另写一份。
 */
export async function refreshCatalog(): Promise<void> {
    const catalog = await client.models.list();
    const defaultModelKey =
        loadDefaultModelOverride() ?? (catalog.defaultModelKey || firstUsableModelKey(catalog.providers) || '');
    emit({
        ...state,
        providers: catalog.providers,
        modelSetup: {
            configured: catalog.configured,
            modelConfigPath: catalog.modelConfigPath,
            snapshotMissing: catalog.snapshotMissing,
        },
        ...(defaultModelKey === '' ? {} : { defaultModelKey }),
    });
}

/**
 * 重拉**角色表**（角色页写完调）：`roles` + 派生出来的 `bots` 一起换。
 *
 * 与 `refreshCatalog` 一个路数：不重拉 rooms、不动地址。房间头的成员胶囊读的是
 * `bots`，所以两个字段必须同一笔 emit —— 分开写会有一帧「角色新了、名字还是旧的」。
 */
export async function refreshRoles(): Promise<void> {
    const roles = await client.roles.list();
    emit({
        ...state,
        roles,
        bots: Object.fromEntries(roles.map((role) => [role.id, botOfRole(role)])),
    });
}

async function refresh(opts: { keepError?: boolean } = {}): Promise<void> {
    // 模型目录跟着同一趟回来（真源 model.yaml；界面不再自带 provider 表）：
    // 走 `diy2.models.list`，与 rooms / bots 共用同一条 RPC 连接
    const [rooms, roles, catalog] = await Promise.all([
        client.rooms.list(),
        client.roles.list(),
        client.models.list(),
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
    // 待答提问：同一次列表请求回来（服务端一次算好，别逐房间问）
    const serverPendingAsks: Record<string, number> = {};
    for (const room of rooms) {
        if (typeof room.pendingAsks === 'number' && room.pendingAsks > 0) {
            serverPendingAsks[room.id] = room.pendingAsks;
        }
    }
    // 只有当前房间（且流已热身）由流说了算；离开过的房间必须交回服务端 —— 那份本地值
    // 在切走时就跟着订阅一起冻住了，继续本地优先会让 ? 永久亮着。规则见 pendingAsk.ts
    const liveRoomId = activityRoomId !== '' && warmRooms.has(activityRoomId) ? activityRoomId : '';
    const pendingAsks = mergePendingAsks(serverPendingAsks, state.pendingAsks, liveRoomId);
    // 题干（侧栏 ? 的 tooltip）：与计数同一次请求回来；没题干的老服务端就不给，tooltip 退回只说个数
    const serverAskTitles: Record<string, string[]> = {};
    for (const room of rooms) {
        const titles = room.pendingAskTitles;
        if (Array.isArray(titles) && titles.length > 0) serverAskTitles[room.id] = titles;
    }
    const pendingAskTitles: Record<string, string[]> = { ...serverAskTitles };
    // 当前房间的题干以流为准（服务端那份可能落后几十秒）
    const liveTitles = liveRoomId === '' ? undefined : state.pendingAskTitles[liveRoomId];
    if (liveRoomId !== '' && liveTitles !== undefined) pendingAskTitles[liveRoomId] = [...liveTitles];
    const address = resolveAddress(rooms);
    // 缺省模型：本端改过的（localStorage）永远优先 —— 那是人的显式选择
    const defaultModelKey =
        loadDefaultModelOverride() ?? (catalog.defaultModelKey || firstUsableModelKey(catalog.providers) || '');
    emit({
        ...state,
        providers: catalog.providers,
        modelSetup: {
            configured: catalog.configured,
            modelConfigPath: catalog.modelConfigPath,
            snapshotMissing: catalog.snapshotMissing,
        },
        ...(defaultModelKey === '' ? {} : { defaultModelKey }),
        rooms,
        lastActivity,
        pendingAsks,
        pendingAskTitles,
        roles,
        // 化身从角色派生（名字 / 颜色 / 人格 / 模型唯一的转换点）：成员名单仍然按房间的 spec 过滤
        bots: Object.fromEntries(roles.map((role) => [role.id, botOfRole(role)])),
        loaded: true,
        // 地址没变就沿用旧引用：`useAddress()` 的快照就是它，同值换新对象等于给整张侧栏
        // 发一次「变了」的信号。`pickAddress` 多数分支会给旧对象，但 fallback / 首屏那条
        // 每次都新建，所以在这里兜住。
        address: sameAddress(state.address, address) ? state.address : address,
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

/**
 * 宿主装配用：把 store 拉起来（幂等）。
 *
 * App 挂载时自己会调一次，但宿主可能要在 App 之外先读房间列表 —— 工作台就是：
 * 它得先知道「有哪些房间」才知道该开哪一页，而那一刻 App 还没人挂。等 App 触发
 * 就成了死锁（不 loaded 不渲染页，不渲染页没人 bootstrap）。
 *
 * `syncAddress: false` = 别碰地址栏：位置同步是 App 的职责（它的 URL 就是路由），
 * 宿主的壳自己管地址。
 */
export function bootstrapStore(options?: { syncAddress?: boolean }): void {
    if (options?.syncAddress === false) addressSync = false;
    actions.bootstrap();
}

/**
 * 新建实体时要不要带模型：**空串一律不发**。
 *
 * `defaultModelKey` 在目录为空（新机器 / 没配 provider 账号）时就是 `''`，而 `modelKey`
 * 一旦落库就没有「等于没填」的语义了 —— 服务端收到空串只会得到一个"模型标识不合法"的实体。
 * 不传 = 由服务端按它当时的缺省填。
 */
function modelArg(modelKey: string): { modelKey?: string } {
    return modelKey === '' ? {} : { modelKey };
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
        return client.rooms
            .update({ id, name: next })
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
        return client.rooms
            .update({ id, data: { status, closedAt: status === 'closed' ? Date.now() : null } })
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
        return client.rooms
            .remove(id)
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

    /**
     * 改 room.data 的若干键（任务描述 / 正文…）：`null` = 删除该键。
     * 抛错给调用方（侧面板要保留未保存内容并提示），同时亮全局错误。
     */
    updateRoomData(id: string, data: Record<string, unknown>): Promise<void> {
        return client.rooms
            .update({ id, data })
            .then(() => refresh())
            .catch((error: unknown) => {
                emit({ ...state, error: `保存失败：${messageOf(error)}` });
                throw error;
            });
    },

    /**
     * 建一条实体关系（相关性 / 阻塞 / 重复）。失败亮全局错误并抛给调用方，
     * 面板据此保留选择、不假装成功。
     */
    addLink(id: string, to: string, kind: string): Promise<void> {
        return client.links
            .add(id, to, kind)
            .then(() => undefined)
            .catch((error: unknown) => {
                emit({ ...state, error: `建立关系失败：${messageOf(error)}` });
                throw error;
            });
    },

    /** 删一条关系（服务端幂等：删不存在的也返回 ok） */
    removeLink(id: string, to: string, kind: string): Promise<void> {
        return client.links
            .remove(id, to, kind)
            .then(() => undefined)
            .catch((error: unknown) => {
                emit({ ...state, error: `取消关系失败：${messageOf(error)}` });
                throw error;
            });
    },

    setRoomModel(id: string, modelKey: string): void {
        void client.rooms
            .update({ id, modelKey })
            .then(() => refresh())
            .catch(() => undefined);
    },

    setDefaultModel(modelKey: string): void {
        try {
            localStorage.setItem(DEFAULT_MODEL_OVERRIDE_KEY, modelKey);
        } catch {
            /* 忽略 */
        }
        emit({ ...state, defaultModelKey: modelKey });
    },

    createProject(input: { name: string; dir: string }): void {
        void client.rooms
            .create({
                type: 'project',
                name: input.name,
                ...modelArg(state.defaultModelKey),
                data: { dir: input.dir },
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
        return client.rooms
            .create({
                type: 'task',
                name: trimmed,
                ...modelArg(state.defaultModelKey),
                data: { projectId, dir: project?.data['dir'], ...extra },
            })
            .then((room) => refresh().then(() => actions.navigate(roomAddressOf(room))))
            .catch((error: unknown) => {
                emit({ ...state, error: `新建任务失败：${messageOf(error)}` });
                throw error;
            });
    },

    /** 拉一次某个房间的上下文概况（面板打开 / 定时刷新时用） */
    refreshSessions(roomId: string): void {
        if (client.sessions === undefined) return;
        void client
            .sessions(roomId)
            .then((list) => emit({ ...state, sessions: { ...state.sessions, [roomId]: list } }))
            .catch(() => undefined);
    },

    /**
     * 手动压一个 bot 的上下文：只影响它自己，不触发运行。
     *
     * 受理即返：这里**不刷 sessions** —— 压缩还没开始跑，刷也是旧数字。
     * 进展与结果都从 `compact` 事件进（`ConversationState.compactions`）。
     */
    compactSession(
        roomId: string,
        botId: string,
        options: { keepTurns?: number } = {},
    ): Promise<CompactOutcome | null> {
        if (client.compact === undefined) return Promise.resolve(null);
        return client.compact(roomId, botId, options).catch(() => null);
    },

    /** 撤掉一次正在跑的压缩；false = 已经结束（不弹错误条） */
    cancelCompact(roomId: string, compactId: string): Promise<boolean> {
        if (client.cancelCompact === undefined) return Promise.resolve(false);
        return client.cancelCompact(roomId, compactId).catch(() => false);
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

/**
 * 本端对缺省模型的**覆盖**（用户在设置里点过）—— 没有覆盖 = undefined，交给服务端说。
 *
 * 与「服务端的默认值」分开存：以前两者揉在一个函数里，于是常量既是兜底又被当真相，
 * 换 `model.yaml` 也不生效。
 */
function loadDefaultModelOverride(): string | undefined {
    try {
        const value = localStorage.getItem(DEFAULT_MODEL_OVERRIDE_KEY);
        return value === null || value === '' ? undefined : value;
    } catch {
        return undefined;
    }
}
