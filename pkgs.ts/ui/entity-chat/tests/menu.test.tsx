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
        // 剩余两条（「直接挂 body」、「inline 坐标不为空」）已删：换成官方 DropdownMenu
        // （Base UI）后，popup 套在定位 wrapper 里、`position: fixed` 与坐标都来自
        // **样式表**，而 happy-dom 不算 CSS、只认 inline style —— 那两条在当前实现下
        // 永远是假红，留着等于把「测不到」写成「测过了」。
        // 定位行为（不被裁、贴边翻转）改由真机/截图验；这里只钉「跳出了 overflow 容器」。
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
            root.render(<MenuButton items={[{ key: 'remove', label: '删除', icon: null, onClick }]} />);
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
