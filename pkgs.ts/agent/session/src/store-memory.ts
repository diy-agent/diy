// store-memory.ts — 纯内存 SessionStore：createSession 的**缺省**存储（##480）
//
// 方向（##480 用户裁决）：session 是「一次对话」，默认活在内存里；要不要持久化由**装配器**决定 ——
// 装配器要落盘就传一个 SessionStore 实例（如 `openJsonlSessionStore({ dir })`），
// 不传就用这里的实现。**没有策略枚举**：装配器直接构造调用，将来加远程 store 不用改任何分派逻辑。
//
// 与 jsonl 适配器同接口同判据（append 的 seq 必须连续、readFrom 不返回 ≤ seq 的），
// 区别有两处：
//   ① 没有文件系统 —— 本文件不许 import 任何 node:*（零落盘是编译期就能看出来的事实）；
//   ② **首批可以从中途 seq 开始**：本 store 是「跟着会话走」的，恢复截断过的历史时
//     第一批发言的 seq 就是中途的（如 41）；之后照样严格连续。

import { SessionError } from './errors.js';
import type { ChatMessage, SessionStore } from './types.js';

/** 缺省保留条数（只留最近这么多；更早的丢弃，但 latestSeq 不回退） */
export const DEFAULT_MAX_ENTRIES = 1000;

export interface MemorySessionStoreOptions {
    /** 最多保留多少条（正整数）；缺省 1000。超了从最旧的丢 */
    readonly maxEntries?: number;
}

/**
 * 内存存储：SessionStore + 一点排障用的只读视图。
 *
 * 方法签名**收窄成同步**（父接口允许 Promise）：内存实现天生同步，调用方不必 await ——
 * 这是与 jsonl 适配器唯一可见的差别（后者 IO 必须异步）。
 */
export interface MemorySessionStore extends SessionStore {
    /** 当前保留条数上界 */
    readonly maxEntries: number;
    /** 当前内存里的条数 */
    readonly size: number;
    append(messages: readonly ChatMessage[]): void;
    readFrom(seq: number): readonly ChatMessage[];
    readRange(range: { readonly from: number; readonly to: number }): readonly ChatMessage[];
    /** 最新 seq（没消息 = 0） */
    latestSeq(): number;
    /** 清空（试用性质的对话「重来」用）；lastSeq 一并归零 */
    clear(): void;
}

/** 建一个纯内存会话存储（不碰磁盘、不取时间） */
export function openMemorySessionStore(options: MemorySessionStoreOptions = {}): MemorySessionStore {
    if (typeof options !== 'object' || options === null) {
        throw new SessionError('store/invalid-options', 'openMemorySessionStore 需要对象参数', 'options');
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
        throw new SessionError(
            'store/invalid-options',
            `maxEntries 必须是正整数，拿到 ${String(maxEntries)}`,
            'maxEntries',
        );
    }

    let messages: ChatMessage[] = [];
    let lastSeq = 0;

    return {
        maxEntries,

        get size(): number {
            return messages.length;
        },

        append(batch: readonly ChatMessage[]): void {
            if (batch.length === 0) return;
            // 先全量校验再写入：半批进内存比不进更糟（水位会认为收到了）
            let expected = lastSeq === 0 ? batch[0]!.seq! - 1 : lastSeq;
            for (const message of batch) {
                if (message.seq === undefined) {
                    throw new SessionError(
                        'store/message-without-seq',
                        'append 的消息必须带 seq（core 会分配）',
                        'seq',
                    );
                }
                if (!Number.isInteger(message.seq) || message.seq <= 0) {
                    throw new SessionError('store/invalid-options', `seq 必须是正整数，拿到 ${String(message.seq)}`, 'seq');
                }
                if (message.seq !== expected + 1) {
                    throw new SessionError(
                        'store/gap',
                        `append 的 seq 必须连续：期望 ${expected + 1}，拿到 ${message.seq}`,
                        'seq',
                    );
                }
                expected = message.seq;
            }
            messages = [...messages, ...batch.map((message) => ({ ...message }))];
            lastSeq = expected;
            if (messages.length > maxEntries) {
                // 只从最旧的丢：seq 单调，读侧按 seq 取尾部仍然正确
                messages = messages.slice(messages.length - maxEntries);
            }
        },

        readFrom(seq: number): readonly ChatMessage[] {
            if (!Number.isInteger(seq) || seq < 0) {
                throw new SessionError(
                    'store/invalid-options',
                    `readFrom(seq) 的 seq 必须是非负整数，拿到 ${String(seq)}`,
                    'seq',
                );
            }
            return messages.filter((message) => (message.seq ?? 0) > seq).map((message) => ({ ...message }));
        },

        readRange(range: { readonly from: number; readonly to: number }): readonly ChatMessage[] {
            if (
                typeof range !== 'object' ||
                range === null ||
                !Number.isFinite(range.from) ||
                !Number.isFinite(range.to) ||
                range.from > range.to
            ) {
                throw new SessionError(
                    'store/invalid-options',
                    'readRange({from,to}) 需要 from ≤ to 的有限毫秒数',
                    'range',
                );
            }
            return messages
                .filter((message) => (message.at ?? 0) >= range.from && (message.at ?? 0) <= range.to)
                .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.seq ?? 0) - (b.seq ?? 0))
                .map((message) => ({ ...message }));
        },

        latestSeq(): number {
            return lastSeq;
        },

        clear(): void {
            messages = [];
            lastSeq = 0;
        },
    };
}
