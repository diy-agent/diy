// sidebar.test.tsx —— 侧栏真的按注册表渲染吗？（SSR 到字符串，不需要 DOM）
//
// 为什么值得一个「渲染冒烟」：插槽这种改动，类型检查和纯函数测试都盖不到「来源到底
// 有没有被铺出来」—— 忘了 registerBuiltinNav 也能通过 tsc，表现只是侧栏安静地空着。
// 这里用 renderToStaticMarkup 断言三类事实：
//   1. 有数据时内建三块都在（项目 / 历史 / 未归属）；
//   2. 外部注册一个来源，它的输出真的出现在侧栏里（插槽是通的）；
//   3. 反注册之后它消失（热更新 / 插件卸载的路径）。
//   4. 底部设置入口是可选的（宿主自己已有入口时不传，如工作台的标题栏）。

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar';
import type { Room } from '../src/model';
import { registerNavSource, unregisterNavSource } from '../src/nav';
import { actions, setDiy2Client } from '../src/store';

const rooms: Room[] = [
    {
        id: 'proj:diy',
        type: 'project',
        modelKey: 'm',
        data: { name: 'diy', dir: '~/git/diy/diy' },
        botIds: [],
    },
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
    {
        id: 'stock-1',
        type: 'stock',
        modelKey: 'm',
        data: { name: '孤儿容器' },
        botIds: [],
    },
];

const HOST = {
    open: true,
    onToggle: () => undefined,
    onCreateProject: () => undefined,
    onCreateTask: () => undefined,
    onRequestDelete: () => undefined,
    onOpenSettings: () => undefined,
};

function render(): string {
    return renderToStaticMarkup(<Sidebar {...HOST} />);
}

/** 从 SSR 出来的 HTML 里取一行：按行容器切段，找包含这个链接的那一段 */
function rowOf(html: string, href: string): string {
    return html.split('class="group relative flex w-full').find((row) => row.includes(`href="${href}"`)) ?? '';
}

beforeEach(async () => {
    // 命令面走 RPC：注入假客户端，喂一份固定的房间列表（目录为空 = 用服务端缺省模型）
    setDiy2Client({
        rooms: { list: async () => rooms },
        bots: { list: async () => [] },
        models: { list: async () => ({ providers: [] }) },
        load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
        watch: () => () => undefined,
        drafts: { list: async () => ({ drafts: [] }), put: async () => ({ updatedAt: 0 }), remove: async () => ({}) },
    } as never);
    actions.bootstrap();
    // bootstrap 是 fire-and-forget，等它把 emit 做完（两轮微任务足够）
    await new Promise((resolve) => setTimeout(resolve, 0));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('侧栏按注册表渲染', () => {
    it('内建三块都在：项目树 / 历史任务 / 未归属', () => {
        const html = render();
        expect(html).toContain('项目');
        expect(html).toContain('diy');
        expect(html).toContain('data-sidebar-history');
        expect(html).toContain('收工的任务');
        expect(html).toContain('未归属');
        expect(html).toContain('孤儿容器');
    });

    it('运行态只画在任务行的状态图标上：项目行不聚合子任务，行底色只表选中', async () => {
        setDiy2Client({
            rooms: { list: async () => rooms.map((room) => ({ ...room, running: room.id === 'task:t-open' ? 1 : 0 })) },
            bots: { list: async () => [] },
            models: { list: async () => ({ providers: [] }) },
            load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
            watch: () => () => undefined,
            drafts: { list: async () => ({ drafts: [] }), put: async () => ({ updatedAt: 0 }), remove: async () => ({}) },
        } as never);
        actions.bootstrap();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const html = render();
        // 在跑的那一行：状态图标上有呼吸点
        expect(rowOf(html, '/room/task/t-open')).toContain('aria-label="正在运行"');
        // 项目行不因子任务在跑而亮（项目是导航壳、自己没有会话；聚合会让同一个状态出现两次）
        expect(rowOf(html, '/room/proj/diy')).not.toContain('aria-label="正在运行"');
        // 底色只表「当前在看哪一行」：没选中这一行时，在跑的它也不带 bg-accent
        expect(rowOf(html, '/room/task/t-open')).not.toContain('bg-accent');
    });

    it('排队中的投递在行上看得到（灰旋转，且不被读成「在跑」）', async () => {
        // 刀 2：以前 `deliveries` 的 queued / delivering（含重启后的待续跑）在界面完全看不见 ——
        // 房间看着“什么都没发生”，其实它排着队
        setDiy2Client({
            rooms: {
                list: async () => rooms.map((room) => ({ ...room, queued: room.id === 'task:t-open' ? 2 : 0 })),
            },
            bots: { list: async () => [] },
            models: { list: async () => ({ providers: [] }) },
            load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
            watch: () => () => undefined,
            drafts: { list: async () => ({ drafts: [] }), put: async () => ({ updatedAt: 0 }), remove: async () => ({}) },
        } as never);
        actions.bootstrap();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const html = render();
        const queuedRow = rowOf(html, '/room/task/t-open');
        expect(queuedRow).toContain('aria-label="有投递在排队"');
        expect(queuedRow).toContain('排队中 2 条');
        expect(queuedRow).not.toContain('aria-label="正在运行"'); // 排队 ≠ 在跑，两颗是两种语义
        // 全侧栏**只有那一颗**（没排队的行不跟风画）。用整份 html 数而不是 rowOf：
        // 历史块里的行没有 `group relative flex w-full` 这个切分点，rowOf 会切到别的行去。
        expect(html.match(/aria-label="有投递在排队"/g) ?? []).toHaveLength(1);
    });

    it('每个项目行都在行上提供新建任务按钮，不依赖三点菜单或空项目占位', () => {
        const html = render();
        expect(html).toContain('aria-label="在「diy」下新建任务"');
        expect(html).not.toContain('新建任务</button>');
    });

    it('导航项是真链接（可以直接复制 / 中键新窗口）', () => {
        const html = render();
        expect(html).toContain('href="/room/proj/diy"');
        expect(html).toContain('href="/room/task/t-open"');
    });

    it('已关闭的任务不进项目树（避免一处任务两处出现）', () => {
        const html = render();
        // 链接只出现一次 = 只在历史区那一行（项目树里不再有它）
        expect(html.split('href="/room/task/t-closed"').length - 1).toBe(1);
        // 未关闭的那个反过来：只在项目树里
        expect(html.split('href="/room/task/t-open"').length - 1).toBe(1);
    });

    it('底部设置入口可选：不传就不渲染（工作台把它放在标题栏）', () => {
        expect(render()).toContain('模型设置');
        const { onOpenSettings: _omit, ...rest } = HOST;
        expect(renderToStaticMarkup(<Sidebar {...rest} />)).not.toContain('模型设置');
    });

    it('外部注册的来源出现在侧栏里，反注册后消失', () => {
        expect(render()).not.toContain('插件贡献的分区');
        registerNavSource({
            id: 'test:plugin',
            order: 5,
            render: () => <div>插件贡献的分区</div>,
        });
        expect(render()).toContain('插件贡献的分区');
        unregisterNavSource('test:plugin');
        expect(render()).not.toContain('插件贡献的分区');
    });
});
