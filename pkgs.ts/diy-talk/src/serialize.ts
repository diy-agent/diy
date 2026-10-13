// serialize.ts — JSON 序列化 / 反序列化（存储层的规范化出入口）
//
// 约定：
// - 序列化前**先校验并规范化**（`parse*`）⇒ 输出键序固定、字段封闭，落盘即稳定文本，diff 友好；
//   **写侧同样严格**（未知字段报错，review2 意见 4）—— 绝不静默抹掉调用方传进来的数据。
// - 反序列化同样走 `parse*` ⇒ 读进来的东西一律可信，非法输入抛 `TalkError`（不静默丢弃）；
//   读侧若需前向兼容（新版本加的字段），显式传 `{ allowUnknown: true }`。
//
// 落地格式（缩进多行 vs 单行 jsonl）由宿主决定（review1 意见 4）：
// `*ToJson` 缺省输出缩进多行（人读 / diff 友好）；传 `{ compact: true }` 输出紧凑单行，
// 供 ##319 拼 jsonl（每行一条记录）。
//
// 本包不做存储（不碰 fs / 不认识 task 目录）：落地位置与版本化归宿主接入（##319）。

import { parseEvent, type Event } from './event';
import { TalkError } from './errors';
import { parseReaction, parseThread, type Reaction } from './reaction';
import type { ParseOptions } from './validate';

/** 序列化选项：`compact` 输出紧凑单行（jsonl 用），缺省缩进多行 */
export interface SerializeOptions {
    readonly compact?: boolean;
}

function stringify(value: unknown, compact = false): string {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

function revive<T>(
    json: string,
    path: string,
    parse: (value: unknown, path: string, options: ParseOptions) => T,
    options: ParseOptions,
): T {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch (e) {
        throw new TalkError('invalid-json', e instanceof Error ? e.message : String(e), path);
    }
    return parse(raw, path, options);
}

export function eventToJson(event: Event, options: SerializeOptions = {}): string {
    return stringify(parseEvent(event, 'event'), options.compact);
}

export function eventFromJson(json: string, options: ParseOptions = {}): Event {
    return revive(json, 'event', parseEvent, options);
}

export function reactionToJson(reaction: Reaction, options: SerializeOptions = {}): string {
    return stringify(parseReaction(reaction, 'reaction'), options.compact);
}

export function reactionFromJson(json: string, options: ParseOptions = {}): Reaction {
    return revive(json, 'reaction', parseReaction, options);
}

/** 整条 thread 落盘（顺带做引用完整性 + 同锚点校验：写侧就拦下坏数据） */
export function threadToJson(reactions: readonly Reaction[], options: SerializeOptions = {}): string {
    return stringify(parseThread(reactions, 'thread'), options.compact);
}

export function threadFromJson(json: string, options: ParseOptions = {}): Reaction[] {
    return revive(json, 'thread', parseThread, options);
}
