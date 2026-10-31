// errors.ts — @diy-agent/log 的错误类型（配置写错才抛；写盘失败不抛，走 onError）
//
// 为什么写盘失败不抛：日志是**旁路**，它坏了不许把 app 带崩（同 rule：观测能力不得反向影响主流程）。
// 配置错误是开发期错误，抛得越早越好。

export type LogErrorCode =
    /** dir / level / rotate / maxDataBytes 等入参非法 */
    | 'log/invalid-options'
    /** source 为空（统一流里没有来源就失去了过滤能力） */
    | 'log/invalid-source';

/** 本包唯一错误类型：带 `code`（机器判据）与 `detail`（可定位到哪个选项） */
export class LogError extends Error {
    readonly code: LogErrorCode;
    readonly detail: string;

    constructor(code: LogErrorCode, message: string, detail = '') {
        super(detail === '' ? `${code}: ${message}` : `${code} @ ${detail}: ${message}`);
        this.name = 'LogError';
        this.code = code;
        this.detail = detail;
    }
}
