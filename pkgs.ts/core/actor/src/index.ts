// @diy-agent/actor — actor 协议内核（**不依赖 @diy-agent/rpc**，零 IO、零全局状态）。
//
// 一个实例 = 一个 actor：所有会动状态的操作排成一条队列，一次跑一个。
// 对外只有三个动词：`cmd`（写）/ `query`（读）/ `watch`（事件流）。
//
// 分层（对应 docs/ 里的篇目）：
//   wire.ts       帧口径：两层结构 + 两条轴（执行轴 `type` / 业务轴 `data`）   → docs/02-wire.md
//   kinds.ts      声明：state / commands / queries / events                    → docs/03-kinds.md
//   runtime.ts    执行：串行队列 / 幂等 / 事件提交 / 扇出                       → docs/04-runtime.md
//   fanout.ts     多目标扇出：逐项结果 + 执行回执（**没有 partial**）           → docs/05-multi-target.md
//   journal.ts    存储接口（事件日志 + 快照）+ 内存实现                          → docs/04-runtime.md
//   transport.ts  链路接口 + 进程内实现（ws/http 适配器在别的包里）             → docs/06-transport.md
//   client.ts     调用方 raw 层：三个动词 + Outcome 判别联合，不抛异常            → docs/06-transport.md
//   api.ts        调用方函数层：契约 → 静态类型方法，得值、失败抛                   → docs/06-transport.md
//   local.ts      进程内接线（测试 / 文档示例跑的就是这条路径）

export { ActorError, ACTOR_CODES, toActorError, type ActorCode } from './errors.js';

export {
    useKind,
    type Accepted,
    type BoundActor,
    type CmdMethod,
    type CmdValue,
    type EventOf,
    type QueryMethod,
} from './api.js';

export {
    ActorCodeSchema,
    CmdFrameSchema,
    CommandIdSchema,
    ConsistencySchema,
    CURSOR_ZERO,
    CursorSchema,
    COMMAND_FINISHED,
    COMMAND_STATUS,
    compareCursor,
    decodeFrame,
    DoneFrameSchema,
    encodeFrame,
    ErrFrameSchema,
    EVENTS,
    EventFrameSchema,
    FAULT,
    FrameSchema,
    isInbound,
    isOutbound,
    MetaSchema,
    newCommandId,
    newRequestId,
    OkFrameSchema,
    QueryFrameSchema,
    AcceptedFrameSchema,
    RejectedFrameSchema,
    RESERVED_NAMES,
    RESERVED_PREFIX,
    TargetSchema,
    type AcceptedFrame,
    type CmdFrame,
    type CommandId,
    type Consistency,
    type Cursor,
    type DecodeResult,
    type DoneFrame,
    type ErrFrame,
    type EventFrame,
    type FanoutReceipt,
    type Frame,
    type FrameOf,
    type FrameType,
    type Meta,
    type OkFrame,
    type QueryFrame,
    type RejectedFrame,
    type RequestId,
    type Target,
} from './wire.js';

export {
    defineKind,
    KindBuilder,
    type AggregateArgs,
    type CmdInput,
    type CmdMode,
    type CmdNames,
    type CmdOutput,
    type CommandContext,
    type CommandDef,
    type CommandMode,
    type CommandResult,
    type Effects,
    type EventData,
    type EventNames,
    type EventRecord,
    type FanoutSpec,
    type Kind,
    type KindInit,
    type KindSeed,
    type QueryContext,
    type QueryDef,
    type QueryInput,
    type QueryNames,
    type QueryOutput,
    type StateOf,
} from './kinds.js';

export {
    createMemoryStore,
    type ActorStore,
    type JournalEntry,
    type NewEntry,
    type ReadOptions,
    type Snapshot,
} from './journal.js';

export {
    allFailed,
    mapEach,
    runFanout,
    type FanoutPort,
    type PerTarget,
    type RunFanoutArgs,
    type RunFanoutResult,
} from './fanout.js';

export { Actor, createActor, type ActorRuntime, type CreateActorOptions } from './runtime.js';

export {
    ActorClient,
    createClient,
    expect,
    type CmdOptions,
    type CmdOutcome,
    type ClientOptions,
    type QueryOptions,
    type QueryOutcome,
    type RequestOptions,
    type WatchOptions,
} from './client.js';

export { createInProcessPair, frameLink, type Link, type LinkPair, type TextLink } from './transport.js';

export { createLocalActor, createLocalPort, type LocalActorHandle, type LocalActorOptions } from './local.js';
