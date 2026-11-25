// @vitest-environment happy-dom
// roleConfigPanel.test.tsx —— 房间头「二级配置面板」的交互（2026-11-24 用户定）。
//
// 三级披露：模型胶囊 / 角色按钮（L1）→ 配置面板（L2，就地改模型 / 推理 + 全部设置）→
// 设置页角色段（L3）。这里用真 App（sidebar/taskPanel 裁掉）+ 假客户端，数四件事：
//   ① 点模型胶囊开的是**面板**、不是直接跳设置页（「全部设置」才跳）；
//   ② 面板里读的是该类型 primary 角色的模型 / 推理（不是某个房间私有 bot）；
//   ③ 面板就地可编辑：点模型名展开选择器、推理是下拉，改完直接写回该类型角色（bot 全局）；
//   ④ 角色按钮与胶囊开同一张面板；关掉再点、切房间重挂载都成立。
//
// tsc / 纯函数测试盖不到「点了到底开面板还是跳页」，只有渲染层能验，所以这里必须真渲染。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';
import type { BotRole } from '../src/roles';
import { actions, setDiy2Client } from '../src/store';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const rooms = [
    { id: 'task:t-1', type: 'task', modelKey: '', data: { title: '任务甲', status: 'open' }, members: [] },
    { id: 'proj:diy', type: 'project', modelKey: '', data: { name: 'diy' }, members: [] },
];

// task 类型有两个角色，primary 那个带模型 + 推理 —— 面板必须显示它的配置
const roles: BotRole[] = [
    {
        id: 'r-task-1',
        type: 'task',
        name: '执行',
        color: '#7cc4ff',
        instructions: '',
        primary: true,
        modelKey: 'deepseek@deepseek/deepseek-v3',
        reasoningEffort: 'high',
        createdAt: 1,
        updatedAt: 1,
    },
    {
        id: 'r-task-2',
        type: 'task',
        name: '评审',
        color: '#a3e635',
        instructions: '',
        primary: false,
        modelKey: 'other@x/y',
        reasoningEffort: null,
        createdAt: 2,
        updatedAt: 2,
    },
];

const onManageRoles = vi.fn();
const rolesUpdate = vi.fn(async (input: { id: string; modelKey?: string | null; reasoningEffort?: string | null }) => ({
    id: input.id,
    type: 'task',
    name: '执行',
    color: '#7cc4ff',
    instructions: '',
    primary: true,
    modelKey: input.modelKey === undefined ? 'deepseek@deepseek/deepseek-v3' : input.modelKey,
    reasoningEffort: input.reasoningEffort === undefined ? 'high' : input.reasoningEffort,
    createdAt: 1,
    updatedAt: 2,
}));

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
    await act(async () => {
        root.render(<App sidebar={false} taskPanel={false} onManageRoles={onManageRoles} />);
    });
}

/** 按可见文字找按钮并点（React 19 并发提交要 await act，否则断言时还没提交） */
async function clickText(text: string): Promise<void> {
    const btn = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(text));
    if (btn === undefined) throw new Error(`找不到按钮：${text}`);
    await act(async () => {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

/** 模型胶囊：靠 title「点击查看配置」定位（它显示的模型名随目录变化，不可靠） */
async function clickModelChip(): Promise<void> {
    const btn = Array.from(container.querySelectorAll('button')).find((item) =>
        item.getAttribute('title')?.includes('点击查看配置'),
    );
    if (btn === undefined) throw new Error('找不到模型胶囊');
    await act(async () => {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

async function clickClose(): Promise<void> {
    const btn = container.querySelector('button[aria-label="关闭配置"]');
    if (btn === null) throw new Error('找不到关闭按钮');
    await act(async () => {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

function panel(): Element | null {
    return container.querySelector('[role="dialog"][aria-label="当前类型配置"]');
}

beforeEach(async () => {
    onManageRoles.mockClear();
    setDiy2Client({
        rooms: { list: async () => rooms.map((room) => ({ ...room, data: { ...room.data } })) },
        roles: { list: async () => roles.slice(), update: rolesUpdate },
        models: {
            list: async () => ({
                providers: [],
                configured: true,
                modelConfigPath: '',
                snapshotMissing: false,
            }),
        },
        load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
        watch: () => () => undefined,
        drafts: { list: async () => ({ drafts: [] }), put: async () => ({ updatedAt: 0 }), remove: async () => ({}) },
    } as never);
    actions.bootstrap();
    await new Promise((resolve) => setTimeout(resolve, 0));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        actions.navigate({ page: 'room', id: 'task:t-1' });
    });
    await render();
});

afterEach(() => {
    rolesUpdate.mockClear();
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe('房间头二级配置面板', () => {
    it('默认收起，且此时「全部设置」没被触发', () => {
        expect(panel()).toBeNull();
        expect(onManageRoles).not.toHaveBeenCalled();
    });

    it('点模型胶囊 → 面板显示该类型 primary 角色的模型与推理 + 全部设置', async () => {
        await clickModelChip();
        expect(panel()).not.toBeNull();
        expect(panel()!.textContent).toContain('任务类型');
        expect(panel()!.textContent).toContain('deepseek-v3'); // primary 角色的模型
        expect(panel()!.textContent).toContain('high'); // primary 角色的推理强度
        expect(panel()!.textContent).toContain('全部设置');
        // 就地可编辑：模型名是可点按钮，推理是下拉
        expect(Array.from(panel()!.querySelectorAll('button')).some((btn) => btn.textContent === 'deepseek-v3')).toBe(true);
        expect(panel()!.querySelector('select')).not.toBeNull();
        // 开面板这一步绝不直接跳设置页
        expect(onManageRoles).not.toHaveBeenCalled();
    });

    it('改推理强度直接写回该类型角色（bot 全局）', async () => {
        await clickModelChip();
        // 改推理强度 → roles.update 写到 primary 角色（不是房间私有 bot）
        const select = panel()!.querySelector('select[aria-label="推理强度"]')!;
        await act(async () => {
            select.value = 'low';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(rolesUpdate).toHaveBeenCalledWith({ id: 'r-task-1', reasoningEffort: 'low' });
    });

    it('点模型名展开选择器', async () => {
        await clickModelChip();
        await clickText('deepseek-v3');
        expect(panel()!.textContent).toContain('选择模型');
    });

    it('点「全部设置」才触发深链回调', async () => {
        await clickModelChip();
        await clickText('全部设置');
        expect(onManageRoles).toHaveBeenCalledTimes(1);
    });

    it('关掉面板后再次点击还能打开', async () => {
        await clickModelChip();
        expect(panel()).not.toBeNull();
        await clickClose();
        expect(panel()).toBeNull();
        await clickModelChip();
        expect(panel()).not.toBeNull();
    });

    it('「角色」按钮与模型胶囊开同一张面板，点它不直接跳设置页', async () => {
        await clickText('角色');
        expect(panel()).not.toBeNull();
        expect(onManageRoles).not.toHaveBeenCalled();
    });
});
