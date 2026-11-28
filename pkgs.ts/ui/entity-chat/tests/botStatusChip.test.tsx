// @vitest-environment happy-dom
// botStatusChip.test.tsx —— 标题栏那颗「状态」：数字与列表同源、只列要你看的。
//
// 用户 2026-11-28 裁「两颗」之后，这颗的职责是「我该推谁一把」（在跑 / 等你回答 /
// 上一轮出错），与隔壁那颗「谁在动」分开。这里钉两件容易走散的事：
//   1. 数字 = `needsYou` 的条数（不是总席位、不是只在跑）；
//   2. ② 浮层只列 needsYou，idle 只出现在 ③ 全量表里 —— 且两处读同一份。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BotRow } from '@diy-agent/chat-transport-rpc';

import type { Room } from '../src/model';
import { bootstrapStore, setDiy2Client } from '../src/store';

import { BotStatusChip } from '../src/components/BotStatusChip';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const rooms: Room[] = [
    { id: 'task:one', type: 'task', modelKey: 'm', data: { title: '一号', status: 'open' }, botIds: [] },
];

const rows: BotRow[] = [
    {
        roomId: 'task:one',
        roomTitle: '一号',
        roomType: 'task',
        botId: 'role:a',
        botName: '主程',
        botColor: '#8b8b8b',
        state: 'asking',
        askId: 'ask-1',
        askTitle: '要不要删掉旧表？',
    },
    {
        roomId: 'task:one',
        roomTitle: '一号',
        roomType: 'task',
        botId: 'role:b',
        botName: '审阅',
        botColor: '#8b8b8b',
        state: 'needs-attention',
        outcome: 'interrupted',
        lastTurnAt: Date.now() - 60_000,
    },
    {
        roomId: 'task:one',
        roomTitle: '一号',
        roomType: 'task',
        botId: 'role:c',
        botName: '助手',
        botColor: '#8b8b8b',
        state: 'idle',
        outcome: 'done',
    },
];

let container: HTMLDivElement;
let root: Root;

const flush = async (): Promise<void> => {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
};

beforeEach(async () => {
    setDiy2Client({
        rooms: { list: async () => rooms },
        bots: { list: async () => [] },
        botProfiles: { list: async () => [], rows: async () => ({ rows }) },
        models: { list: async () => ({ providers: [] }) },
        subscribeActivity: () => () => undefined,
        drafts: { list: async () => ({ drafts: [] }), put: async () => ({ updatedAt: 0 }), remove: async () => ({}) },
    } as never);
    bootstrapStore();
    await flush();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(<BotStatusChip />);
    });
    await flush();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const chip = (): HTMLElement => {
    const button = container.querySelector('button');
    if (button === null) throw new Error('没找到那颗按钮');
    return button;
};

const popoverText = (): string => document.querySelector('[role="dialog"]')?.textContent ?? '';

describe('标题栏的「状态」那颗', () => {
    it('数字 = 要你看的条数（在跑 / 等你回答 / 出错），idle 不算', async () => {
        expect(chip().getAttribute('aria-label')).toBe('Bot 状态 2，查看要你看的');
        expect(chip().textContent).toContain('状态');
        expect(chip().textContent).toContain('2');
    });

    it('浮层只列要你看的：一句话题干 / 结局，都在', async () => {
        await act(async () => {
            chip().click();
        });
        await flush();
        const text = popoverText();
        expect(text).toContain('等你回答：要不要删掉旧表？');
        // 上一轮被打断 = 要你看的那种结局
        expect(text).toContain('上一轮被打断');
        expect(text).toContain('去回答');
        // idle 那行不进浮层（它只属于全量表）
        expect(text).not.toContain('正常结束');
    });

    it('「全部 Bot」打开全量表，默认筛选与浮层同口径，切「全部」才出现 idle', async () => {
        await act(async () => {
            chip().click();
        });
        await flush();
        const all = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('全部 Bot'));
        if (all === undefined) throw new Error('没找到「全部 Bot」');
        await act(async () => {
            all.click();
        });
        await flush();

        const dialogs = [...document.querySelectorAll('[role="dialog"]')];
        const sheet = dialogs.find((node) => node.textContent?.includes('个要你看 / 共'));
        if (sheet === undefined) throw new Error('没找到全量表');
        expect(sheet.textContent).toContain('2 个要你看 / 共 3 个');
        expect(sheet.textContent).not.toContain('正常结束');

        const allFilter = [...sheet.querySelectorAll('button')].find((button) => button.textContent === '全部');
        if (allFilter === undefined) throw new Error('没找到「全部」筛选');
        await act(async () => {
            allFilter.click();
        });
        await flush();
        expect(sheet.textContent).toContain('正常结束');
    });
});
