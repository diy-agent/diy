// errors.ts — @diy/talk 统一错误类型
//
// 设计要点（沿用 @diy/template 的教训）：**任何一条诊断都不允许降级为静默丢弃**。
// 悬空 replyTo 若被静默忽略，装配出来的历史就少一条反驳 —— 而「少一条反驳」正是
// 决策线断掉最难发现的失败形态（##166 §7.4 痛点 2：轮次靠肉眼对齐会幻觉）。

/** 错误分类（UI / 测试 / 宿主按此判断处置方式） */
export type TalkErrorCode =
    /** 反序列化输入不是合法 JSON */
    | 'invalid-json'
    /** 锚点非法：未知 type、缺 data、字段类型不对、offset 非非负整数 */
    | 'invalid-anchor'
    /** 事件字段非法（id / author / content / at 非非空字符串，causes 非字符串数组） */
    | 'invalid-event'
    /** 反应字段非法（含 replyTo 非 string | null） */
    | 'invalid-reaction'
    /** 同一 thread 内 id 重复（结构化寻址的前提是 id 唯一） */
    | 'duplicate-id'
    /** replyTo 指向本 thread 内不存在的 id（或指向自己） */
    | 'dangling-reply'
    /** 违反 role 铁律：他人发言被装配成 assistant，或他人 tool/thinking 进入装配 */
    | 'role-violation';

/** 本包唯一错误类型：带 `code`（机器判据）与 `path`（从根到字段的点路径，如 `event.anchor.data.offset`） */
export class TalkError extends Error {
    readonly code: TalkErrorCode;
    /** 出错位置的点路径；空串表示整体 */
    readonly path: string;

    constructor(code: TalkErrorCode, message: string, path = '') {
        super(path === '' ? `${code}: ${message}` : `${code} @ ${path}: ${message}`);
        this.name = 'TalkError';
        this.code = code;
        this.path = path;
    }
}
