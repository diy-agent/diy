// @vitest-environment happy-dom
// rerender.test.tsx —— 「一次 emit 只重渲真正变了的那一行」到底兑现了没有。
//
// 为什么非要数渲染次数：这一整套改动（窄选择器 / `React.memo` / 回调引用稳定）的收益
// **只能**在渲染层面看出来。订阅变细了，但父级 prop 每轮新建一个函数，`memo` 就永远
// 拦不住 —— 那时的表现是「订阅数变好看，侧栏照旧整列重画」，而 `tsc` 和 SSR 冒烟
// （sidebar.test.tsx）一个字都不会报。所以这里的判据是计数，不是 html。
//
// 数两件事，缺一不可：
//   ① **父级穿透**：`RoomRow` 换成一层计数包装（内部仍渲染本体），父级重渲时数到几次；
//   ② **单值订阅**：几个探针组件各自只订阅一个值，数它们被通知了几次 ——
//      行内那一格变了（高亮翻转）走的是这条路径，不经过父级的 memo，只能这样量。
//
// ⚠️ `act` 必须 `await`：React 19 的并发 root 会把提交排进微任务，同步 `act` 返回时
// 计数还是上一轮的 —— 那正是「断言 0 次」看起来永远通过、而其实什么都没测到的来源。

import type { ComponentProps } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Room } from '../src/model';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** 每个被数的东西进过几次 render（键自己起：`row:<id>` / `probe:<what>`）*/
const tally = vi.hoisted(() => {
    const events: string[] = [];
    return {
        events,
        bump: (key: string) => events.push(key),
        /** 记一个起点：只数这之后的，避免 `reset` 与异步提交抢时序 */
        mark: () => events.length,
        since: (mark: number) => {
            const seen = new Map<string, number>();
            for (const key of events.slice(mark)) seen.set(key, (seen.get(key) ?? 0) + 1);
            return (key: string) => seen.get(key) ?? 0;
        },
    };
});

vi.mock('../src/components/RoomRow', async () => {
    const { createElement, memo } = await import('react');
    const actual = await vi.importActual<typeof import('../src/components/RoomRow')>('../src/components/RoomRow');
    // 用**本体**（未包 memo 的 `RoomRowView`）计数，外面只包一层 memo —— 与生产的
    // `memo(RoomRowView)` 同构。这一层量到的就是「父级有没有穿透进来」。
    const Counting = memo(function CountingRoomRow(props: ComponentProps<typeof actual.RoomRowView>) {
        tally.bump(`row:${props.room.id}`);
        return createElement(actual.RoomRowView, props);
    });
    return { ...actual, RoomRow: Counting };
});

const { Sidebar } = await import('../src/components/Sidebar');
const { actions, setDiy2Client, useIsCurrentRoom, useRooms } = await import('../src/store');
const { registerNavSource } = await import('../src/nav');

const rooms: Room[] = [
    { id: 'proj:diy', type: 'project', modelKey: 'm', data: { name: 'diy', dir: '~/git/diy/diy' }, botIds: [] },
    {
        id: 'task:t-open',
        type: 'task',
        modelKey: 'm',
        data: { title: '在跑的任务', projectId: 'proj:diy', status: 'open' },
        botIds: [],
    },
    {
        id: 'task:t-closed',
        type: 'task',
        modelKey: 'm',
        data: { title: '收工的任务', projectId: 'proj:diy', status: 'closed', closedAt: Date.now() - 3 * 3600_000 },
        botIds: [],
    },
    { id: 'stock-1', type: 'stock', modelKey: 'm', data: { name: '孤儿容器' }, botIds: [] },
];

const HOST = {
    open: true,
    onToggle: () => undefined,
    onCreateProject: () => undefined,
    onCreateTask: () => undefined,
    onRequestDelete: () => undefined,
    onOpenSettings: () => undefined,
};

/** 项目树里那三行（已关闭的那个走历史区，不经过 `RoomRow`）*/
const TREE_ROWS = ['proj:diy', 'task:t-open', 'stock-1'] as const;

// ─── 探针：与侧栏一行用同一批 hook，但只订阅一个值 ────────────────────────────

/** `useIsCurrentRoom` 的探针：只有这一行的「是不是当前」翻转时才会重渲 */
function CurrentProbe({ id }: { id: string }) {
    const current = useIsCurrentRoom(id);
    tally.bump(`probe:current:${id}`);
    return <span data-probe={`current:${id}`}>{current ? 'on' : 'off'}</span>;
}

/** `useRooms` 的探针：只在列表本身换了一份时重渲 */
function RoomsProbe() {
    const list = useRooms();
    tally.bump('probe:rooms');
    return <span data-probe="rooms">{list.length}</span>;
}

/** 一个来源，只为了证明「父级真的重渲了」—— 它的 render 每轮都会被调一次 */
registerNavSource({
    id: 'test:probe',
    order: 999,
    render: () => {
        tally.bump('probe:source');
        return <span data-probe="source" />;
    },
});

let container: HTMLDivElement;
let root: Root;

async function renderAll(): Promise<void> {
    await act(async () => {
        root.render(
            <>
                <Sidebar {...HOST} />
                <CurrentProbe id="proj:diy" />
                <CurrentProbe id="task:t-open" />
                <CurrentProbe id="stock-1" />
                <RoomsProbe />
            </>,
        );
    });
}

