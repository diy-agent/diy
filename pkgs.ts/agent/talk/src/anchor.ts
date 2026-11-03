// anchor.ts — 锚点原语：一条发言 / 一个事件「指向哪」
//
// 依据 ##166 §一 结论 10 + §10.2：锚点是**两个容器的共用轴** ——
//   对话容器：`message`（某条消息）· `doc-range`（文档某段）· `task-field`（任务某字段）
//   工作流容器：`node`（泳道节点；一条打回边也用节点 id 指，见 §11.1）
// 「选锚点类型」而不是「选容器实现」，就是三模式/两容器能共用一套原语的原因。
//
// 形状遵循仓库 rule.discriminated-union：判别键 `type` 同级只放**所有分支共有**的字段，
// 分支私有数据进 `data`。锚点没有公共字段 ⇒ 每个分支就是 `{ type, data }`。

import { TalkError } from './errors.js';
import { rejectUnknown, takeObject, takeOffset, takeString, type ParseOptions } from './validate.js';

/** 合法锚点类型全集（引擎枚举；新增类型 = 改代码 + 发版，不做行业自定义，见 ##166 §13.2） */
export const ANCHOR_TYPES = ['message', 'doc-range', 'task-field', 'node'] as const;
export type AnchorType = (typeof ANCHOR_TYPES)[number];

/** 指向「某条消息」（对话容器：模式 1 / 2） */
export interface MessageAnchorData {
    readonly messageId: string;
}

/** 指向「文档的某一段」（对话容器：模式 3）—— **必须钉住 revision** */
export interface DocRangeAnchorData {
    /** 所钉的修订 id。**只存 offset 会随正文漂移**（##166 §一 结论 11），故 revision 是必填 */
    readonly revisionId: string;
    /** 相对该修订正文的字符偏移（非负整数） */
    readonly offset: number;
    /** 该修订里的原文摘录；正文改版后由装配 / 宿主侧用它做 fuzzy 校正，offset 漂了也能找回 */
    readonly quote: string;
}

/** 指向「任务详情的某个字段」（如 `title` / `body` / `state`） */
export interface TaskFieldAnchorData {
    readonly field: string;
}

/** 指向「工作流的一条泳道节点」（##166 §10.2：anchor 加一个 `node` 即覆盖工作流容器） */
export interface NodeAnchorData {
    readonly nodeId: string;
}

/** 锚点 = `{ type, data }`（判别键同级无公共字段，故只有这两个键） */
export type Anchor =
    | { readonly type: 'message'; readonly data: MessageAnchorData }
    | { readonly type: 'doc-range'; readonly data: DocRangeAnchorData }
    | { readonly type: 'task-field'; readonly data: TaskFieldAnchorData }
    | { readonly type: 'node'; readonly data: NodeAnchorData };

// 构造器一律**自检**（review2 意见 5）：与 createEvent / createReaction 同口径 ——
// 形状不对立即报错，而不是返回一个 `isAnchor === false` 的「Anchor」假信号。
export function messageAnchor(messageId: string): Anchor {
    return parseAnchor({ type: 'message', data: { messageId } });
}

/** doc-range 构造器：三个字段都是必填 —— 少一个就不叫「钉住 revision」 */
export function docRangeAnchor(revisionId: string, offset: number, quote: string): Anchor {
    return parseAnchor({ type: 'doc-range', data: { revisionId, offset, quote } });
}

export function taskFieldAnchor(field: string): Anchor {
    return parseAnchor({ type: 'task-field', data: { field } });
}

export function nodeAnchor(nodeId: string): Anchor {
    return parseAnchor({ type: 'node', data: { nodeId } });
}

const CODE = 'invalid-anchor' as const;

const ANCHOR_KEYS = ['type', 'data'] as const;
const DATA_KEYS: Record<AnchorType, readonly string[]> = {
    message: ['messageId'],
    'doc-range': ['revisionId', 'offset', 'quote'],
    'task-field': ['field'],
    node: ['nodeId'],
};

/** 校验并规范化锚点（只保留已知字段，键序固定）；非法一律抛 `invalid-anchor`（带点路径） */
export function parseAnchor(value: unknown, path = 'anchor', options: ParseOptions = {}): Anchor {
    const obj = takeObject(value, path, CODE);
    if (!options.allowUnknown) rejectUnknown(obj, ANCHOR_KEYS, path, CODE);
    const type = obj.type;
    if (typeof type !== 'string' || !(ANCHOR_TYPES as readonly string[]).includes(type)) {
        throw new TalkError(CODE, `未知锚点类型 ${JSON.stringify(type)}（合法：${ANCHOR_TYPES.join(' | ')}）`, `${path}.type`);
    }
    const data = takeObject(obj.data, `${path}.data`, CODE);
    if (!options.allowUnknown) rejectUnknown(data, DATA_KEYS[type as AnchorType], `${path}.data`, CODE);
    switch (type as AnchorType) {
        case 'message':
            return { type: 'message', data: { messageId: takeString(data.messageId, `${path}.data.messageId`, CODE) } };
        case 'doc-range':
            return {
                type: 'doc-range',
                data: {
                    revisionId: takeString(data.revisionId, `${path}.data.revisionId`, CODE),
                    offset: takeOffset(data.offset, `${path}.data.offset`, CODE),
                    quote: takeString(data.quote, `${path}.data.quote`, CODE),
                },
            };
        case 'task-field':
            return { type: 'task-field', data: { field: takeString(data.field, `${path}.data.field`, CODE) } };
        case 'node':
            return { type: 'node', data: { nodeId: takeString(data.nodeId, `${path}.data.nodeId`, CODE) } };
    }
}

/** 非抛出版校验（给 UI / 反序列化前的猜测试探用） */
export function isAnchor(value: unknown): value is Anchor {
    try {
        parseAnchor(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * 该锚点是否钉在给定修订上（review2 意见 1：三态，不再把「不在修订轴」静默当成 true）。
 * - `true`  = 是 `doc-range` 且 revisionId 相同；
 * - `false` = 是 `doc-range` 但 revisionId 不同；
 * - `null`  = 该锚点**不参与修订轴**（message / task-field / node），调用方必须显式处理。
 *
 * 旧名 `isOnRevision` 对非 doc-range 恒返回 true，会被误当「本修订批注」过滤器用
 * （`anchors.filter(isOnRevision)` 把三种非文档锚点全纳入）—— 这正是它被改成三态的原因。
 */
export function pinsRevision(anchor: Anchor, revisionId: string): boolean | null {
    if (anchor.type !== 'doc-range') return null;
    return anchor.data.revisionId === revisionId;
}
