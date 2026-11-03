// errors.ts — @diy-agent/session 统一错误类型
//
// 任何一条诊断都不降级为静默丢弃：非法消息 / 非法增量 / 并发发话一律抛带 code 的错误
// （判据见 rule.err-triage#code，`<域>/<kebab-case>`）。宿主按 code 决定处置方式。

/** 错误分类（UI / 测试 / 宿主按此判断处置方式） */
export type SessionErrorCode =
    /** createSession 入参非法（id 为空 / 缺 llm / store 形状不对） */
    | 'session/invalid-options'
    /** 消息字段非法（role 未知、content 非字符串、at 非 ISO-8601、未知字段） */
    | 'session/invalid-message'
    /** LlmPort 吐出的增量非法（未知 type、字段类型不对） */
    | 'session/invalid-delta'
    /** send() 的正文为空（没有可发给 LLM 的内容） */
    | 'session/empty-text'
    /** 上一轮还没结束就再次 send（一个会话同一时刻只有一轮） */
    | 'session/busy'
    /** 缺省内存存储的出入口参非法（maxEntries 非正整数 / seq 非法 / readRange 反向） */
    | 'store/invalid-options'
    /** 内存存储的 seq 不连续（缺号 / 重号）—— 与 jsonl 适配器同一判据，不静默丢数据 */
    | 'store/gap'
    /** append 的消息没有 seq（core 必然分配；到这里没有就是调用方绕过了 core） */
    | 'store/message-without-seq';

/** 本包唯一错误类型：带 `code`（机器判据）与 `path`（从根到字段的点路径） */
export class SessionError extends Error {
    readonly code: SessionErrorCode;
    /** 出错位置的点路径；空串表示整体 */
    readonly path: string;

    constructor(code: SessionErrorCode, message: string, path = '') {
        super(path === '' ? `${code}: ${message}` : `${code} @ ${path}: ${message}`);
        this.name = 'SessionError';
        this.code = code;
        this.path = path;
    }
}
