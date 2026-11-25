// 工作台模型的单测：页模板校验 / 偏好载入容错 / 视图归属与兜底。
//
// 这些都是「错了不报错，只表现成某块看不见或偏好悄悄丢失」的纯函数，所以边界钉住。
// 渲染（骨架位置、单击 / 双击手势）不在这里 —— 那是 lab 里点出来的（见 PR 描述）。

import { describe, expect, it } from 'vitest';

import {
    activeOf,
    area,
    definePage,
    defineView,
    initialState,
    loadState,
    MODES,
    modeOf,
    saveState,
    sizeOf,
    stateKey,
    viewsIn,
    type PageState,
} from '../src/workbench/model';
import { genericPage, pageFor, wbViews } from '../src/workbench/pages';

/** 最小可用的假 Storage：能种数据、也能模拟「隐私模式 / 配额满」 */
function fakeStorage(seed: Record<string, string> = {}, throwOn?: 'get' | 'set'): Storage {
    const data = new Map(Object.entries(seed));
    return {
        get length() {
            return data.size;
        },
        clear: () => {
            data.clear();
        },
        getItem: (key: string) => {
            if (throwOn === 'get') throw new Error('storage denied');
            return data.get(key) ?? null;
        },
        key: (index: number) => [...data.keys()][index] ?? null,
        removeItem: (key: string) => {
            data.delete(key);
        },
        setItem: (key: string, value: string) => {
            if (throwOn === 'set') throw new Error('quota exceeded');
            data.set(key, value);
        },
    };
}

const page = definePage({
    type: 'task',
    title: '任务',
    center: area('conversation', { slot: 'center', title: '对话', size: 'fr' }),
    sides: [
        area('detail', { slot: 'left', title: '详情', size: 320 }),
        area('assets', { slot: 'right', title: '资产', size: 320, initial: 'collapsed' }),
    ],
});

const view = (id: string, placement: Record<string, { area: string }>) =>
    defineView({ id, title: id, placement, render: () => null });

describe('definePage：模板硬约束在定义期就检掉', () => {
    it('合法模板的 areas = [center, ...sides]', () => {
        expect(page.areas.map((def) => def.id)).toEqual(['conversation', 'detail', 'assets']);
        expect(page.center.slot).toBe('center');
    });

    it('center 的 slot 写错 → 抛', () => {
        expect(() =>
            definePage({
                type: 'x',
                title: 'x',
                center: area('main', { slot: 'left', size: 'fr' }),
            }),
        ).toThrow(/必须声明 slot/);
    });

    it('sides 里出现 center → 抛', () => {
        expect(() =>
            definePage({
                type: 'x',
                title: 'x',
                center: area('main', { slot: 'center', size: 'fr' }),
                sides: [area('boom', { slot: 'center', size: 100 })],
            }),
        ).toThrow(/sides 里却声明 slot/);
    });

    it('id 重复 → 抛', () => {
        expect(() =>
            definePage({
                type: 'x',
                title: 'x',
                center: area('conversation', { slot: 'center', size: 'fr' }),
                sides: [area('conversation', { slot: 'left', size: 100 })],
            }),
        ).toThrow(/id 重复/);
    });

    it('同一个槽位两个区域 → 抛', () => {
        expect(() =>
            definePage({
                type: 'x',
                title: 'x',
                center: area('main', { slot: 'center', size: 'fr' }),
                sides: [area('a', { slot: 'left', size: 100 }), area('b', { slot: 'left', size: 100 })],
            }),
        ).toThrow(/两个区域/);
    });
});

describe('偏好载入：坏数据不许把布局带歪', () => {
    it('没存过 → null（与「存过空状态」区分）', () => {
        expect(loadState('task', fakeStorage())).toBeNull();
    });

    it('键名按页类型分：workbench:<pageType>', () => {
        expect(stateKey('task')).toBe('workbench:task');
    });

    it('round-trip 且 maximized 不落盘', () => {
        const storage = fakeStorage();
        const state: PageState = {
            collapsed: { assets: true },
            maximized: 'detail',
            modes: { assets: 'grid' },
            active: { detail: 'detail' },
            sizes: { detail: 400 },
        };
        saveState('task', state, storage);
        expect(storage.getItem('workbench:task')).not.toContain('maximized');

        const back = loadState('task', storage);
        expect(back).toEqual({
            collapsed: { assets: true },
            modes: { assets: 'grid' },
            active: { detail: 'detail' },
            sizes: { detail: 400 },
        });
    });

    it('坏 JSON / 字段形状不对 → 该字段当没有', () => {
        expect(loadState('task', fakeStorage({ 'workbench:task': '{not json' }))).toBeNull();

        const weird = loadState(
            'task',
            fakeStorage({
                'workbench:task': JSON.stringify({ collapsed: 'oops', modes: [1, 2], active: null, sizes: 7 }),
            }),
        );
        expect(weird).toEqual({ collapsed: {}, modes: {}, active: {}, sizes: {} });
    });

    it('存储不可用（隐私模式 / 配额满）不抛', () => {
        expect(loadState('task', fakeStorage({}, 'get'))).toBeNull();
        expect(() => {
            saveState('task', initialState(page), fakeStorage({}, 'set'));
        }).not.toThrow();
    });

    it('initialState 只收模板标记了 collapsed 的四边（center 收不起来）', () => {
        expect(initialState(page).collapsed).toEqual({ assets: true });
    });
});

