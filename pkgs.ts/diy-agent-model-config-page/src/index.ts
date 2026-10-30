// index.ts — 主进程侧的页面贡献：`model-config` 页的方法表。
//
// 装配层（apps/chat/index.ts）把它放进 `plugins` 清单 → 主进程交付页面 → 侧栏出现入口；
// **删掉那一行 = 主进程不交付页面 = nav 里没有「模型配置」**（renderer 侧即便注册了 view
// 也不会显示 —— 侧栏来自 listPages，注册表只决定「怎么画」）。
//
// 边界：
//   · 本文件不 import electron / 不碰 DOM：宿主注入 `home`（缺省读 `DIY_HOME`）
//   · 方法参数原样来自 renderer，统一在 actions.ts 校验
//   · 返回值必须结构化克隆：快照里没有 key，账号只有名字 / 长度

import type { PageContribution } from '@diy-agent/workbench';
import {
    readSnapshot,
    removeProviderAction,
    saveAccountAction,
    saveDefaultModelAction,
    saveProviderAction,
} from './actions.js';
import { ModelConfigPageError } from './errors.js';

export interface ModelConfigPageOptions {
    /** 数据根（`$DIY_HOME`）；缺省 = `process.env.DIY_HOME` */
    readonly home?: string;
}

/** 插件加载器会调用它（default 导出 = 本函数） */
export function createPage(config?: unknown): PageContribution {
    // 每次调用现取：装配时 `DIY_HOME` 可能还没设（单测 / 纯库 import），不能把 null 固化下来
    const requireHome = (): string => {
        const home = homeOf(config);
        if (home === null) {
            throw new ModelConfigPageError(
                'model-config/no-home',
                '模型配置页没有数据根：装配层没传 config.home，环境里也没有 DIY_HOME',
            );
        }
        return home;
    };

    return {
        id: 'model-config',
        title: '模型配置',
        methods: {
            snapshot: () => readSnapshot(requireHome()),
            saveProvider: (args: unknown) => saveProviderAction(requireHome(), args),
            removeProvider: (args: unknown) => removeProviderAction(requireHome(), args),
            saveAccount: (args: unknown) => saveAccountAction(requireHome(), args),
            saveDefaultModel: (args: unknown) => saveDefaultModelAction(requireHome(), args),
        },
    };
}

export default createPage;

export { ModelConfigPageError } from './errors.js';
export {
    accountLabel,
    groupModels,
    modelKeyOf,
    readSnapshot,
    removeProviderAction,
    saveAccountAction,
    saveDefaultModelAction,
    saveProviderAction,
    savedAccountLabel,
} from './actions.js';
export type {
    AccountStateView,
    ConfigSnapshot,
    ModelView,
    ProviderView,
    SavedAccountView,
    WriteResult,
} from './shared.js';

function homeOf(config: unknown): string | null {
    if (config !== null && typeof config === 'object') {
        const home = (config as { home?: unknown }).home;
        if (typeof home === 'string' && home.trim() !== '') return home;
    }
    const fromEnv = process.env['DIY_HOME'];
    return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : null;
}
