// @diy-agent/protocol —— 实体对话的协议层：只有类型，没有实现。
//
// 依赖规则（硬）：禁止 import React / node / 任何 UI kit / 任何 runtime 包。
// 后端（entity-runtime / server）与前端（chat-core / surface）共用这里的定义，
// 保证「后端产出的事件」与「前端消费的事件」是同一个类型，不靠约定同步。

export * from './types';
export * from './kernel';
