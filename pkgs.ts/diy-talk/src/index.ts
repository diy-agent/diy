// @diy/talk — diy 对话容器内核：事件 / 锚点 / 反应原语 + role 翻译铁律
//
// 零依赖、纯 TypeScript：不 import `node:fs` / `electron` / `@diy/app`，**不取时间**
// （`at` 由调用方传入）。因此现在就能拆成单独项目（##311 §四）。
//
//   import { createReaction, docRangeAnchor, assertThreadRefs, assemblyRole } from '@diy/talk';
//
//   const target = docRangeAnchor('rev-7', 31 * 40, '此处有问题');   // 钉 revision
//   const a = createReaction({ id: 'r1', author: 'b', turnId: 't1', target,
//                              content: '该段漏了并发写保护', at: '2026-10-13T00:00:00.000Z' });
//   const b = createReaction({ id: 'r2', author: 'c', turnId: 't1', target, replyTo: 'r1',
//                              content: '同意，且需要补锁', at: '2026-10-13T00:00:05.000Z' });
//   assertThreadRefs([a, b]);                                 // 悬空 replyTo / 异锚点在这里报错
//   assemblyRole({ kind: 'speech', author: 'b', self: 'a' }); // => 'user'（绝不是 'assistant'）
//
// 形状速览（详见 SPEC.md；需求真源是 tests/intent.talk.test.ts 的 R1–R7）：
//   Anchor   = { type: 'message' | 'doc-range' | 'task-field' | 'node', data }
//              doc-range.data = { revisionId, offset, quote }   ← 钉住修订，offset 漂了靠 quote 找回
//   Event    = { id, author, anchor, content, causes, at }        ← 容器无关的泛化记录（工作流也用）
//   Reaction = { id, author, turnId, target, replyTo, content, at } ← 对话侧特化，replyTo 是结构化寻址
//   role     = 自己的内容 assistant；他人发言 / 资料 user（铁律：他人发言绝不能是 assistant）
//
// 装配（##314）：`assemble({ sources, strategy, window, selfId }) → Message[]` ——
// 多源 + 投影 + 窗口 装配成一次 LLM 请求；三内置策略 `full` / `text-only` / `changes-only`。
//
// 边界：本包**不做存储、不碰 LLM SDK**（不 import node:fs / electron / @diy/app，不拼 prompt 的具体 SDK 形状）——
// 工作流容器归 ##313，落地格式与宿主接入归 ##319。

export { TalkError } from './errors';
export type { TalkErrorCode } from './errors';

export {
    ANCHOR_TYPES,
    docRangeAnchor,
    isAnchor,
    messageAnchor,
    nodeAnchor,
    parseAnchor,
    pinsRevision,
    taskFieldAnchor,
} from './anchor';
export type {
    Anchor,
    AnchorType,
    DocRangeAnchorData,
    MessageAnchorData,
    NodeAnchorData,
    TaskFieldAnchorData,
} from './anchor';

export { createEvent, isEvent, parseEvent } from './event';
export type { Event, EventInit } from './event';

export { assertThreadRefs, createReaction, parseReaction, parseThread } from './reaction';
export type { Reaction, ReactionInit } from './reaction';

export { assemblyRole, assertRoleAssignments, SOURCE_KINDS } from './role';
export type { AssemblyRole, RoleAssignment, RoleInput, SourceKind } from './role';

export {
    assemble,
    parseSource,
    renderItem,
    resolveStrategy,
    CHANGES_ONLY,
    FULL,
    SOURCE_TYPES,
    STRATEGIES,
    STRATEGY_NAMES,
    TEXT_ONLY,
} from './assemble';
export type {
    AssembleInput,
    AssemblyItem,
    AssemblyStrategy,
    Message,
    Source,
    SourceType,
    StrategyContext,
    StrategyName,
    WindowHook,
} from './assemble';

export { eventFromJson, eventToJson, reactionFromJson, reactionToJson, threadFromJson, threadToJson } from './serialize';
export type { SerializeOptions } from './serialize';

export type { ParseOptions } from './validate';
