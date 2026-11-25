// @vitest-environment happy-dom
// activeGlyphsClick.test.tsx —— 「点一下 Bot 那颗，整页黑屏」的回归护栏。
//
// 2026-11-25 实测（lab 61065，CDP）：点标题栏那颗，React 抛
//   TypeError: Cannot read properties of null (reading 'getBoundingClientRect')
//     at ActiveSessionsGlyph ... at basicStateReducer ... at useState
// 原因是 `setAnchor((current) => ... event.currentTarget.getBoundingClientRect())` ——
// updater 是**下次渲染时**才执行的，那时 React 已把事件对象的 `currentTarget` 置空。
// 异常从 render 阶段抛出 ⇒ 没有 error boundary ⇒ 整棵树卸载 ⇒ 页面全黑。
//
// 所以这里不用 SSR（SSR 不跑事件），必须真挂载 + 真点击。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Room } from '../src/model';
import { bootstrapStore, setDiy2Client } from '../src/store';

import { ActiveSessionsGlyph } from '../src/components/ActiveGlyphs';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const rooms: Room[] = [
    { id: 'task:one', type: 'task', modelKey: 'm', data: { title: '一号', status: 'open' }, botIds: [] },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
    setDiy2Client({
        rooms: { list: async () => rooms },
        bots: { list: async () => [] },
        roles: { list: async () => [] },
        models: { list: async () => ({ providers: [] }) },
        subscribeActivity: () => () => undefined,
        drafts: { list: async () => ({ drafts: [] }), put: async () => ({ updatedAt: 0 }), remove: async () => ({}) },
    } as never);
    bootstrapStore();
    await new Promise((resolve) => setTimeout(resolve, 0));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(<ActiveSessionsGlyph />);
    });
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const glyphButton = () => {
    const button = container.querySelector('button');
    if (button === null) throw new Error('没找到那颗按钮');
    return button;
};

describe('Bot 入口的弹层', () => {
    it('点一下弹层出现，再点一下收回去（点击不能把树炸掉）', async () => {
        expect(document.querySelector('[role="dialog"]')).toBeNull();

        await act(async () => {
            glyphButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const dialog = document.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog?.textContent).toContain('正在运行的 Bot');

        await act(async () => {
            glyphButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('没有 Bot 在跑时也弹得出来，且说明是空的', async () => {
        await act(async () => {
            glyphButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('当前没有运行中的 Bot');
    });
});
