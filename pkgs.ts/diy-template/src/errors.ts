// errors.ts — 模版引擎统一错误类型
//
// 设计要点：**任何一条诊断都不允许降级为静默空串**。
// 参考教训：Mustache 的未知名 section 会静默渲染为空（实测），
// 于是「条件名打错一个字母」= 那段永远不进请求且没有任何报错。

/** 错误分类（UI / 测试按此判断处置方式） */
export type TemplateErrorCode =
    /** 词法/语法：未闭合标签、未闭合插值、非法插值内容、非法绑定、未知控制属性 */
    | 'syntax'
    /** 路径首段在 globals 与动态作用域里都不存在（字段缺失不报错，首段不存在才报错） */
    | 'unresolved-path'
    /** include 传了被调模版从未引用的参数（能抓住 :iff 这类拼错） */
    | 'unknown-arg'
    /** include 少了被调模版引用的参数（静态预检，比渲染时才炸清楚） */
    | 'missing-arg'
    /** 插值取了 undefined / null（可选值必须用 :if 守住，不允许静默输出空串） */
    | 'missing-value'
    /** include 路径非法（非 ./ 开头、含 ..、绝对路径）或模版不存在/不在白名单 */
    | 'include'
    /** include 循环引用 */
    | 'include-cycle'
    /** include 深度超限 */
    | 'depth'
    /** :for 的数据源不是数组 */
    | 'not-iterable'
    /** include 了锁定模版（调用者自身也可覆盖） */
    | 'locked';

/** 源码位置（1-based 行列 + 0-based 偏移），用于 UI 定位 */
export interface Loc {
    line: number;
    col: number;
    offset: number;
}

export interface TemplateErrorInit {
    /** 模版 relpath（宿主传入，便于跨文件定位） */
    file?: string;
    /** 附加上下文，如 include 链、被调模版名、该模版实际引用了哪些动态名 */
    detail?: string;
}

export class TemplateError extends Error {
    readonly code: TemplateErrorCode;
    readonly line: number;
    readonly col: number;
    readonly offset: number;
    readonly file: string | undefined;
    readonly detail: string | undefined;

    constructor(code: TemplateErrorCode, message: string, loc: Loc, init: TemplateErrorInit = {}) {
        const where = init.file ? `${init.file}:${loc.line}:${loc.col}` : `${loc.line}:${loc.col}`;
        super(`${message} (${where})`);
        this.name = 'TemplateError';
        this.code = code;
        this.line = loc.line;
        this.col = loc.col;
        this.offset = loc.offset;
        this.file = init.file;
        this.detail = init.detail;
    }

    /** 多行诊断（试验场/日志展示用） */
    format(): string {
        const parts = [`[${this.code}] ${this.message}`];
        if (this.detail) parts.push(`  ↳ ${this.detail}`);
        return parts.join('\n');
    }
}