beforeEach(async () => {
    // 命令面走 RPC：注入假客户端，喂一份固定的房间列表
    // 每次都回**新对象**（网络反序列化就是这样）：返回同一个 `rooms` 数组的话，
    // `refresh` 之后 `state.rooms` 引用不变，「列表换了一份」这件事根本测不出来。
    setDiy2Client({
        rooms: {
            list: async () => rooms.map((room) => ({ ...room, data: { ...room.data } })),
            update: async () => ({}),
        },
        roles: { list: async () => [] },
        models: { list: async () => ({ providers: [], configured: true, modelConfigPath: '', snapshotMissing: false }) },
        load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
        watch: () => () => undefined,
        drafts: { list: async () => ({ drafts: [] }), put: async () => ({ updatedAt: 0 }), remove: async () => ({}) },
    } as never);
    actions.bootstrap();
    // bootstrap 是 fire-and-forget，等它把 emit 做完（两轮微任务足够）
    await new Promise((resolve) => setTimeout(resolve, 0));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await renderAll();
    // store 是**模块级单例**：上一个用例可能把「在看哪儿」留在别处。每个用例都从
    // 「第一个房间」出发，否则 navigate 会早退（同一位置不动），计数永远是 0。
    await act(async () => {
        actions.navigate({ page: 'room', id: 'proj:diy' });
    });
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe('父级重渲不穿透到行', () => {
    it('基准：这一套计数确实量得到（列表换了一份时，三行都被穿透）', async () => {
        const mark = tally.mark();
        // 改状态 → PATCH → refresh → `rooms` 整份换新（元素也是新对象）
        await act(async () => {
            await actions.setRoomStatus('task:t-open', 'open');
        });
        const count = tally.since(mark);
        for (const id of TREE_ROWS) expect(count(`row:${id}`)).toBeGreaterThan(0);
        // 历史区那一行也还在
        expect(container.innerHTML).toContain('收工的任务');
    });

    it('换高亮时侧栏确实重渲了（探针作证），但一行都没被穿透', async () => {
        const mark = tally.mark();
        await act(async () => {
            actions.navigate({ page: 'room', id: 'task:t-open' });
        });
        const count = tally.since(mark);
        // 父级重渲的证据：navContext 变了，注册来源的 render 被再调一次
        expect(count('probe:source')).toBeGreaterThan(0);
        // 行一次都没进 render：`rooms` 引用没变、回调引用没变 → `memo` 全部跳过
        for (const id of TREE_ROWS) expect(count(`row:${id}`)).toBe(0);
    });

    it('跟侧栏无关的一次 emit（改默认模型）同样一行不动', async () => {
        const mark = tally.mark();
        await act(async () => {
            actions.setDefaultModel('m-other');
        });
        const count = tally.since(mark);
        for (const id of TREE_ROWS) expect(count(`row:${id}`)).toBe(0);
        expect(count('probe:source')).toBe(0);
    });
});

describe('行内那一格变了：单值订阅只通知该通知的', () => {
    it('换高亮只碰两行（旧的灭、新的亮），第三行一次都不重渲', async () => {
        // 首屏地址落在第一个房间（proj:diy）→ 切到它下面的任务
        const mark = tally.mark();
        await act(async () => {
            actions.navigate({ page: 'room', id: 'task:t-open' });
        });
        const count = tally.since(mark);
        expect(count('probe:current:proj:diy')).toBe(1);
        expect(count('probe:current:task:t-open')).toBe(1);
        expect(count('probe:current:stock-1')).toBe(0);
        // 界面上的高亮也确实跟着走了（不是只有 hook 层对了）
        expect(container.querySelector('[data-probe="current:task:t-open"]')?.textContent).toBe('on');
        expect(container.querySelector('[data-probe="current:proj:diy"]')?.textContent).toBe('off');
    });

    it('切到同一行是空操作（不发任何重渲）', async () => {
        await act(async () => {
            actions.navigate({ page: 'room', id: 'task:t-open' });
        });
        const mark = tally.mark();
        await act(async () => {
            actions.navigate({ page: 'room', id: 'task:t-open' });
        });
        const count = tally.since(mark);
        expect(count('probe:current:proj:diy')).toBe(0);
        expect(count('probe:current:task:t-open')).toBe(0);
        expect(count('probe:source')).toBe(0);
    });

    it('列表本身没换（只是高亮变了）时，订阅 rooms 的探针不动', async () => {
        const mark = tally.mark();
        await act(async () => {
            actions.navigate({ page: 'room', id: 'task:t-open' });
        });
        expect(tally.since(mark)('probe:rooms')).toBe(0);
    });
});

describe('判据落点：这些组件必须保持 memo，否则上面几条会静默失效', () => {
    it('RoomRow 是 memo 组件，本体是普通函数', async () => {
        const rowModule =
            await vi.importActual<typeof import('../src/components/RoomRow')>('../src/components/RoomRow');
        expect((rowModule.RoomRow as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
        expect(typeof rowModule.RoomRowView).toBe('function');
    });
});

describe('SSR（没有 DOM 的宿主）不因为新选择器而炸', () => {
    it('renderToStaticMarkup 仍能出完整侧栏', () => {
        const html = renderToStaticMarkup(<Sidebar {...HOST} />);
        expect(html).toContain('diy');
        expect(html).toContain('未归属');
    });
});
