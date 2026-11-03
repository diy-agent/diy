// errors.ts — 页面侧参数 / 业务错误（bot.json 自身的错误沿用 @diy-agent/bot 的 BotError）。
export type BotConfigPageErrorCode =
    | 'bot-config/no-home'
    | 'bot-config/bad-args'
    | 'bot-config/not-found'
    | 'bot-config/unknown-model'
    | 'bot-config/id-taken'
    | 'bot-config/no-model'
    | 'bot-config/busy';

export class BotConfigPageError extends Error {
    readonly code: BotConfigPageErrorCode;

    constructor(code: BotConfigPageErrorCode, message: string) {
        super(message);
        this.name = 'BotConfigPageError';
        this.code = code;
    }
}
