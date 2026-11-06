// provider.ts —— 把 skills 接到上下文树（`skills` 节点）。
//
// 形状用**结构类型**而不是 import `@diy-agent/context` 的 `ContextProvider`：
// 本包的定位是「纯 IO 的清单收集」，不该为了一个三字段的接口反向依赖上下文包。
// 宿主（diy-app / bot）把它的返回值当 ContextProvider 用，形状对得上即可。

import { skillsOf, type SkillItem } from './index.js';

/** 与 `@diy-agent/context` 的 `ContextProvider` 同形（只声明本包用得到的部分） */
export interface SkillsProvider {
    readonly key: 'skills';
    /** 结构说明（进信封的 `help:` 段）；`items` 描述数组元素 */
    readonly help: Record<string, unknown>;
    provide(): readonly SkillItem[];
}

export interface SkillsProviderOptions {
    /** 起点目录（工具执行目录） */
    readonly cwd: string;
    /** 全局技能根（通常是 `~/.agents`） */
    readonly globalRoot: string;
    readonly stopAt?: string;
}

/**
 * 一个 provider：`provide()` 每次现扫（清单很短，扫一次 ~2ms；比缓存失效逻辑简单）。
 *
 * 为什么 `provide()` 里扫而不是构造时扫一次：宿主可能长驻（Electron 进程活几小时），
 * 而用户随时可能 `npx skills add` 装新技能 —— 每次现扫才能看见。
 */
export function skillsProvider(opts: SkillsProviderOptions): SkillsProvider {
    return {
        key: 'skills',
        help: {
            type: 'array',
            desc: '技能清单（空则整节跳过）',
            items: {
                name: { type: 'string', desc: '技能名' },
                desc: { type: 'string', desc: '说明（含触发词）' },
                path: { type: 'string', desc: 'SKILL.md 路径（要看全文就 read 它）' },
                scope: { type: 'string', desc: '属于哪一层（全局 / 某仓库）' },
            },
        },
        provide: () => skillsOf(opts),
    };
}
