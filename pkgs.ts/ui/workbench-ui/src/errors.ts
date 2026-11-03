// errors.ts — 布局骨架自己的异常（code 同仓约定 `<域>/<kebab>`）。
export class WorkbenchUiError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "WorkbenchUiError";
        this.code = code;
    }
}
