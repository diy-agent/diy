// errors.ts — bot 域的错误码（caller 按 code 分类，不解析 message）

export type BotErrorCode = "bot/invalid-id" | "bot/invalid-config" | "bot/not-found";

export class BotError extends Error {
    readonly code: BotErrorCode;

    constructor(code: BotErrorCode, message: string) {
        super(message);
        this.name = "BotError";
        this.code = code;
    }
}
