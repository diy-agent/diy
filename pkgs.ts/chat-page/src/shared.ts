// shared.ts — 主进程与 renderer 之间的线上形状（两端共用，避免各写一份）。

/** 一条展示用的消息（只有生成侧关心的字段；seq / at 等内部字段不过桥） */
export interface WireMessage {
    readonly role: "user" | "assistant";
    readonly text: string;
}

/** `send` 方法的返回值：整条会话的当前消息线 */
export interface SendResult {
    readonly messages: readonly WireMessage[];
}
