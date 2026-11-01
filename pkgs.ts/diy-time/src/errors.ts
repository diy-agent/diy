// errors.ts — @diy-agent/time 的错误类型（只有一种：拿到的不是有效时刻）
//
// 为什么抛而不返回空串：`localISOString(new Date('x'))` 若静默给 `NaN-NaN-NaN…`，
// 落盘的就是一条**长得像时间、其实不可解析**的记录 —— 事后没人能从格式上看出来。
// 宁可在写入点炸（调用栈直指哪里造了个坏 Date）。

export type TimeErrorCode =
    /** 入参不是有效时刻（`Date` 的 `getTime()` 为 NaN） */
    'time/invalid-date';

export class TimeError extends Error {
    readonly code: TimeErrorCode;
    readonly detail: string;

    constructor(code: TimeErrorCode, message: string, detail = '') {
        super(detail === '' ? `${code}: ${message}` : `${code} @ ${detail}: ${message}`);
        this.name = 'TimeError';
        this.code = code;
        this.detail = detail;
    }
}
