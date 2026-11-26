// attachments.test.ts —— 附件进房间：存得下、回得来、「这条图是哪句的」不用猜。
//
// 锁三件事（对应任务里的 attachment-protocol）：
//   1. 人发的消息带附件 ⇒ 落在 `item.data.attachments`（不是新开 item、不是塞进 text）
//   2. 附件同时进公共日志（`kind: 'say'`）—— 别的 bot 读不到发送者的 blobs，只能靠 ref 走
//   3. 重启后（同一个 sqlite 重建房间）附件还在：db 里存的是 json，字段不能悄悄丢
//
// 不在这里测：图片怎么进模型（session-image-part）、UI 怎么显示（composer-paste）。

import { describe, expect, it } from 'vitest';

import type { ModelMessage } from 'ai';

import type { AttachmentRef } from '@diy-agent/attachment/types';

import type { AgentEvent, RunOptions } from '../src/agent';
import type { Item } from '../src/types';
import { HUMAN, makeRoom } from './support/harness';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

/** 最小可用的脚本 run：只把这一轮实际收到的 messages 记下来 */
function captureRun(seen: ModelMessage[][]) {
    return async function* (input: RunOptions): AsyncIterable<AgentEvent> {
        seen.push(input.messages);
        yield { seq: 1, type: 'run.started', turnId: 't1', messageId: 'm1' };
        yield { seq: 2, type: 'text.delta', messageId: 'm1', delta: '看到了' };
        yield { seq: 3, type: 'run.finished', turnId: 't1', finishReason: 'stop', steps: 1, maxOutputTokens: 0 };
        yield { seq: 4, type: 'message.completed', messageId: 'm1' };
        yield { seq: 5, type: 'run.completed', turnId: 't1' };
    };
}

const SHOT: AttachmentRef = {
    type: 'stored',
    id: '2026-11-26/093012-abcd1234/01-shot.png',
    relPath: '2026-11-26/093012-abcd1234/01-shot.png',
    kind: 'image',
    mime: 'image/png',
    bytes: 2048,
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

const chatOf = (items: readonly Item[]): Extract<Item, { type: 'chat' }>[] =>
    items.filter((item): item is Extract<Item, { type: 'chat' }> => item.type === 'chat');

describe('附件随消息进房间', () => {
    it('落在 item.data.attachments（原始形状一字不改）', async () => {
        const h = makeRoom();
        await h.room.say({ text: '看这张', author: HUMAN, attachments: [SHOT, REPORT] });

        const human = chatOf(h.items()).find((item) => item.author.role === 'human');
        expect(human?.data.text).toBe('看这张');
        expect(human?.data.attachments).toEqual([SHOT, REPORT]);
    });

    it('只贴图不打字也允许；两样都空才报错', async () => {
        const h = makeRoom();
        await h.room.say({ text: '   ', author: HUMAN, attachments: [SHOT] });
        const human = chatOf(h.items()).find((item) => item.author.role === 'human');
        expect(human?.data.text).toBe('');
        expect(human?.data.attachments).toHaveLength(1);

        const empty = makeRoom();
        await expect(empty.room.say({ text: '   ', author: HUMAN })).rejects.toThrow(/attachments/);
    });

    it('附件也进公共日志 —— 别的 bot 靠 ref 把图送进自己的模型', async () => {
        const h = makeRoom();
        await h.room.say({ text: '看这张', author: HUMAN, attachments: [SHOT] });

        const entry = h.room.entries().find((item) => item.kind === 'say');
        expect(entry?.kind === 'say' && entry.attachments).toEqual([SHOT]);
    });

    it('重启后还在（db 存 json，字段不能悄悄丢）', async () => {
        const h = makeRoom();
        await h.room.say({ text: '看这张', author: HUMAN, attachments: [SHOT, REPORT] });

        const rebuilt = h.rebuild();
        const human = chatOf(rebuilt.items()).find((item) => item.author.role === 'human');
        expect(human?.data.attachments).toEqual([SHOT, REPORT]);
    });

    it('图真的到模型眼前：这一轮的 user message 里出现 file part', async () => {
        const seen: ModelMessage[][] = [];
        const h = makeRoom({
            readAttachment: async () => PNG,
            // 假 modelKey 在真目录里查不到 ⇒ 缺省当「不收图」；要验送图这条路就把判据定成 true
            acceptsImages: () => true,
            run: captureRun(seen),
        });
        await h.room.say({ text: '看这张', author: HUMAN, attachments: [SHOT] });

        const user = seen[0]?.find((message) => message.role === 'user');
        expect(Array.isArray(user?.content)).toBe(true);
        expect(user?.content).toEqual([
            { type: 'text', text: '看这张' },
            { type: 'file', mediaType: 'image/png', data: PNG, filename: 'shot.png' },
        ]);
    });

    it('模型不收图 ⇒ 不送 image part，但正文里留一句「未送达」', async () => {
        const seen: ModelMessage[][] = [];
        const h = makeRoom({
            readAttachment: async () => PNG,
            acceptsImages: () => false,
            run: captureRun(seen),
        });
        await h.room.say({ text: '看这张', author: HUMAN, attachments: [SHOT] });

        const user = seen[0]?.find((message) => message.role === 'user');
        expect(JSON.stringify(user?.content)).toMatch(/附图未送达.*不收图/);
        expect(JSON.stringify(user?.content)).not.toContain('"type":"file"');
    });

    it('没有附件读法时（测试 / 无 blobs 宿主）不静默丢图：正文后补一行说明', async () => {
        const seen: ModelMessage[][] = [];
        const h = makeRoom({ run: captureRun(seen) });
        await h.room.say({ text: '看这张', author: HUMAN, attachments: [SHOT] });

        const user = seen[0]?.find((message) => message.role === 'user');
        expect(JSON.stringify(user?.content)).toMatch(/附图未送达/);
    });

    it('不带附件的老消息形状不变（`attachments` 缺省而不是空数组）', async () => {
        const h = makeRoom();
        await h.room.say({ text: '一句普通的话', author: HUMAN });

        const human = chatOf(h.items()).find((item) => item.author.role === 'human');
        expect(human?.data).toEqual({ text: '一句普通的话' });
    });
});
