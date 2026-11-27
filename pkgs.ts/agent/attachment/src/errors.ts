// errors.ts — @diy-agent/attachment 统一错误类型
//
// 附件层是「删了就读不回来」的那一层：任何异常都不许降级成「当没有附件」继续跑
// （静默丢图的症状是模型答非所问，比报错难查一百倍）。一律抛带 code 的错误
// （rule.err-triage#code）：宿主按 code 决定是修复、拒收还是喊人。

/** 错误分类 */
export type AttachmentErrorCode =
    /** open / 入参非法（root 为空、上限非正、kind 与形态不匹配） */
    | 'attachment/invalid-options'
    /** id / relPath / path 折出来跑到 blobs 根之外（`..`、绝对路径、软链逃逸） */
    | 'attachment/unsafe-path'
    /** 该 id 在 blobs 里没有对应文件（被清过 / id 拼错） */
    | 'attachment/not-found'
    /** 超过单文件上限（默认 64 MB；目录请走 archive 或 linked） */
    | 'attachment/too-large'
    /** 落盘失败（权限 / 磁盘满 / rename 跨设备） */
    | 'attachment/write-failed'
    /** 读回失败（文件消失、权限变了、内容被改短） */
    | 'attachment/read-failed'
    /** 外部塞进来的 ref 形状不对（从 db / RPC 读回来的都要过 parseAttachmentRef） */
    | 'attachment/ref-invalid';

/** 本包唯一错误类型：带 `code`（机器判据）与 `detail`（可定位到路径） */
export class AttachmentError extends Error {
    readonly code: AttachmentErrorCode;
    readonly detail: string;

    constructor(code: AttachmentErrorCode, message: string, detail = '') {
        super(detail === '' ? `${code}: ${message}` : `${code} @ ${detail}: ${message}`);
        this.name = 'AttachmentError';
        this.code = code;
        this.detail = detail;
    }
}
