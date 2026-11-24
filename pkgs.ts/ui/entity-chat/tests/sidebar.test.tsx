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

beforeEach(async () => {
    // 命令面走 RPC：注入假客户端，喂一份固定的房间列表（目录为空 = 用服务端缺省模型）
    setDiy2Client({
        rooms: { list: async () => rooms },
        roles: { list: async () => [] },
        // 模型目录回包里的 `configured` / `snapshotMissing` 是真状态字段（横幅据此画），不是兼容字段
        models: { list: async () => ({ providers: [], configured: true, modelConfigPath: '', snapshotMissing: false }) },
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
