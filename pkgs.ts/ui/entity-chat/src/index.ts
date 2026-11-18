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
export type { ModelInfo, ModelKey, Provider } from './models';

// ── 导航 ──────────────────────────────────────────────────────
export { navigate } from './store';
export { addressOf, formatAddress, knownPage, parseAddress, registerPage, roomAddressOf, sameAddress } from './address';
export type { NavAddress } from './address';

// ── 侧栏插槽 ──────────────────────────────────────────────────
export { registerNavSource, unregisterNavSource, useNavSources } from './nav';
export type { NavContext, NavHost, NavSource } from './nav';
