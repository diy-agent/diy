// @diy-agent/entity-chat —— 实体即对话的 UI 包（项目/任务/bot）
//
// 导出面就三样，其余（store / model / models 的内部）实验期不对外：
//   1. 页面组件 —— 直接挂；
//   2. 导航 —— 「去某个位置」是视图与插件唯一需要的能力，所以单独给 `navigate` +
//      `NavAddress`，而不是把整个 `actions`（改名、删房、压上下文…）露出去；
//   3. 侧栏插槽 —— `registerNavSource` 让外部贡献一个导航分区，契约见 `NavSource`。
//
// 位置相关的纯函数也一并导出：`<a href={formatAddress(...)}>` 要能自己拼地址，
// 否则调用方只能猜格式，格式一变就全错。

export { App as EntityChatApp } from './App';
export type { Bot, Item, Room } from './model';
export { roomTitle } from './model';
export type { ModelInfo, ModelKey, Provider } from './models';

// ── 导航 ──────────────────────────────────────────────────────
export { navigate } from './store';
export { addressOf, formatAddress, knownPage, parseAddress, registerPage, roomAddressOf, sameAddress } from './address';
export type { NavAddress } from './address';

// ── 侧栏插槽 ──────────────────────────────────────────────────
export { registerNavSource, unregisterNavSource, useNavSources } from './nav';
export type { NavContext, NavHost, NavSource } from './nav';

// ── 宿主装配用的部件 ──────────────────────────────────────
//
// 工作台把「外壳」拆给各个区域：左边是侧栏、详情区是任务面板、center 只留对话。
// 这些部件自己不知道被装在哪里 —— 宽度 / 收起由外层 area 决定（`widthMode="fill"`），
// 弹窗由宿主挂一次 `useRoomDialogs()`（整页 App 与工作台共用同一套状态）。
export { Sidebar } from './components/Sidebar';
// 对话区那一条的两样（表面切换 / 房间菜单）：宿主可以把它们摆进自己的区域标题栏
// （工作台就是这么做的，`bar="host"` 时对话区不再自己画那一行）。
export { RoomMenu, SurfaceTabs } from './components/ConversationBar';
export { TaskPanel } from './components/TaskPanel';
// 作业卡片：两个 surface 共用（判据在 chat-core 的 `jobOf`）。导出是为了让
// 选择型实验台能直接拿真组件摆样子 —— 别在 demo 里另画一份。
export { JobCard } from './components/JobCard';
export { UnitBoardView } from './components/UnitBoardView';
// 标题栏右端的两颗活动图标（会话 N / 作业 M）：壳只负责把它们摆进 tools，
// 数字由组件自己订阅（全实例活动流）—— 宿主不会为「有人开跑」重渲一遍。
export { ActiveJobsGlyph, ActiveSessionsGlyph } from './components/ActiveGlyphs';
// 全局作业面板：房间内入口是输入框底栏的 `JobsChip`（抽屉），而「结局无人接」发生在
// 房间被删之后 —— 那时没有会话面，只能从标题栏那颗「作业 N」打开这一份。
export { JobsPanel } from './components/JobsChip';
// Bot 状态（在跑 / 等回答 / 上一轮出错 / 空闲）：二级浮层 + 三级全量表格。
//
// 数据与口径都在 `bots.ts` 里（`useBotRows` + `needsYou`）：宿主只负责在标题栏摆一颗
// 按钮、把计数画上去，然后挂 `BotsOverlay` —— 两处不各算一遍。
export { BotsOverlay, type BotsOverlayProps, type Filter } from './components/BotsOverlay';
// 标题栏那排分类计数徽标（出错 / 等你 / 排队 / 在跑）：数字与浮层、筛选 tab 同源
export { AttentionCapsules, type AttentionCapsulesProps } from './components/AttentionCapsules';
export {
    attentionOf,
    countByAttention,
    needsYou,
    visibleInOverlay,
    ATTENTION_DOT,
    ATTENTION_INK,
    ATTENTION_TEXT,
    outcomeTextOf,
    STATE_TEXT,
    useBotRows,
    type AttentionCounts,
    type AttentionKind,
    type BotRowsState,
} from './bots';
export { RoomDialogsProvider, useRoomDialogs, useRoomDialogsContext } from './useRoomDialogs';
export type { RoomDialogs } from './useRoomDialogs';

// ── 宿主装配用的只读钩子 ──────────────────────────────────────
//
// 为什么必须放出来：宿主要自己画「有哪些房间 / 现在在看哪个 / 连上了没有」这类**导航**
// （workbench-dock 的左栏、页实例身份都从这里取），而这些状态只活在 store 里 ——
// 不导出，宿主就只能猜或者重连一次 API。
//
// 只给**读**：`actions`（改名 / 删房 / 压上下文 / 换模型）仍然不露 —— 写路径要一条一条
// 设计语义（谁审、失败了怎么回滚），不适合顺手放出来当便利 API。
export {
    bootstrapStore,
    jumpToFirstRunningRoom,
    roomOf,
    shellSnapshot,
    useAddress,
    useBots,
    useDefaultModelKey,
    useIsCurrentRoom,
    useLastActivityOf,
    useLoaded,
    usePendingAskOf,
    useRooms,
    useSelectedRoom,
} from './store';
