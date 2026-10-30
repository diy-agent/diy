// errors.ts — 本包的错误类型：带机器码，调用方能分辨「配置坏了」与「key 没配」。

export type CatalogErrorCode =
    | "catalog/invalid-options"
    | "catalog/invalid-config"
    | "catalog/unknown-provider"
    | "catalog/unknown-account"
    | "catalog/account-empty"
    | "catalog/account-unresolved";

export class CatalogError extends Error {
    readonly code: CatalogErrorCode;
    readonly path?: string;

    constructor(code: CatalogErrorCode, message: string, path?: string) {
        super(message);
        this.name = "CatalogError";
        this.code = code;
        this.path = path;
    }
}
