// room-log.ts —— 房间公共层（append-only 的内存日志）。
//
// 公共层只放"对所有人可见"的条目：人说的话、bot 的结论、通知。
// think / tool call / 中途草稿都不进这里 —— 那些是各 bot 自己 session 的私有内容。
//
// 关键约定：
//   · 日志只追加，**永不压缩、永不删除**；压缩发生在每个 session 内部，各压各的。
//   · 结论不会唤醒任何人，只是被复制进其他 bot 的 session（下一轮才生效）。
//   · 谁 @ 了谁决定唤醒，那是编排层的事，日志只记录事实。

import type { ModelMessage } from 'ai';

import type { AttachmentRef } from '@diy-agent/attachment/types';

import type { Author } from './types';

interface EntryBase {
    /** 单调递增，房间内唯一 */
    seq: number;
    at: number;
    turn?: number;
    turnId?: string;
}

export type RoomEntry =
    /**
     * `messageId` = 对应的那条 item（`u-*`）。崩溃恢复要按它把「这条投递」和「这条公共条目」
     * 对上：没对上的话，重投时无从判断这句话到底进没进过这个 bot 的上下文（见 room.recover）。
     */
    | (EntryBase & {
          kind: 'say';
          author: Author;
          text: string;
          messageId?: string;
          /**
           * 随这句进来的附件（图 / 文件 / 目录引用）。
           *
           * 为什么要带进公共日志：别的 bot 要靠它把图送进自己的模型（`toMessage` 出 image part），
           * 而它读不到发送者的 blobs —— 所以 ref 必须跟着条目走，不能只活在发送者的 session 里。
           */
          attachments?: readonly AttachmentRef[];
      })
    | (EntryBase & { kind: 'conclusion'; botId: string; name: string; color?: string; text: string })
    | (EntryBase & { kind: 'notice'; text: string });

export type RoomEntryInput =
    | {
          kind: 'say';
          author: Author;
          text: string;
          messageId?: string;
          attachments?: readonly AttachmentRef[];
          turn?: number;
          turnId?: string;
      }
    | { kind: 'conclusion'; botId: string; name: string; color?: string; text: string; turn?: number; turnId?: string }
    | { kind: 'notice'; text: string; turn?: number; turnId?: string };

export class RoomLog {
    private readonly entries: RoomEntry[];
    private seq = 0;

    /** 可从持久化条目恢复（seq 接着往下走） */
    constructor(entries: readonly RoomEntry[] = []) {
        this.entries = [...entries];
        this.seq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    }

    append(input: RoomEntryInput, now = Date.now()): RoomEntry {
        const entry = { ...input, seq: ++this.seq, at: now } as RoomEntry;
        this.entries.push(entry);
        return entry;
    }

    all(): readonly RoomEntry[] {
        return this.entries;
    }

    since(afterSeq = 0): RoomEntry[] {
        return this.entries.filter((entry) => entry.seq > afterSeq);
    }

    get lastSeq(): number {
        return this.seq;
    }
}

/**
 * 公共条目 → 某个 bot 视角的一条消息。
 *
 *   · 自己的结论返回 null：它已经作为 assistant 产出在自己的 session 里，再塞一次就重复了；
 *   · 别人的结论按 user 角色 + 发言人标签：模型不能以为自己说过；
 *   · 通知不进 session（它是 UI 事件，进上下文只是噪音）。
 */
export function toMessage(entry: RoomEntry, selfId: string): ModelMessage | null {
    switch (entry.kind) {
        case 'say':
            return {
                role: 'user',
                content: entry.author.role === 'human' ? entry.text : `[${entry.author.name}] ${entry.text}`,
            };
        case 'conclusion':
            if (entry.botId === selfId) return null;
            return { role: 'user', content: `[${entry.name} 的结论] ${entry.text}` };
        case 'notice':
            return null;
    }
}
