// @diy-agent/entity-chat —— 实体即对话的 UI 包（项目/任务/bot）
//
// 只导出页面组件与样式入口；store / model / models 暂不对外（实验期允许变化）。

export { App as EntityChatApp } from './App';
export type { Entity, Bot, Item } from './model';
export type { Provider, ModelInfo, ModelKey } from './models';
