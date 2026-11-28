// session-images.test.ts —— 附件怎么变成模型看得见的东西（以及读不到时怎么说话）
//
// 这一层的三条硬判据：
//   ① 没有附件 ⇒ 原样返回（常规消息不为多模态付代价）
//   ② 图 ⇒ ai-sdk 的 file part（mediaType + bytes + 原名）；非图 ⇒ 只留一行说明
//   ③ 读不到 ⇒ 一行「附图未送达」，**不静默丢**（静默丢的症状是模型答非所问）
//
// 不在这里测：blobs 怎么落盘（@diy-agent/attachment 的测试）、room 怎么带 ref（attachments.test.ts）。

import { describe, expect, it } from 'vitest';

import type { AttachmentRef } from '@diy-agent/attachment/types';

import type { TranscriptEntry } from '../src/compaction';
import { AttachmentBytesCache, messageWithAttachments } from '../src/session-images';

const SHOT: AttachmentRef = {
    type: 'stored',
    id: '2026-11-26/093012-a1b2c3d4/01-shot.png',
    relPath: '2026-11-26/093012-a1b2c3d4/01-shot.png',
    kind: 'image',
    mime: 'image/png',
    bytes: 4,
    displayName: 'shot.png',
    source: 'paste',
    createdAt: 1_764_120_000_000,
    sha256: 'a'.repeat(64),
    image: { width: 1440, height: 900 },
};

const REPORT: AttachmentRef = {
    type: 'linked',
    id: 'ref-0123456789ab',
    path: '/Users/me/report.pdf',
    kind: 'file',
    mime: 'application/pdf',
    bytes: 4096,
    displayName: 'report.pdf',
    source: 'path',
    createdAt: 1_764_120_000_000,
};

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

function entry(attachments?: AttachmentRef[], text = '看这张'): TranscriptEntry {
    return {
        message: { role: 'user', content: text },
        origin: 'public',
        ...(attachments === undefined ? {} : { attachments }),
    };
}

/** 内存里的附件表（模拟 blobs） */
function readerOf(table: Record<string, Uint8Array>, calls: string[] = []) {
    return async (ref: AttachmentRef): Promise<Uint8Array> => {
        calls.push(ref.id);
        const bytes = table[ref.id];
        if (bytes === undefined) throw new Error('missing');
        return bytes;
    };
}

