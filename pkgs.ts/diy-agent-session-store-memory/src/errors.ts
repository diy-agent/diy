// errors.ts — @diy-agent/session-store-memory 的错误类型（与 jsonl 适配器同一套码，换实现不换判据）

export type MemoryStoreErrorCode =
    /** open / 方法入参非法（maxEntries 非正整数、seq 非法） */
    | 'store/invalid-options'
    /** seq 不连续（缺号 / 重号）—— 与 jsonl 同样不静默丢数据 */
    | 'store/gap'
    /** append 的消息没有 seq（core 必然分配；到这里没有就是调用方绕过了 core） */
    | 'store/message-without-seq';

export class MemoryStoreError extends Error {
    readonly code: MemoryStoreErrorCode;
    readonly detail: string;

    constructor(code: MemoryStoreErrorCode, message: string, detail = '') {
        super(detail === '' ? `${code}: ${message}` : `${code} @ ${detail}: ${message}`);
        this.name = 'MemoryStoreError';
        this.code = code;
        this.detail = detail;
    }
}
