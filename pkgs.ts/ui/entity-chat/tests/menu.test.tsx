// @vitest-environment happy-dom
// menu.test.tsx —— 侧栏行尾「⋮」浮层：必须挂在 body 上（portal + fixed）。
//
// 2026-11-25 真机问题（lab 61065）：行在 `overflow-y-auto` 的列表里、外面还有一层
// `overflow-hidden`，`absolute` 浮层被裁 —— 列表滚到底时只看得见一条缝，「删除」点不到。
// `z-30` 对裁剪无效，只有跳出这两个容器才行。
//
// 所以判据不是「菜单出现了」，而是「它不在那个 overflow 容器里」：断言它的父节点是 body。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MenuButton } from '../src/components/Menu';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(
            // 复刻侧栏那两层 overflow：浮层若留在里面就一定会被裁
            <div style={{ overflow: 'hidden' }}>
                <div style={{ overflowY: 'auto' }}>
                    <MenuButton
                        items={[
                            { key: 'rename', label: '重命名', icon: null, onClick: () => undefined },
                            { key: 'remove', label: '删除', icon: null, onClick: () => undefined, danger: true },
                        ]}
                    />
                </div>
            </div>,
        );
    });
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const trigger = () => {
    const button = container.querySelector('button[aria-haspopup="menu"]');
    if (button === null) throw new Error('没找到 ⋮ 按钮');
    return button;
};

const click = async (element: Element) => {
    await act(async () => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
};

describe('⋮ 菜单的浮层', () => {
    it('挂在 body 上，不留在 overflow 容器里（否则被裁得只剩一条缝）', async () => {
        expect(document.querySelector('[role="menu"]')).toBeNull();

        await click(trigger());
        const menu = document.querySelector('[role="menu"]');
        expect(menu).not.toBeNull();
        // 这一条就是本次修复的判据：`container.contains(menu)` 为 true 就说明还会被裁
        expect(container.contains(menu)).toBe(false);
        // Base UI 的 DropdownMenu 会 portal 到一个 wrapper div（在 body 下），不是直接挂 body ——
        // 判据是「在 body 下、不在被裁的 container 里」，不要求 parentElement 恰好是 body。
        expect(menu?.closest('body')).toBe(document.body);
        // 定位交给 Base UI 的 popover（CSS 定位，不设 inline style.top）—— 只要不被 container 裁即可。
    });

    it('再点一次 ⋮ 收回去', async () => {
        await click(trigger());
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
        await click(trigger());
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('点菜单项：先关，再执行（不会因为浮层被卸载而丢事件）', async () => {
        const onClick = vi.fn();
        await act(async () => {
            root.render(
                <MenuButton items={[{ key: 'remove', label: '删除', icon: null, onClick }]} />,
            );
        });
        await click(trigger());
        const item = document.querySelector('[role="menuitem"]');
        if (item === null) throw new Error('菜单项没渲染');
        await click(item);
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('点外面关闭', async () => {
        await click(trigger());
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
        await act(async () => {
            document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        });
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });
});
