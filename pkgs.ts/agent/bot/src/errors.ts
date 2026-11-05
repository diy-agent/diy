// errors.ts — bot 域的错误码（caller 按 code 分类，不解析 message）

export type BotErrorCode =
    | "bot/invalid-id"
    | "bot/invalid-uri"
    | "bot/invalid-config"
    | "bot/not-found"
    | "bot/exists"
    // 管理域（A3，从 bot-config-page 搬来的业务规则）
    | "bot/no-model"
    | "bot/unknown-model"
    | "bot/name-taken"
    | "bot/id-taken";

export class BotError extends Error {
    readonly code: BotErrorCode;

    constructor(code: BotErrorCode, message: string) {
        super(message);
        this.name = "BotError";
        this.code = code;
    }
}
