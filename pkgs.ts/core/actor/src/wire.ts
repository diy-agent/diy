// wire.ts — 线上帧口径：**唯一真源**。传输层（进程内 / ws / http）只搬这里的对象，不许加字段。
//
// 结构恒为三层：
//
//   外层 frame   type + 关联(id / commandId) + 顺序(seq) + 新鲜度(watermark / stale)   ← runtime 独占，kind 不可见
//        ↓ 派发
//   name         kind 声明里的 key（方法名 / 事件名）                                  ← runtime 用它查声明
//        ↓ 业务
//   data                                                                              ← **kind 的 zod 只校验这一层**
//
// 判据一句话：**`data` 里只装 kind 声明过的东西；`data` 外面的一切都是 runtime 的。**
//
// 两条轴（docs/02-wire.md）：`type` 只说执行成了没有，业务结果一律在 `data` 里。
// 所以枚举里**没有** `partial` —— 已否决，理由见 docs/05-multi-target.md。

import { z } from 'zod';

import { ACTOR_CODES, type ActorCode } from './errors.js';

// ── 关联标识 ────────────────────────────────────────────────────────────────
// 三个 id 语义不同，混用会让重试/去重/续读全错：
//   RequestId   每次**尝试**唯一（在途匹配用，重试换新）
//   CommandId   跨重试**稳定**（去重表 + `$command.status` 的键）
//   Cursor      事件流位置（单调，`after` 的起点 / `watermark` 的取值）
type Brand<T, B extends string> = T & { readonly __brand: B };

export type RequestId = Brand<string, 'RequestId'>;
export type CommandId = Brand<string, 'CommandId'>;
export type Cursor = Brand<string, 'Cursor'>;

const nonEmpty = z.string().min(1);
const asBrand = <T>(schema: z.ZodType<string>) => schema as unknown as z.ZodType<T>;

export const RequestIdSchema = asBrand<RequestId>(nonEmpty);
export const CommandIdSchema = asBrand<CommandId>(nonEmpty);
export const CursorSchema = asBrand<Cursor>(nonEmpty);

/** 新请求 id（每次尝试一个） */
export function newRequestId(): RequestId {
    return `req_${globalThis.crypto.randomUUID()}` as RequestId;
}

/** 新命令 id（调用方生成；重试必须复用同一个） */
export function newCommandId(): CommandId {
    return `cmd_${globalThis.crypto.randomUUID()}` as CommandId;
}

/** 游标起点（还没有任何事件） */
export const CURSOR_ZERO = 'e0' as Cursor;

/**
 * 比游标。约定：内置 store 用 `e<十进制数>`，**只有**这种形态可比较；
 * 接入其它 store（db 序列号等）时必须保证同前缀 + 同宽度数字，否则要自己实现比较并注入。
 */
export function compareCursor(a: Cursor, b: Cursor): number {
    const na = Number.parseInt(a.slice(1), 10);
    const nb = Number.parseInt(b.slice(1), 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) return a < b ? -1 : a > b ? 1 : 0;
    return na - nb;
}

// ── 执行轴 code ────────────────────────────────────────────────────────────
export const ActorCodeSchema = z.enum(ACTOR_CODES) as unknown as z.ZodType<ActorCode>;

// ── 一致性 ──────────────────────────────────────────────────────────────────
// 声明给**下限**，调用方只能升不能降：
//   projection  投影可能慢半拍（默认；UI 渲染用）
//   owner       至少追到 owner 当前的位置（read-your-writes；CLI 两步式命令用）
export const ConsistencySchema = z.enum(['projection', 'owner']);
export type Consistency = z.infer<typeof ConsistencySchema>;

// ── 多目标扇出的执行回执 ────────────────────────────────────────────────────
// 只给重试与可观测性。**UI 不该读它**（读它 = 把 placement 又拖回渲染层），
// 业务状态一律从 `data` 读。见 docs/05-multi-target.md。
export const TargetSchema = z.object({
    /** 目标 actor 地址，如 `diy://node-b/task/t1` */
    target: z.string().min(1),
    /** 若这个 target 对应某个成员（roster / turn 场景），带上便于 UI 关联 */
    memberId: z.string().min(1).optional(),
});
export type Target = z.infer<typeof TargetSchema>;

export const FanoutReceiptSchema = z.object({
    target: z.string().min(1),
    ok: z.boolean(),
    code: ActorCodeSchema.optional(),
    ms: z.number().nonnegative(),
});
export type FanoutReceipt = z.infer<typeof FanoutReceiptSchema>;

export const MetaSchema = z.object({
    fanout: z.array(FanoutReceiptSchema).optional(),
});
export type Meta = z.infer<typeof MetaSchema>;

// ── 帧 ──────────────────────────────────────────────────────────────────────
// 方向是硬约束（`isInbound` / `isOutbound` 判），传错方向 = 协议违规，不是业务错。

/** 调用方 → actor：发起命令 */
export const CmdFrameSchema = z.object({
    type: z.literal('cmd'),
    id: RequestIdSchema,
    commandId: CommandIdSchema,
    name: z.string().min(1),
    data: z.unknown(),
});
export type CmdFrame = z.infer<typeof CmdFrameSchema>;

/** 调用方 → actor：发起查询 */
export const QueryFrameSchema = z.object({
    type: z.literal('query'),
    id: RequestIdSchema,
    name: z.string().min(1),
    data: z.unknown(),
    consistency: ConsistencySchema.optional(),
});
export type QueryFrame = z.infer<typeof QueryFrameSchema>;

