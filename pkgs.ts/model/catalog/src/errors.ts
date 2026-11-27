// errors.ts — 本包的错误类型：带机器码，调用方能分辨「配置坏了」与「key 没配」。

export type CatalogErrorCode =
    | 'catalog/invalid-options'
    | 'catalog/invalid-config'
    | 'catalog/unknown-provider'
    | 'catalog/unknown-account'
    | 'catalog/account-empty'
    | 'catalog/account-unresolved';

export class CatalogError extends Error {
    readonly code: CatalogErrorCode;
    readonly path?: string;

    constructor(code: CatalogErrorCode, message: string, path?: string) {
        super(message);
        this.name = 'CatalogError';
        this.code = code;
        this.path = path;
    }
}

/**
 * js-yaml 对**空文档**的报错（0 字节 / 只有空白 / 只有注释）。
 *
 * 这些文件是**合法**的 YAML —— 解析器却抛错。读侧写侧一律当 `{}` 处理：
 * 一个刚 `touch` 出来的 `model.yaml` 必须能被配置页填进去，而不是先报「解析失败」。
 */
export function isEmptyDocument(message: string): boolean {
    return message.includes("expected a document") && message.includes("input is empty");
}
