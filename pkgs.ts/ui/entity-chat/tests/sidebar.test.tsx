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
        botProfiles: { list: async () => [] },
        // 模型目录回包里的 `configured` / `snapshotMissing` 是真状态字段（横幅据此画），不是兼容字段
        models: {
            list: async () => ({ providers: [], configured: true, modelConfigPath: '', snapshotMissing: false }),
        },
        load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
        watch: () => () => undefined,
        drafts: { list: async () => ({ drafts: [] }), put: async () => ({ updatedAt: 0 }), remove: async () => ({}) },
    } as never);
    actions.bootstrap();
    // bootstrap 是 fire-and-forget，等它把 emit 做完（两轮微任务足够）
    await new Promise((resolve) => setTimeout(resolve, 100));
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

    it('运行态画在状态图标上：项目行不聚合子任务，行底色只表选中', async () => {
        setDiy2Client({
            rooms: { list: async () => rooms.map((room) => ({ ...room, running: room.id === 'task:t-open' ? 1 : 0 })) },
            botProfiles: { list: async () => [] },
            models: { list: async () => ({ providers: [] }) },
            load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
            watch: () => () => undefined,
            drafts: {
                list: async () => ({ drafts: [] }),
                put: async () => ({ updatedAt: 0 }),
                remove: async () => ({}),
            },
        } as never);
        actions.bootstrap();
        await new Promise((resolve) => setTimeout(resolve, 100));

        const html = render();
        // 在跑的那一行：状态图标上有呼吸点
        expect(rowOf(html, '/room/task/t-open')).toContain('aria-label="正在运行"');
        // 项目行**不聚合子任务**的运行态（子行自己会亮；聚合会让同一个状态在树上出现两次，
        // 也被读成「项目在跑」——2026-11-25 用户报的「空会话也有轮次中呼吸」）
        expect(rowOf(html, '/room/proj/diy')).not.toContain('aria-label="正在运行"');
        // 底色只表「当前在看哪一行」：没选中这一行时，在跑的它也不带 bg-accent
        expect(rowOf(html, '/room/task/t-open')).not.toContain('bg-accent');
    });

    it('项目行也有任务行那套状态：自己出错变红 / 自己在跑呼吸 / 自己排队转', async () => {
        // 用户 2026-11-26：「项目也是 bot，也需要有和任务一样的状态图标信息」。
        // 项目房间自己就有成员和轮次（实数据里 `proj:diy` 跑了 131 轮），所以「上一轮出错」
        // 「正在运行」「排队」对项目同样成立 —— 注意这三项都是**它自己的**，不是子任务的。
        setDiy2Client({
            rooms: {
                list: async () =>
                    rooms.map((room) =>
                        room.id === 'proj:diy' ? { ...room, broken: 1, running: 1, queued: 2 } : room,
                    ),
            },
            botProfiles: { list: async () => [] },
            models: { list: async () => ({ providers: [] }) },
            load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
            watch: () => () => undefined,
            drafts: {
                list: async () => ({ drafts: [] }),
                put: async () => ({ updatedAt: 0 }),
                remove: async () => ({}),
            },
        } as never);
        actions.bootstrap();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const projectRow = rowOf(render(), '/room/proj/diy');
        expect(projectRow).toContain('text-rose-400'); // 上一轮出错
        expect(projectRow).toContain('aria-label="正在运行"');
        expect(projectRow).toContain('aria-label="有消息在排队"');
        // 形状仍是文件夹（项目没有 open / closed）—— 变的是颜色与装饰，不是形状
        expect(projectRow).toContain('lucide-folder');
    });

    it('排队中的投递在行上看得到（灰旋转，且不被读成「在跑」）', async () => {
        // 刀 2：以前 `deliveries` 的 queued / delivering（含重启后的待续跑）在界面完全看不见 ——
        // 房间看着“什么都没发生”，其实它排着队
        setDiy2Client({
            rooms: {
                list: async () => rooms.map((room) => ({ ...room, queued: room.id === 'task:t-open' ? 2 : 0 })),
            },
            botProfiles: { list: async () => [] },
            models: { list: async () => ({ providers: [] }) },
            load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
            watch: () => () => undefined,
            drafts: {
                list: async () => ({ drafts: [] }),
                put: async () => ({ updatedAt: 0 }),
                remove: async () => ({}),
            },
        } as never);
        actions.bootstrap();
        await new Promise((resolve) => setTimeout(resolve, 100));

        const html = render();
        const queuedRow = rowOf(html, '/room/task/t-open');
        expect(queuedRow).toContain('aria-label="有消息在排队"');
        expect(queuedRow).toContain('2 条消息在排队等 bot 接收');
        expect(queuedRow).not.toContain('aria-label="正在运行"'); // 排队 ≠ 在跑，两颗是两种语义
        // 全侧栏**只有那一颗**（没排队的行不跟风画）。用整份 html 数而不是 rowOf：
        // 历史块里的行没有 `group relative flex w-full` 这个切分点，rowOf 会切到别的行去。
        expect(html.match(/aria-label="有消息在排队"/g) ?? []).toHaveLength(1);
    });

    it('未读在行上看得见（蓝点）—— 与「等你回答」的 ? 分得开', async () => {
        setDiy2Client({
            rooms: {
                list: async () => rooms.map((room) => ({ ...room, unread: room.id === 'task:t-open' ? 3 : 0 })),
            },
            botProfiles: { list: async () => [] },
            models: { list: async () => ({ providers: [] }) },
            load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
            watch: () => () => undefined,
            drafts: {
                list: async () => ({ drafts: [] }),
                put: async () => ({ updatedAt: 0 }),
                remove: async () => ({}),
            },
        } as never);
        actions.bootstrap();
        await new Promise((resolve) => setTimeout(resolve, 100));

        const html = render();
        const unreadRow = rowOf(html, '/room/task/t-open');
        expect(unreadRow).toContain('aria-label="有未读消息"');
        expect(unreadRow).toContain('3 条未读');
        // 未读 ≠ 等你回答：那颗 ? 不该因为未读就冒出来
        expect(unreadRow).not.toContain('aria-label="有提问等你回答"');
        expect(html.match(/aria-label="有未读消息"/g) ?? []).toHaveLength(1);
    });

    it('上一轮出错时侧栏任务图标变红（与三级表格同一份事实）', async () => {
        setDiy2Client({
            rooms: {
                list: async () => rooms.map((room) => ({ ...room, broken: room.id === 'task:t-open' ? 1 : 0 })),
            },
            botProfiles: { list: async () => [] },
            models: { list: async () => ({ providers: [] }) },
            load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
            watch: () => () => undefined,
            drafts: {
                list: async () => ({ drafts: [] }),
                put: async () => ({ updatedAt: 0 }),
                remove: async () => ({}),
            },
        } as never);
        actions.bootstrap();
        await new Promise((resolve) => setTimeout(resolve, 100));

        const html = render();
        expect(rowOf(html, '/room/task/t-open')).toContain('text-rose-400');
        expect(rowOf(html, '/room/task/t-open')).toContain('上一轮出错');
        expect(html.match(/text-rose-400/g) ?? []).toHaveLength(1);
    });

    it('未送达是另一个维度：红叉不混进排队 / 未读 / 上一轮出错，任务与项目都画', async () => {
        setDiy2Client({
            rooms: {
                list: async () =>
                    rooms.map((room) => {
                        if (room.id === 'task:t-open') return { ...room, failed: 2, queued: 1 };
                        if (room.id === 'proj:diy') return { ...room, failed: 1 };
                        return room;
                    }),
            },
            botProfiles: { list: async () => [] },
            models: { list: async () => ({ providers: [] }) },
            load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
            watch: () => () => undefined,
            drafts: {
                list: async () => ({ drafts: [] }),
                put: async () => ({ updatedAt: 0 }),
                remove: async () => ({}),
            },
        } as never);
        actions.bootstrap();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const html = render();
        const taskRow = rowOf(html, '/room/task/t-open');
        const projectRow = rowOf(html, '/room/proj/diy');
        expect(taskRow).toContain('aria-label="有消息未送达"');
        expect(taskRow).toContain('2 个成员的最新消息未送达');
        expect(taskRow).toContain('aria-label="有消息在排队"');
        expect(projectRow).toContain('aria-label="有消息未送达"');
        // 没喂 broken 就别自己把图标染红：未送达 ≠ 上一轮跑坏
        expect(taskRow).not.toContain('上一轮出错');
        expect(html.match(/aria-label="有消息未送达"/g) ?? []).toHaveLength(2);
    });

    it('rail 收起态也有未送达红叉（没有文字，靠形状 + 颜色读）', async () => {
        setDiy2Client({
            rooms: {
                list: async () => rooms.map((room) => ({ ...room, failed: room.id === 'proj:diy' ? 1 : 0 })),
            },
            botProfiles: { list: async () => [] },
            models: { list: async () => ({ providers: [] }) },
            load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
            watch: () => () => undefined,
            drafts: {
                list: async () => ({ drafts: [] }),
                put: async () => ({ updatedAt: 0 }),
                remove: async () => ({}),
            },
        } as never);
        actions.bootstrap();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const html = renderToStaticMarkup(<Sidebar {...HOST} open={false} />);
        expect(html).toContain('aria-label="有消息未送达"');
        expect(html.match(/aria-label="有消息未送达"/g) ?? []).toHaveLength(1);
        expect(html).toContain('个成员的消息未送达'); // 链接 title 在 rail 里承担说明
    });

    it('最后活动用紧凑相对式（刚才 / 5m / 1d），绝对时刻进 tooltip', async () => {
        const fiveMinutesAgo = Date.now() - 5 * 60_000;
        setDiy2Client({
            rooms: {
                list: async () =>
                    rooms.map((room) =>
                        room.id === 'task:t-open' ? { ...room, lastActivityAt: fiveMinutesAgo } : room,
                    ),
            },
            botProfiles: { list: async () => [] },
            models: { list: async () => ({ providers: [] }) },
            load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
            watch: () => () => undefined,
            drafts: {
                list: async () => ({ drafts: [] }),
                put: async () => ({ updatedAt: 0 }),
                remove: async () => ({}),
            },
        } as never);
        actions.bootstrap();
        await new Promise((resolve) => setTimeout(resolve, 100));

        const row = rowOf(render(), '/room/task/t-open');
        expect(row).toContain('>5m<'); // 用户 2026-11-26：改回 1m / 1d 这种紧凑式
        expect(row).toContain('最后活动 20'); // tooltip 里是绝对时刻
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

// ── 置顶区（pin）────────────────────────────────────────────
describe('侧栏顶部「置顶」区', () => {
    /** 一个被 pin 的任务：与项目树里的任务同项目，用来验「挪走」而不是「复制一份」 */
    const pinnedTask: Room = {
        id: 'task:t-pin',
        type: 'task',
        modelKey: 'm',
        data: { title: '天天要看的任务', projectId: 'proj:diy', status: 'open', pinnedAt: 2000 },
        botIds: [],
    };

    /** 换一份房间列表再 bootstrap（beforeEach 那份没有 pin，两处都要能各自成立） */
    async function bootWith(list: Room[]): Promise<void> {
        setDiy2Client({
            rooms: { list: async () => list },
            botProfiles: { list: async () => [] },
            models: {
                list: async () => ({ providers: [], configured: true, modelConfigPath: '', snapshotMissing: false }),
            },
            load: async () => ({ items: [], deliveries: [], asks: [], answeredAsks: [] }),
            watch: () => () => undefined,
            drafts: {
                list: async () => ({ drafts: [] }),
                put: async () => ({ updatedAt: 0 }),
                remove: async () => ({}),
            },
        } as never);
        actions.bootstrap();
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    it('被 pin 的任务在顶部单独一块，行上带项目名，项目树里不再有第二份', async () => {
        await bootWith([...rooms, pinnedTask]);
        const html = render();
        // 位置：置顶块在项目树那一行**之前**（它是侧栏最上面那块）
        const pinnedAt = html.indexOf('data-sidebar-pinned');
        expect(pinnedAt).toBeGreaterThanOrEqual(0);
        expect(pinnedAt).toBeLessThan(html.indexOf('href="/room/proj/diy"'));
        // 内容：行 + 归属 tag（从这里挪出来之后，项目名是它唯一的归属线索）
        expect(html).toContain('天天要看的任务');
        expect(html).toContain('title="项目：diy"');
        // 去重：整个侧栏里这个链接只出现一次（不在项目树下再重复一份）
        expect(html.split('href="/room/task/t-pin"').length - 1).toBe(1);
    });

    it('没有 pin 的任务时整块不渲染（不留一个空分组头）', () => {
        expect(render()).not.toContain('data-sidebar-pinned');
    });

    it('置顶按钮在行上，不在 ⋮ 菜单里（用户 2026-11-28：“放到外面，用的很频繁”）', async () => {
        await bootWith([...rooms, pinnedTask]);
        const html = render();
        // 未置顶的行：#46 没有（fixture 里都不是 pin 的）→ 新一行带「置顶」
        expect(rowOf(html, '/room/task/t-pin')).toContain('aria-label="取消置顶"');
        expect(rowOf(html, '/room/task/t-open')).toContain('aria-label="置顶"');
        // 同一个动作不“在菜单里再放一份”：侧栏 HTML 里每行只有一颗置顶按钮
        expect(html.split('aria-label="取消置顶"').length - 1).toBe(1);
    });

    it('侧栏收起成 rail 时置顶的任务仍以图标可见（pin 的用处就是快切）', async () => {
        await bootWith([...rooms, pinnedTask]);
        const html = renderToStaticMarkup(<Sidebar {...HOST} open={false} />);
        expect(html).toContain('data-sidebar-pinned');
        expect(html).toContain('href="/room/task/t-pin"');
    });
});
