// global.tsx —— 全局层向标题栏注册的按钮：导航开关 / 活动入口 / 设置。**唯一清单**。
//
// 为什么单独成文件（2026-11-28，##43）：这份清单原来是 App.tsx 里一段 inline 的
// `useMemo`，于是它成了「谁重写 App.tsx 谁就丢一颗」的高发区 —— 实际丢过两次：
//   1. 2026-11-25 合 main（27f011c6）：main 的 PR #552 带来 BotsOverlay 那颗，与本分支的
//      `sessions`（"Bot N"）重复，合并时把旧的删了、留了新的；
//   2. 之后 astryx 面删除 + bot-overview 下线，BotsOverlay 那套整体没了 —— 两条互斥路径
//      先后被删，结果标题栏**一颗 Bot 都没有**，而没有任何测试断言「必须有一颗」。
// 教训不是「记得加回去」，而是：标题栏上「必须存在哪些入口」得有个有名字、被测试守着的
// 来源。清单住在这里，`GlobalChrome` 是唯一输入面；改这里要跑 apps/diy2 的单测。
//
// 装什么（用户 2026-11-24 裁，2026-11-28 重申）：活动区两颗**并列，不合并** ——
//   · `bot`  —— 有 Bot 在跑（一轮对话在动）。点击弹出正在运行的房间列表。
//   · `jobs` —— 有后台进程在跑（本实例全部）。点击打开展开式作业面板。
// 两个数字口径不同（房间里的轮次 vs 实例级进程），合并成一个数之后「为什么亮」说不清，
// 点进去也不知道该看哪儿。两颗哪怕都是 0 也常显（否则人分不清「没在跑」和「坏了」）。

import { ActiveJobsGlyph, ActiveSessionsGlyph, navigate, roomAddressOf } from '@diy-agent/entity-chat';
import { Menu, Settings } from 'lucide-react';

import { SETTINGS_ADDRESS } from './settings';
import type { WindowContribution } from './window';

/** 活动区**必须**有的入口（顺序 = 显示顺序）。测试按这份清单钉住，别只改一处。 */
export const GLOBAL_ACTIVITY_IDS = ['bot', 'jobs', 'settings'] as const;

export interface GlobalChrome {
    /** 导航开关：左端那颗（标题栏是整宽的一条，导航自己不再挂收起按钮） */
    nav: { open: boolean; onToggle: () => void };
    /** 设置：同一颗按钮来回切；`backToRoomId` = 在设置页时「返回对话」回哪一间 */
    settings: { on: boolean; backToRoomId?: string | undefined };
    /** 活动区那颗「后台任务」点击后要打开的（作业面板不挂任何页，没房间时也要能开） */
    onOpenJobs: () => void;
}

/** 全局层向标题栏注册的贡献（导航开关 + 活动区） */
export function globalContributions(input: GlobalChrome): WindowContribution[] {
    const { nav, settings, onOpenJobs } = input;
    return [
        {
            id: 'nav',
            leading: [
                {
                    id: 'nav',
                    label: nav.open ? '收起导航' : '展开导航',
                    glyph: <Menu className="wb-glyph" />,
                    on: nav.open,
                    onClick: nav.onToggle,
                },
            ],
        },
        {
            id: 'activity',
            activity: [
                {
                    id: 'bot',
                    // 这颗自带 Popover（点击要弹运行中房间列表），所以 standalone：
                    // 再套一层 button 会变成 button 里嵌 button，点击语义就打架了
                    label: 'Bot 活动：查看正在运行的 Bot 列表',
                    glyph: <ActiveSessionsGlyph />,
                    standalone: true,
                },
                {
                    id: 'jobs',
                    // 「后台任务」两个口径（用户 2026-11-24）：这颗 = **本实例全部**（跨房间）；
                    // 房间内输入框底栏那颗 = 本房间。文案必须带上口径，否则两个数字对不上时没人解释得清。
                    label: '后台任务（本实例全部）：有任务在跑时呼吸，点击打开面板',
                    glyph: <ActiveJobsGlyph />,
                    onClick: onOpenJobs,
                },
                {
                    id: 'settings',
                    // 同一颗按钮来回切：设置页里它显示为按下态，再点一下回对话。
                    label: settings.on ? '返回对话' : '设置',
                    glyph: <Settings className="wb-glyph" />,
                    on: settings.on,
                    onClick: () => {
                        if (!settings.on) {
                            navigate(SETTINGS_ADDRESS);
                            return;
                        }
                        if (settings.backToRoomId !== undefined) navigate(roomAddressOf({ id: settings.backToRoomId }));
                    },
                },
            ],
        },
    ];
}