describe('messageWithAttachments', () => {
    it('没有附件 ⇒ 原样返回（不建数组、不动形状）', async () => {
        const source = entry();
        expect(await messageWithAttachments(source, undefined)).toBe(source.message);
    });

    it('图 ⇒ file part（mime + 字节 + 原名），正文在它前面', async () => {
        const read = readerOf({ [SHOT.id]: PNG });
        const message = await messageWithAttachments(entry([SHOT]), read);

        expect(message.role).toBe('user');
        expect(message.content).toEqual([
            { type: 'text', text: '看这张' },
            { type: 'file', mediaType: 'image/png', data: PNG, filename: 'shot.png' },
        ]);
    });

    it('非图（pdf）不塞进 content，只留一行说明', async () => {
        const read = readerOf({}); // 就算能读也不该读
        const message = await messageWithAttachments(entry([REPORT], '帮我看看这个'), read);

        expect(Array.isArray(message.content)).toBe(true);
        const parts = message.content as Array<{ type: string; text?: string }>;
        expect(parts.every((part) => part.type === 'text')).toBe(true);
        expect(parts[1]?.text).toMatch(/report\.pdf.*未送进上下文/);
    });

    it('reader 没注入 / 读失败 ⇒ 一行「未送达」，不抛、不静默', async () => {
        const noReader = await messageWithAttachments(entry([SHOT]), undefined);
        expect(JSON.stringify(noReader.content)).toMatch(/附图未送达/);

        const broken = await messageWithAttachments(entry([SHOT]), async () => {
            throw new Error('文件没了');
        });
        expect(JSON.stringify(broken.content)).toMatch(/附图未送达/);
    });

    it('只有图、没有正文 ⇒ content 就是那个 file part（不是空数组）', async () => {
        const read = readerOf({ [SHOT.id]: PNG });
        const message = await messageWithAttachments(entry([SHOT], ''), read);
        const parts = message.content as Array<{ type: string }>;
        expect(parts).toHaveLength(1);
        expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'image/png', filename: 'shot.png' });
    });

    it('本模型不收图 ⇒ 不塞 image part，但留一句说明（不静默丢）', async () => {
        const read = readerOf({ [SHOT.id]: PNG });
        const message = await messageWithAttachments(entry([SHOT]), read, undefined, { acceptsImages: false });
        const parts = message.content as Array<{ type: string; text?: string }>;
        expect(parts.every((part) => part.type === 'text')).toBe(true);
        expect(JSON.stringify(parts)).toMatch(/附图未送达.*不收图/);
    });

    it('同一张图读两次只落一次盘（按 sha256 缓存）', async () => {
        const calls: string[] = [];
        const read = readerOf({ [SHOT.id]: PNG }, calls);
        const cache = new AttachmentBytesCache();

        await messageWithAttachments(entry([SHOT]), read, cache);
        await messageWithAttachments(entry([SHOT]), read, cache);
        expect(calls).toHaveLength(1);
    });

    it('assistant 消息上的附件不送（附件只属于人的消息）', async () => {
        const source: TranscriptEntry = {
            message: { role: 'assistant', content: '我说的话' } as never,
            origin: 'self',
            attachments: [SHOT],
        };
        expect(await messageWithAttachments(source, readerOf({ [SHOT.id]: PNG }))).toBe(source.message);
    });

    // tool 消息的图（2026-11-28）：`view_image` 看过的图要进模型，否则同一轮内模型看不到
    // 自己刚调的工具产出的图（实测症状：“只回传了 PNG 的原始字节”）。
    it('tool 消息带图 ⇒ output 换成 content 型（text + file），不丢 toolCallId', async () => {
        const source: TranscriptEntry = {
            message: {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'call_v1',
                        toolName: 'view_image',
                        output: { type: 'text', value: '看一眼这张图：shot.png' },
                    },
                ],
            } as never,
            origin: 'self',
            attachments: [SHOT],
        };
        const message = await messageWithAttachments(source, readerOf({ [SHOT.id]: PNG }));

        expect(message.role).toBe('tool');
        const part = (message.content as Array<Record<string, unknown>>)[0]!;
        expect(part['toolCallId']).toBe('call_v1');
        expect(part['toolName']).toBe('view_image');
        expect(part['output']).toEqual({
            type: 'content',
            value: [
                { type: 'text', text: '看一眼这张图：shot.png' },
                { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG }, filename: 'shot.png' },
            ],
        });
    });

    it('tool 消息 + 不收图的模型 ⇒ 图不塞（不换回 400），正文照旧', async () => {
        const source: TranscriptEntry = {
            message: {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'call_v2',
                        toolName: 'view_image',
                        output: { type: 'text', value: '看一眼' },
                    },
                ],
            } as never,
            origin: 'self',
            attachments: [SHOT],
        };
        const message = await messageWithAttachments(source, readerOf({ [SHOT.id]: PNG }), new AttachmentBytesCache(), {
            acceptsImages: false,
        });
        // 原样返回（一个 file part 都不塞）
        expect(message).toBe(source.message);
    });

    it('tool 消息 + 图读不到 ⇒ 退回原形状，不抛', async () => {
        const source: TranscriptEntry = {
            message: {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'call_v3',
                        toolName: 'view_image',
                        output: { type: 'text', value: '看一眼' },
                    },
                ],
            } as never,
            origin: 'self',
            attachments: [SHOT],
        };
        const message = await messageWithAttachments(source, readerOf({})); // 表里没这张图
        expect(message).toBe(source.message);
    });

    // 跨轮的真实形状：transcript 里存的是 **scrub 之后**的 message —— 图已经被换成一行
    // 「已交给模型看过」的说明。重建时必须把那个占位丢掉（图已经按 ref 回来了），
    // 只留原来的正文，否则模型会看到「说明 + 图」废话两遍。
    it('tool 消息（scrub 后的 content 型）⇒ 图重建、scrub 占位丢掉', async () => {
        const source: TranscriptEntry = {
            message: {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'call_v4',
                        toolName: 'view_image',
                        output: {
                            type: 'content',
                            value: [
                                { type: 'text', text: '看一眼这张图：shot.png' },
                                { type: 'text', text: '[shot.png（image/png）已交给模型看过；落库不留字节，要再看一次就重新调工具]' },
                            ],
                        },
                    },
                ],
            } as never,
            origin: 'self',
            attachments: [SHOT],
        };
        const message = await messageWithAttachments(source, readerOf({ [SHOT.id]: PNG }));
        const part = (message.content as Array<Record<string, unknown>>)[0]!;
        expect(part['output']).toEqual({
            type: 'content',
            value: [
                { type: 'text', text: '看一眼这张图：shot.png' },
                { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG }, filename: 'shot.png' },
            ],
        });
    });
});
