// @vitest-environment happy-dom
// exportButton.test.tsx —— 标题栏那颗「导出」是不是真的把当前房间的时间线存成了 .md。
//
// 纯函数（`exportMarkdown`）另有单测，这里只钉**接线**：点了之后
//   1. 文件名带房间名与时刻（不是 `undefined.md`、不是空的）；
//   2. 交给浏览器的正文里有这个房间的对话（取数取自 `conversationOf`，不是空壳）；
//   3. 抓取会话状态发生在点击那一刻（导之前不发请求、导之后按钮回到常态）。
//
// 目的很实际：接错一行（忘了 buildTimeline / 传错 room）tsc 全绿，产出的却是一份
// 「标题对、内容是空的」文件 —— 那种东西发出去比没有更糟。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Item } from '@diy-agent/chat-core';

import { ExportButton } from '../src/components/ExportButton';
import type { Room } from '../src/model';
import { actions, setDiy2Client } from '../src/store';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOM: Room = {
    id: 'task:t-1',
    type: 'task',
    modelKey: 'm',
    data: { title: '导出这个房间', number: 7, status: 'open' },
    members: [{ botId: 'bot-1', primary: true }],
};

const BOT = { id: 'bot-1', name: 'dsh', color: '#fff', persona: '', homeRoomId: 'task:t-1', modelKey: 'm' };

const at = new Date(2026, 10, 26, 9, 1).getTime();

const ITEMS: Item[] = [
    {
        id: 'i-1',
        seq: 1,
        turnId: 't1',
        at,
        status: 'ok',
        author: { id: 'me', name: '我', color: '#000', role: 'human' },
        type: 'chat',
        data: { text: '把这段导出' },
    },
    {
        id: 'i-2',
        seq: 2,
        turnId: 't1',
        at: at + 1000,
        status: 'ok',
        author: { id: 'bot-1', name: 'dsh', color: '#fff', role: 'bot' },
        type: 'chat',
        data: { text: '好，已经导出好了。' },
    },
];

let container: HTMLDivElement;
let root: Root;
/** 捕获交给浏览器的文件：名字 + 正文 */
let saved: { name: string; text: string } | undefined;

beforeEach(async () => {
    saved = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    setDiy2Client({
        rooms: { list: async () => [ROOM] },
        bots: { list: async () => [BOT] },
        models: { list: async () => ({ providers: [] }) },
        load: async () => ({ items: ITEMS, deliveries: [], asks: [], answeredAsks: [], speaking: [] }),
        watch: () => () => undefined,
        drafts: { list: async () => ({ drafts: [] }), put: async () => ({ updatedAt: 0 }), remove: async () => ({}) },
    } as never);
    actions.bootstrap();
    await new Promise((resolve) => setTimeout(resolve, 0));

    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
        void (blob as Blob).text().then((text) => {
            saved = { name: saved?.name ?? '', text };
        });
        return 'blob:mock';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    // happy-dom 里真点锚点会尝试导航：录下 href / download 就够，不去碰它的下载流程
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        saved = { name: this.download, text: saved?.text ?? '' };
    });
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

async function clickExport(): Promise<void> {
    await act(async () => {
        root.render(<ExportButton room={ROOM} />);
    });
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    await act(async () => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ExportButton', () => {
    it('点一下存成 .md：文件名带房间名，正文就是这个房间的对话', async () => {
        await clickExport();
        expect(saved?.name).toMatch(/^导出这个房间-\d{8}-\d{4}\.md$/);
        expect(saved?.text).toContain('# 导出这个房间');
        expect(saved?.text).toContain('## 用户');
        expect(saved?.text).toContain('把这段导出');
        expect(saved?.text).toContain('## dsh');
        expect(saved?.text).toContain('好，已经导出好了。');
    });

    it('导出后按钮短暂变成「已导出」，1.5 秒后回到常态', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            await clickExport();
            const button = container.querySelector('button');
            expect(button?.getAttribute('aria-label')).toContain('已导出');
            await act(async () => {
                vi.advanceTimersByTime(1600);
            });
            expect(container.querySelector('button')?.getAttribute('aria-label')).toContain('导出为 Markdown');
        } finally {
            vi.useRealTimers();
        }
    });
});