/** actor → 调用方：命令已受理（长活还在跑，结果走 `$command.finished`） */
export const AcceptedFrameSchema = z.object({
    type: z.literal('accepted'),
    id: RequestIdSchema,
    commandId: CommandIdSchema,
    /** 受理点：其后的事件就是这个命令能产生的最早位置 */
    at: CursorSchema,
});
export type AcceptedFrame = z.infer<typeof AcceptedFrameSchema>;

/** actor → 调用方：命令跑完并已提交 */
export const DoneFrameSchema = z.object({
    type: z.literal('done'),
    id: RequestIdSchema,
    commandId: CommandIdSchema,
    data: z.unknown(),
    /** 提交后的事件流位置（`after: seq` 能读到这个命令产生的全部事件） */
    seq: CursorSchema,
});
export type DoneFrame = z.infer<typeof DoneFrameSchema>;

/** actor → 调用方：帧本身不成立（schema 不符 / 方法未声明 / 同 commandId 在途），**没进 handler** */
export const RejectedFrameSchema = z.object({
    type: z.literal('rejected'),
    id: RequestIdSchema,
    commandId: CommandIdSchema.optional(),
    code: ActorCodeSchema,
    message: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type RejectedFrame = z.infer<typeof RejectedFrameSchema>;

/** actor → 调用方：查询成功 */
export const OkFrameSchema = z.object({
    type: z.literal('ok'),
    id: RequestIdSchema,
    data: z.unknown(),
    /** 这份答案物化到了哪个事件位置 */
    watermark: CursorSchema,
    /** 投影慢半拍（`consistency: "owner"` 时为 false 或省略） */
    stale: z.boolean().optional(),
    meta: MetaSchema.optional(),
});
export type OkFrame = z.infer<typeof OkFrameSchema>;

/** actor → 调用方：查询/命令执行失败（handler 抛错，或依赖不可用） */
export const ErrFrameSchema = z.object({
    type: z.literal('err'),
    id: RequestIdSchema,
    code: ActorCodeSchema,
    message: z.string(),
    retryable: z.boolean().optional(),
    meta: MetaSchema.optional(),
});
export type ErrFrame = z.infer<typeof ErrFrameSchema>;

/** actor → 调用方：事件流推（业务事件与 `$` 事件同一个 `seq` 空间） */
export const EventFrameSchema = z.object({
    type: z.literal('event'),
    name: z.string().min(1),
    data: z.unknown(),
    seq: CursorSchema,
    at: z.number().int().nonnegative(),
    commandId: CommandIdSchema.optional(),
});
export type EventFrame = z.infer<typeof EventFrameSchema>;

export const FrameSchema = z.discriminatedUnion('type', [
    CmdFrameSchema,
    QueryFrameSchema,
    AcceptedFrameSchema,
    DoneFrameSchema,
    RejectedFrameSchema,
    OkFrameSchema,
    ErrFrameSchema,
    EventFrameSchema,
]);
export type Frame = z.infer<typeof FrameSchema>;

export type FrameType = Frame['type'];
export type FrameOf<T extends FrameType> = Extract<Frame, { type: T }>;

/** 调用方 → actor 的帧型（其余一律出向） */
const INBOUND: ReadonlySet<FrameType> = new Set<FrameType>(['cmd', 'query']);

export function isInbound(frame: Frame): frame is CmdFrame | QueryFrame {
    return INBOUND.has(frame.type);
}

export function isOutbound(frame: Frame): boolean {
    return !INBOUND.has(frame.type);
}

// ── `$` 保留名 ──────────────────────────────────────────────────────────────
// 带 `$` 的一律 runtime 自己服务，`defineKind` 拒绝业务占用（见 docs/03-kinds.md）。
export const RESERVED_PREFIX = '$';

/** 长活命令跑完后 runtime 自动发的事件（`commandId` 上是同一个） */
export const COMMAND_FINISHED = '$command.finished' as const;
/** 内置查询：命令状态（重开页面 / 换设备时的冷补） */
export const COMMAND_STATUS = '$command.status' as const;
/** 内置查询：读事件日志（`watch({ after })` 的补历史用） */
export const EVENTS = '$events' as const;
/** 内置事件：队列里某个后续工作单元失败（fire-and-forget 不能静默） */
export const FAULT = '$fault' as const;

export const RESERVED_NAMES: readonly string[] = [COMMAND_FINISHED, COMMAND_STATUS, EVENTS, FAULT];

// ── 编解码 ──────────────────────────────────────────────────────────────────
// 传输层只搬字符串：适配器（ws / http / stdio）不用知道帧长什么样。

export function encodeFrame(frame: Frame): string {
    return JSON.stringify(frame);
}

export type DecodeResult =
    | { ok: true; frame: Frame }
    | { ok: false; message: string; issues?: { path: string; message: string }[] };

export function decodeFrame(raw: string | unknown): DecodeResult {
    let value: unknown = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        } catch {
            return { ok: false, message: '帧不是合法 JSON' };
        }
    }
    const parsed = FrameSchema.safeParse(value);
    if (!parsed.success) {
        return {
            ok: false,
            message: '帧结构不符',
            issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        };
    }
    return { ok: true, frame: parsed.data as Frame };
}
