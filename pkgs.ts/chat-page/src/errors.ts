// errors.ts — 本插件自己的异常（code 同仓约定 `<域>/<kebab>`）。
export class ChatPageError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "ChatPageError";
        this.code = code;
    }
}
