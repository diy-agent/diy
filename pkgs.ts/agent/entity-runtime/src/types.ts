// types.ts —— 协议类型统一从 @diy-agent/protocol 来（这里只做再导出，保持包内 import 路径不变）。

export type {
    AgentEvent,
    AnsweredAsk,
    AskAnswer,
    AskField,
    AskOption,
    AskQuestion,
    AskQuestionAnswer,
    AskRequest,
    Author,
    Bot,
    BotOutcome,
    BotProfile,
    BotProfileDefaults,
    Delivery,
    DeliveryState,
    Room,
    RoomMember,
    RoomEvent,
    Item,
    ItemStatus,
    MessageKind,
    BotRow,
    BotState,
    ProgressStage,
    StallPhase,
    TurnEndReason,
} from '@diy-agent/protocol';

/** 插话时机：下一步边界 / 下一轮开头（原来在 protocol，main 把它并进了别处） */
export type InboxMode = 'next-step' | 'next-turn';
