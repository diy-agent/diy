// errors.ts — 页面侧参数校验错误（配置文件的错误沿用 model-catalog 的 CatalogError）。
export class ModelConfigPageError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'ModelConfigPageError';
        this.code = code;
    }
}
