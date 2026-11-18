// types.ts —— 协议层再导出（保持 surface 的 import 路径稳定）。
//
// 真正的定义在 @diy-agent/protocol：后端 runtime 与前端消费的是同一份类型。

export type {
    AnsweredAsk,
    AskAnswer,
    AskField,
    AskOption,
    AskQuestion,
    AskQuestionAnswer,
    AskRequest,
    Author,
    Bot,
    Capabilities,
    Command,
    Delivery,
    DeliveryState,
    Room,
    Item,
    ItemStatus,
    Snapshot,
    StreamEvent,
    TurnEndReason,
} from '@diy-agent/protocol';
export { DEFAULT_CAPABILITIES } from '@diy-agent/protocol';
