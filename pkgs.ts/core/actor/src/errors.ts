// errors.ts — 执行轴错误码。
//
// 判据（见 docs/02-wire.md「两条轴」）：这里的**每一个** code 都在回答「这次调用跑成了没有」，
// 没有一个在回答「业务结果好不好」。所以没有 `E_PARTIAL`、没有 `E_MACHINE_STOPPED`：
// 一个 target 里某条目是什么状态，属于 `data`，由 kind 自己表达。
//
// `E_NOT_FOUND` 专指**收件人不存在**（target actor 找不到），不是「资源里没这条」。
// 后者是业务事实：`ok` + `data.items[i].state = "missing"`。

/** 执行轴错误码（线上是封闭枚举，新增要改协议） */
export const ACTOR_CODES = [
    /** 入参没过 zod：帧里的 `data` 与 kind 声明的 schema 不符 */
    'E_INVALID_ARGUMENT',
    /** actor 在，但没声明这个方法/事件 */
    'E_UNKNOWN_METHOD',
    /** 收件人不存在：target actor 找不到（找错了地址，不是资源里没有） */
    'E_NOT_FOUND',
    /** 依赖不可用：网络断 / 对端节点掉线 / 扇出全失败（一条答案都没拿到） */
    'E_UNAVAILABLE',
    'E_TIMEOUT',
    /** 乐观并发失败：读到的版本已过期 */
    'E_CONFLICT',
    'E_PERMISSION',
    'E_CANCELLED',
    /** handler 自己抛了非 ActorError 的异常 */
    'E_INTERNAL',
] as const;

export type ActorCode = (typeof ACTOR_CODES)[number];

/** handler 里主动抛这个来指定 code / 可重试性（不抛 = E_INTERNAL） */
export class ActorError extends Error {
    readonly code: ActorCode;
    readonly retryable: boolean;

    constructor(code: ActorCode, message: string, opts: { retryable?: boolean } = {}) {
        super(message);
        this.name = 'ActorError';
        this.code = code;
        // 缺省：网络/超时/冲突可重试，其余不可（重试同一份坏入参只是浪费一次往返）
        this.retryable = opts.retryable ?? (code === 'E_UNAVAILABLE' || code === 'E_TIMEOUT' || code === 'E_CONFLICT');
    }
}

/** 把 handler 里抛出的任意值归一成 ActorError（执行轴只认这一种） */
export function toActorError(err: unknown): ActorError {
    if (err instanceof ActorError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new ActorError('E_INTERNAL', message);
}
