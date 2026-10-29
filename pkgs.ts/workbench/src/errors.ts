// errors.ts — 外壳自己的异常：code 用来分辨「哪一步没装配好」（同仓约定 `<域>/<kebab>`）。
export class WorkbenchError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "WorkbenchError";
        this.code = code;
    }
}
