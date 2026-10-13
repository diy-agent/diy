// serialize.ts — JSON 序列化 / 反序列化（存储层的唯一出入口）
//
// 约定：
// - 序列化前**先校验并规范化**（`parse*`）⇒ 输出键序固定、字段封闭，落盘即稳定文本，diff 友好；
// - 反序列化同样走 `parse*` ⇒ 读进来的东西一律可信，非法输入抛 `TalkError`（不静默丢弃）。
//
// 本包不做存储（不碰 fs / 不认识 task 目录）：落地格式与位置、版本化归宿主接入（##319）。

import { parseEvent, type Event } from './event';
import { TalkError } from './errors';
import { parseReaction, parseThread, type Reaction } from './reaction';

function stringify(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

function revive<T>(json: string, path: string, parse: (value: unknown, path: string) => T): T {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch (e) {
        throw new TalkError('invalid-json', e instanceof Error ? e.message : String(e), path);
    }
    return parse(raw, path);
}

export function eventToJson(event: Event): string {
    return stringify(parseEvent(event, 'event'));
}

export function eventFromJson(json: string): Event {
    return revive(json, 'event', parseEvent);
}

export function reactionToJson(reaction: Reaction): string {
    return stringify(parseReaction(reaction, 'reaction'));
}

export function reactionFromJson(json: string): Reaction {
    return revive(json, 'reaction', parseReaction);
}

/** 整条 thread 落盘（顺带做引用完整性校验：悬空 replyTo 在写侧就拦下） */
export function threadToJson(reactions: readonly Reaction[]): string {
    return stringify(parseThread(reactions, 'thread'));
}

export function threadFromJson(json: string): Reaction[] {
    return revive(json, 'thread', parseThread);
}
