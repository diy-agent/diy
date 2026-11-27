// @vitest-environment happy-dom
// dialogEnterIme.test.tsx —— 「新建任务」弹窗：中文输入法组合态的回车不许提交。
//
// 2026-11-27 真机问题：用户在小问题更新房间里新建任务，用拼音打完标题按回车「选词」，
// 弹窗直接把任务建了出来。根因是标题输入框的 `onKeyDown` 只看 `key === 'Enter'`，
// 没看 `isComposing` —— 输入法上屏那一次回车照样落进提交分支。
//
// 判据（两条都要）：
//   1. 组合态（PS：`isComposing: true`）回车 → onSubmit 一次都不许调；
//   2. 组合态结束后的回车 → 照常提交（别为了修 bug 把回车提交整个废掉）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreateTaskDialog } from '../src/components/Dialogs';
import type { Room } from '../src/model';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const project: Room = {
    id: 'proj:diy',
    type: 'project',
    modelKey: 'm',
    data: { name: 'diy', dir: '~/git/diy/diy' },
    botIds: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

/** 打进标题 + 派发一次回车；`composing` 决定这次回车是不是输入法上屏 */
async function typeAndEnter(text: string, composing: boolean): Promise<void> {
    await act(async () => {
        root.render(
            <CreateTaskDialog project={project} suggestedName="" onClose={() => undefined} onSubmit={onSubmit} />,
        );
    });
    // Dialog 走 portal 挂 body，不在 container 里
    const input = document.querySelector('input');
    expect(input, '标题输入框没渲染出来').not.toBeNull();
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, text);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
        input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: composing }));
    });
}

const onSubmit = vi.fn();

describe('新建任务弹窗：IME 组合态回车', () => {
    it('组合态回车只上屏，不建任务', async () => {
        onSubmit.mockClear();
        await typeAndEnter('修输入法', true);
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('组合结束后的回车照常提交', async () => {
        onSubmit.mockClear();
        await typeAndEnter('修输入法', false);
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit.mock.calls[0]?.[0]).toEqual({ name: '修输入法' });
    });
});
