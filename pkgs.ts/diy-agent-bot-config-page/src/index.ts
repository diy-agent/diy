// index.ts — 主进程侧的页面贡献：`bot-config` 页的方法表。
//
// 装配层（apps/chat/index.ts）把它放进 `plugins` 清单 → 主进程交付页面 → 侧栏出现入口；
// **删掉那一行 = 主进程不交付页面 = nav 里没有「Bot 配置」**（renderer 侧即便注册了 view
// 也不会显示 —— 侧栏来自 listPages，注册表只决定「怎么画」）。
//
// 边界：
//   · 本文件不 import electron / 不碰 DOM：宿主注入 `home`（缺省读 `DIY_HOME`）
//   · 方法参数原样来自 renderer，统一在 actions.ts 校验
//   · 测试对话的会话只活在**本页面实例**的内存里（@diy-agent/session-store-memory），
//     页面不关、会话就不落盘；页面关了也就没了（##474 判据 4）

import type { PageContribution } from '@diy-agent/workbench';
import { createBotActions, type BotActions } from './actions.js';
import { BotConfigPageError } from './errors.js';

export interface BotConfigPageOptions {
    /** 数据根（`$DIY_HOME`）；缺省 = `process.env.DIY_HOME` */
    readonly home?: string;
}

/** 插件加载器会调用它（default 导出 = 本函数） */
export function createPage(config?: unknown): PageContribution {
    // actions 懒建一次：测试对话的内存会话挂在它身上，**每次 invoke 新建就等于每句话都忘掉上文**
    let actions: BotActions | null = null;
    const requireActions = (): BotActions => {
        if (actions !== null) return actions;
        const home = homeOf(config);
        if (home === null) {
            throw new BotConfigPageError(
                'bot-config/no-home',
                'Bot 配置页没有数据根：装配层没传 config.home，环境里也没有 DIY_HOME',
            );
        }
        actions = createBotActions({ home });
        return actions;
    };

    return {
        id: 'bot-config',
        title: 'Bot 配置',
        methods: {
            snapshot: () => requireActions().snapshot(),
            createBot: (args: unknown) => requireActions().create(args),
            saveBot: (args: unknown) => requireActions().save(args),
            removeBot: (args: unknown) => requireActions().remove(args),
            testSend: (args: unknown) => requireActions().testSend(args),
            testReset: (args: unknown) => requireActions().testReset(args),
        },
    };
}

export default createPage;

export { BotConfigPageError } from './errors.js';
export { createBotActions, nextBotId, resolveModelKey, wireOf } from './actions.js';
export type { BotActions, BotActionsOptions } from './actions.js';
export type {
    BotSnapshot,
    BotView,
    ModelOptionView,
    TestChatView,
    TestMessageView,
} from './shared.js';

function homeOf(config: unknown): string | null {
    if (config !== null && typeof config === 'object') {
        const home = (config as { home?: unknown }).home;
        if (typeof home === 'string' && home.trim() !== '') return home;
    }
    const fromEnv = process.env['DIY_HOME'];
    return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : null;
}
