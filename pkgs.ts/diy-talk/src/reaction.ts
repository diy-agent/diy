// reaction.ts — 反应原语：针对某个锚点的一次发言（##166 §一 结论 10）
//
//   Reaction { id, author, turnId, target, replyTo, content, at }
//
// 与 Event 的关系：`Reaction` 是**对话侧的特化**（多一个 `turnId`，且带结构化回复链
// `replyTo`）；`Event` 是**容器无关的泛化**（多一个 `causes`，为工作流的「触发谁」准备）。
// 两者字段同源（id / author / anchor / content / at 一一对应），故可互相投影，不必二选一。
//
// replyTo 为什么必须是 id 而不是「R21」这种字符串（##166 §7.4 痛点 2）：
// 案例里轮次靠肉眼对齐编号 → 人被迫纠正「最后一条是 R19，不是你说的 R21」。
// **寻址结构化 = 引 id；引 id 才能被机器校验（悬空即报错），引文字只能靠人对齐。**

import { parseAnchor, type Anchor } from './anchor';
import { TalkError } from './errors';
import { takeNullableString, takeObject, takeString } from './validate';

export interface Reaction {
    readonly id: string;
    /** 发言者：agent id / `human` */
    readonly author: string;
    /** 该发言所属的轮次 id（turnId）——「同一轮里说了几句」靠它聚拢 */
    readonly turnId: string;
    /** 针对什么发言（锚点原语；模式 1/2 用 `message`，模式 3 用 `doc-range`） */
    readonly target: Anchor;
    /** 结构化寻址：回复的是本 thread 内哪条发言的 id；`null` = 起头，不回复任何人 */
    readonly replyTo: string | null;
    /** 正文 */
    readonly content: string;
    /** 由调用方传入的 ISO 字符串（本包不取时间） */
    readonly at: string;
}

export interface ReactionInit {
    id: string;
    author: string;
    turnId: string;
    target: Anchor;
    /** 缺省 `null` */
    replyTo?: string | null;
    content: string;
    at: string;
}

export function createReaction(init: ReactionInit): Reaction {
    return parseReaction({ ...init, replyTo: init.replyTo ?? null }, 'reaction');
}

const CODE = 'invalid-reaction' as const;

/** 校验并规范化单条反应；非法一律抛 `invalid-reaction`（带点路径） */
export function parseReaction(value: unknown, path = 'reaction'): Reaction {
    const obj = takeObject(value, path, CODE);
    return {
        id: takeString(obj.id, `${path}.id`, CODE),
        author: takeString(obj.author, `${path}.author`, CODE),
        turnId: takeString(obj.turnId, `${path}.turnId`, CODE),
        target: parseAnchor(obj.target, `${path}.target`),
        replyTo: takeNullableString(obj.replyTo, `${path}.replyTo`, CODE),
        content: takeString(obj.content, `${path}.content`, CODE, true),
        at: takeString(obj.at, `${path}.at`, CODE),
    };
}

/**
 * 校验一个 thread（同一锚点下的发言集合）的两条结构约束：
 * 1. `id` 在本 thread 内唯一（重复 → `duplicate-id`）；
 * 2. 非 null 的 `replyTo` 必须指向本 thread 内**另一条** id（不存在或指向自己 → `dangling-reply`）。
 *
 * 这两条是「决策线可追溯」在存储层的护栏：编号幻觉与覆盖丢失在这里就报错，
 * 不必等到装配出来的历史缺一条反驳才被发现（##166 §7.4 痛点 1/2/7）。
 */
export function assertThreadRefs(reactions: readonly Reaction[]): void {
    const seen = new Set<string>();
    reactions.forEach((reaction, i) => {
        if (seen.has(reaction.id)) {
            throw new TalkError('duplicate-id', `thread 内 id 重复：${reaction.id}`, `[${i}].id`);
        }
        seen.add(reaction.id);
    });
    reactions.forEach((reaction, i) => {
        const replyTo = reaction.replyTo;
        if (replyTo === null) return;
        if (replyTo === reaction.id) {
            throw new TalkError('dangling-reply', `replyTo 指向自己：${replyTo}`, `[${i}].replyTo`);
        }
        if (!seen.has(replyTo)) {
            throw new TalkError(
                'dangling-reply',
                `replyTo 指向本 thread 内不存在的发言：${replyTo}（悬空引用）`,
                `[${i}].replyTo`,
            );
        }
    });
}

/** 校验并规范化整条 thread（每条反应 + 引用完整性），返回规范化后的新数组 */
export function parseThread(value: unknown, path = 'thread'): Reaction[] {
    if (!Array.isArray(value)) throw new TalkError(CODE, '应为反应数组', path);
    const reactions = value.map((item, i) => parseReaction(item, `${path}[${i}]`));
    assertThreadRefs(reactions);
    return reactions;
}