describe('查表：归属 / 形态 / 选中 / 尺寸的兜底', () => {
    const views = [
        view('detail', { task: { area: 'detail' } }),
        view('chat', { task: { area: 'conversation' }, project: { area: 'conversation' } }),
        view('assets', { task: { area: 'assets' } }),
    ];

    it('viewsIn 按页类型 + 区域概念 id 归属', () => {
        expect(viewsIn(views, 'task', 'detail').map((item) => item.id)).toEqual(['detail']);
        expect(viewsIn(views, 'task', 'conversation').map((item) => item.id)).toEqual(['chat']);
        // 这一页没声明就不出现（assets 在 project 页不存在）
        expect(viewsIn(views, 'project', 'assets')).toEqual([]);
    });

    it('modeOf：用户选的优先，失效回模板默认，再失效回第一个允许的', () => {
        const def = page.sides[0]!; // detail：没写 mode / modes
        expect(modeOf(def, { ...baseState(), modes: { detail: 'grid' } })).toBe('grid');
        expect(modeOf(def, { ...baseState(), modes: { detail: 'bogus' as never } })).toBe('tab');

        const locked = area('only', { slot: 'left', size: 100, mode: 'grid', modes: ['tab'] });
        expect(modeOf(locked, baseState())).toBe('tab');
        expect(MODES).toContain(modeOf(locked, baseState()));
    });

    it('activeOf：选中的失效就回第一个；没有 view 就是 undefined', () => {
        expect(
            activeOf('detail', viewsIn(views, 'task', 'detail'), { ...baseState(), active: { detail: 'gone' } }),
        ).toBe('detail');
        expect(activeOf('detail', viewsIn(views, 'task', 'detail'), baseState())).toBe('detail');
        expect(activeOf('detail', [], baseState())).toBeUndefined();
    });

    it('sizeOf：拖过的优先；坏值当没拖过', () => {
        const def = page.sides[0]!; // 模板 320
        expect(sizeOf(def, baseState())).toBe(320);
        expect(sizeOf(def, { ...baseState(), sizes: { detail: 400 } })).toBe(400);
        expect(sizeOf(def, { ...baseState(), sizes: { detail: 0 } })).toBe(320);
        expect(sizeOf(def, { ...baseState(), sizes: { detail: Number.NaN } })).toBe(320);
    });
});

function baseState(): PageState {
    return { collapsed: {}, modes: {}, active: {}, sizes: {} };
}

// 真模板的单测（import 真实装配，不是另造一份）—— 兜底错了的后果是「启一个非任务房间
// 会拿到一个可写面板」，静默改脏别的容器的 data，所以必须在单测里钉住。
describe('pageFor：未知类型不许掉进任务页', () => {
    it('task / project 各自认领', () => {
        expect(pageFor('task').type).toBe('task');
        expect(pageFor('project').type).toBe('project');
    });

    it('其它类型（Room.type 是开放字符串）→ generic', () => {
        for (const type of ['stock', 'doc', '', 'TASK', 'taskx', 'task ']) {
            expect(pageFor(type).type).toBe('generic');
        }
    });

    it('generic 页只给对话 + 信息卡 + 诊断，没有资产区', () => {
        expect(genericPage.areas.map((def) => def.id)).toEqual(['conversation', 'detail', 'diag']);
        expect(genericPage.center.id).toBe('conversation');
    });

    it('任务页的 detail 区住「目标」与「详情」= 自然变成 tab（不动骨架）', () => {
        // 需求账本树是任务本体的一部分（与正文同级），而「详情」已经在那；
        // 两个 view 同一区域 = 界面自己长 tab，不需要新增区域 / 改模板约束。
        // 「目标」在前（默认选中 = 数组首位）：账本是这一页最常看的东西。
        // 依赖图（units-dag）随「不记执行规划」删掉；「文本」并进了「目标」做成源码开关
        // （2026-11-25 裁：同一份数据的两种读法，不该摆成两个并列 tab）。
        expect(viewsIn(wbViews, 'task', 'detail').map((item) => item.id)).toEqual(['units', 'detail']);
        // 项目没有内部拆分（unit 是 task 私有的轻实体）
        expect(viewsIn(wbViews, 'project', 'detail').map((item) => item.id)).toEqual(['detail']);
    });

    it('每个模板的每个区域都有 view 落进去（否则那块永远是空白，且单 view 区域不给 ⋯）', () => {
        for (const def of [pageFor('task'), pageFor('project'), genericPage]) {
            for (const side of def.areas) {
                expect(viewsIn(wbViews, def.type, side.id).length, `${def.type} / ${side.id}`).toBeGreaterThan(0);
            }
        }
    });
});
