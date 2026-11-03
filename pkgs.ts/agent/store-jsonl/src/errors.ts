// errors.ts — @diy-agent/session-store-jsonl 统一错误类型
//
// 存储是「删了就读不回来」的那一层：任何异常都不许降级成「跳过这一桶」。
// 缺桶 / 缺号 / 坏行一律抛带 code 的错误（rule.err-triage#code）。

/** 错误分类（宿主按 code 决定处置：修复 / 停工 / 人工介入） */
export type StoreErrorCode =
    /** open / 方法入参非法（dir 为空、maxBucketBytes 非正、seq 非法） */
    | 'store/invalid-options'
    /** index.json 引用的桶文件不存在（删了中间桶 = 这里报） */
    | 'store/missing-bucket'
    /** seq 不连续（缺号 / 重号）—— 别静默丢数据 */
    | 'store/gap'
    /** 桶文件行不是合法 JSON / 缺 seq / 字段形状不对 */
    | 'store/corrupt'
    /** append 的消息没有 seq（core 必然分配；到这里没有就是调用方绕过了 core） */
    | 'store/message-without-seq';

/** 本包唯一错误类型：带 `code`（机器判据）与 `detail`（可定位到文件） */
export class StoreError extends Error {
    readonly code: StoreErrorCode;
    readonly detail: string;

    constructor(code: StoreErrorCode, message: string, detail = '') {
        super(detail === '' ? `${code}: ${message}` : `${code} @ ${detail}: ${message}`);
        this.name = 'StoreError';
        this.code = code;
        this.detail = detail;
    }
}
