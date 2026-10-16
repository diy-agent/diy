// reaction.ts — 反应原语：针对某个锚点的一次发言（##166 §一 结论 10）
//
//   Reaction { id, author, turnId, target, replyTo, content, at }
//
// 与 Event 的关系：`Reaction` 是**对话侧的特化**（多一个 `turnId`，且带结构化回复链
// `replyTo`）；`Event` 是**容器无关的泛化**（多一个 `causes`，为工作流的「触发谁」准备）。
// `Reaction` 可**单向**投影为 `Event`（丢掉 `turnId` 与回复链 `replyTo`）；反向不成立 ——
// `Event` 没有 `turnId` 无从补。故两者并存而非合成一个类型（review2 意见 6 修正措辞）。
//
// replyTo 为什么必须是 id 而不是「R21」这种字符串（##166 §7.4 痛点 2）：
// 案例里轮次靠肉眼对齐编号 → 人被迫纠正「最后一条是 R19，不是你说的 R21」。
// **寻址结构化 = 引 id；引 id 才能被机器校验（悬空即报错），引文字只能靠人对齐。**

import { parseAnchor, type Anchor } from './anchor';
import { TalkError } from './errors';
import {
    rejectUnknown,
    takeIsoString,
    takeNullableString,
    takeObject,
    takeString,
    type ParseOptions,
} from './validate';

export interface Reaction {
    readonly id: string;
    /** 发言者：agent id / `human` */
    readonly author: string;
    /** 该发言所属的轮次 id（turnId）——「同一轮里说了几句」靠它聚拢 */
    readonly turnId: string;
    /** 针对什么发言（锚点原语；模式 1/2 用 `message`，模式 3 用 `doc-range`） */
    readonly target: Anchor;
    /** 结构化寻址：回复的是本 thread 内哪条发言的 id；`null` = 起头，不回复任何人（必须显式出现） */
    readonly replyTo: string | null;
    /** 正文 */
    readonly content: string;
    /** 由调用方传入的 ISO-8601 字符串（本包不取时间） */
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
const REACTION_KEYS = ['id', 'author', 'turnId', 'target', 'replyTo', 'content', 'at'] as const;

/**
 * 校验并规范化单条反应；非法一律抛 `invalid-reaction`（带点路径）。
 * `replyTo` **必须显式出现**（review2 意见 3）：键缺失 = 丢回复链，绝不允许被静默当成「起头」；
 * 显式 `null` 才是「这条发言起头」的唯一表示。
 */
export function parseReaction(value: unknown, path = 'reaction', options: ParseOptions = {}): Reaction {
    const obj = takeObject(value, path, CODE);
    if (!options.allowUnknown) rejectUnknown(obj, REACTION_KEYS, path, CODE);
    if (!('replyTo' in obj)) {
        throw new TalkError(CODE, '缺少 replyTo 键（起头发言须显式写 null，避免回复链被静默丢弃）', `${path}.replyTo`);
    }
    return {
        id: takeString(obj.id, `${path}.id`, CODE),
        author: takeString(obj.author, `${path}.author`, CODE),
        turnId: takeString(obj.turnId, `${path}.turnId`, CODE),
        target: parseAnchor(obj.target, `${path}.target`, options),
        replyTo: takeNullableString(obj.replyTo, `${path}.replyTo`, CODE),
        content: takeString(obj.content, `${path}.content`, CODE, true),
        at: takeIsoString(obj.at, `${path}.at`, CODE),
    };
}

/** 锚点规范化后的等值判据（键序固定 ⇒ 可直接比字符串） */
function sameAnchor(a: Anchor, b: Anchor): boolean {
    return JSON.stringify(parseAnchor(a)) === JSON.stringify(parseAnchor(b));
}

/**
 * 校验一个 thread 的结构约束（thread = **同一锚点下的**发言集合）：
 * 0. 每条元素须是合法 `Reaction`（入口自检，review3 意见 3）：与其它入口同口径 ——
 *    `replyTo` 类型错之类在这里报精确的 `invalid-reaction`，而不是被下游误报成 `dangling-reply`；
 *    只有 `parseReaction` 的产物才保证「结构错 = 结构错、类型错 = 类型错」可区分。
 * 1. `id` 在本 thread 内唯一（重复 → `duplicate-id`）；
 * 2. 非 null 的 `replyTo` 必须指向本 thread 内**另一条** id（不存在或指向自己 → `dangling-reply`）；
 * 3. 所有发言的 `target` 必须**同锚点**（不一致 → `mixed-anchor`，review2 意见 2）——
 *    否则「所有不同对象的争论全串在一条时间线上」在存储层就已合法（##166 §7.4 痛点 4）。
 *
 * 这三条是「决策线可追溯」在存储层的护栏：编号幻觉与覆盖丢失在这里就报错，
 * 不必等到装配出来的历史缺一条反驳才被发现（##166 §7.4 痛点 1/2/7）。
 *
 * 入参可为已 `parse` 过的 `Reaction[]`，也可为裸对象数组 —— 每条先经 `parseReaction` 自检
 * （已解析对象重解析是幂等的），故调用方无需先自行 parse。
 */
export function assertThreadRefs(reactions: readonly Reaction[]): void {
    // 入口自检（review3 意见 3）：把元素规整为可信 Reaction —— 类型错在此报 invalid-reaction，
    // 后续结构检查因此只可能在「结构」上失败（不再把类型错误报为 dangling-reply）。
    const parsed = reactions.map((reaction, i) => parseReaction(reaction, `[${i}]`));
    const seen = new Set<string>();
    parsed.forEach((reaction, i) => {
        if (seen.has(reaction.id)) {
            throw new TalkError('duplicate-id', `thread 内 id 重复：${reaction.id}`, `[${i}].id`);
        }
        seen.add(reaction.id);
    });
    parsed.forEach((reaction, i) => {
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
    const first = parsed[0];
    if (first === undefined) return;
    parsed.forEach((reaction, i) => {
        if (!sameAnchor(reaction.target, first.target)) {
            throw new TalkError(
                'mixed-anchor',
                `thread 内锚点不一致：thread 是「同一锚点下的发言集合」（第 0 条为 ${first.target.type}，本条为 ${reaction.target.type}）`,
                `[${i}].target`,
            );
        }
    });
}

/** 校验并规范化整条 thread（每条反应 + 引用完整性 + 同锚点），返回规范化后的新数组 */
export function parseThread(value: unknown, path = 'thread', options: ParseOptions = {}): Reaction[] {
    if (!Array.isArray(value)) throw new TalkError(CODE, '应为反应数组', path);
    const reactions = value.map((item, i) => parseReaction(item, `${path}[${i}]`, options));
    assertThreadRefs(reactions);
    return reactions;
}
