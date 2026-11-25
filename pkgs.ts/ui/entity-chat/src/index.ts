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
export { TaskPanel } from './components/TaskPanel';
// 作业卡片：两个 surface 共用（判据在 chat-core 的 `jobOf`）。导出是为了让
// 选择型实验台能直接拿真组件摆样子 —— 别在 demo 里另画一份。
export { JobCard } from './components/JobCard';
export { UnitGraph } from './components/UnitGraph';
export { UnitDagView } from './components/UnitDagView';
export { UnitTextView } from './components/UnitTextView';
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
