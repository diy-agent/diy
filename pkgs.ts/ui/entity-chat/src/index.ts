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
export type { ModelInfo, ModelKey, ModelSetup, Provider } from './models';

// ── 导航 ──────────────────────────────────────────────────────
export { navigate } from './store';

// dev / 测试用：把传输换成内存实现（`chat-core` 的 MockChatClient）。
// 生产路径永远不调 —— 入口在 apps/diy2 的 `?mock=1` 后面。
export { setDiy2Client } from './store';
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
export { Modal } from './components/Dialogs';
// 三段式模型选择器（provider → account → model）：角色的「模型」字段复用它，
// 空串 = 跟随房间 / 全局默认 —— 不让使用方自己再写一份 key 拼法
export { ModelPicker } from './components/ModelPicker';
// 三处同构的模型选择：默认模型配置 / bot 配置 / 聊天页配置共用这一份表格与胶囊
export { ModelSelectPanel, ModelSelectButton } from './components/ModelSelectPanel';
// 推理强度：档位来自模型（models.dev reasoning_options），缺省占位符对齐 dsh
export { EffortButtons, useEffortOptions } from './components/EffortButtons';
export { modelLabel, modelOfKey } from './models';
export { Sidebar } from './components/Sidebar';
// 对话区那一条的两样（表面切换 / 房间菜单）：宿主可以把它们摆进自己的区域标题栏
// （工作台就是这么做的，`bar="host"` 时对话区不再自己画那一行）。
export { RoomMenu, SurfaceTabs } from './components/ConversationBar';
export { TaskPanel } from './components/TaskPanel';
// 作业卡片：两个 surface 共用（判据在 chat-core 的 `jobOf`）。导出是为了让
// 选择型实验台能直接拿真组件摆样子 —— 别在 demo 里另画一份。
export { JobCard } from './components/JobCard';
export { ListRow, LIST_ROW_BASE, LIST_ROW_META, LIST_ROW_TITLE } from './components/ListRow';
export { UnitBoardView } from './components/UnitBoardView';
export { UnitNeedDetail } from './components/UnitNeedDetail';
// 标题栏右端的两颗活动图标（会话 N / 作业 M）：壳只负责把它们摆进 tools，
// 数字由组件自己订阅（全实例活动流）—— 宿主不会为「有人开跑」重渲一遍。
export { ActiveJobsGlyph, ActiveSessionsGlyph } from './components/ActiveGlyphs';
// 标题栏那颗「状态」：每个席位现在什么状态（在跑 / 等你回答 / 上一轮出错 / 空闲）。
// 与「Bot N」**各答一件事**：那颗数谁在动，这颗说该推谁一把（用户 2026-11-28 裁）。
export { BotStatusChip } from './components/BotStatusChip';
export { needsYou, outcomeTextOf, sortRows, STATE_TEXT, useBotRows } from './bots';
// 全局作业面板：房间内入口是输入框底栏的 `JobsChip`（抽屉），而「结局无人接」发生在
// 房间被删之后 —— 那时没有会话面，只能从标题栏那颗「作业 N」打开这一份。
export { JobsPanel } from './components/JobsChip';
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
/**
 * 模型配置的写面（配置页专用）—— 与 `actions` 分开的**唯一**例外，理由见 `modelConfig.ts`：
 * 模型配置是这一轮的核心能力（没配置就发不出去），它需要一个写入口；别的写路径仍然不放。
 */
export { modelConfig } from './modelConfig';

/**
 * 机器人配置的写面（设置页「机器人」那一段专用）—— 与 `modelConfig` 同一个理由：
 * 成员是**从配置表派生**的，改配置 = 该类型所有房间同时变，它也需要一个写入口。
 */
export { botProfiles } from './botProfiles';
export type { BotProfile, BotProfileInput } from './botProfiles';
export type {
    ModelConfigAccount,
    ModelConfigModel,
    ModelConfigProvider,
    ModelConfigSnapshot,
    ProviderPatchInput,
} from './modelConfig';

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
    useModelSetup,
    usePendingAskOf,
    useProviders,
    useBotProfileDefaults,
    useBotProfiles,
    useRooms,
    useSelectedRoom,
} from './store';
