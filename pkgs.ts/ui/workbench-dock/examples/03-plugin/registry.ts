// registry.ts —— 宿主侧：把「包」变成「能渲染的 page」。
//
// 插件 = 一个**包**：package.json 的 `contributes` 说它有什么、插在哪；index.tsx 给实现。
// 和 theia / VS Code 同构 —— contributes 是 package.json 的一个字段，不是另一份清单文件。
//
// 「插件化」是两个自由度，它们落在不同的地方：
//
//   ① 贡献点（插件写，纯数据）
//        contributes.pages[]   我要开一个页，用宿主哪个骨架
//        contributes.views{}   key = 页类型，值 = 我往那些页的哪些槽塞内容
//        （key 可以是**别人**贡献的页 —— theia 里的 `"views": { "explorer": [...] }`）
//
//   ② 装配（宿主写）
//        装哪些包、每个页开哪个 scope、骨架长什么样、用户拖过之后存盘优先
//
// 所以这里没有「JSON 区域树 → AreaNode」的翻译函数：**树根本不进清单**。
// 那份翻译（连同 toAreaNode / leaves / 交叉校验）原来占了这个文件的一半。

import {
    definePage,
    defineView,
    type PageDef,
    type Scope,
    type ViewDef,
    type ViewProps,
} from '@diy-agent/workbench-dock';
import type { ComponentType } from 'react';
import { SKELETONS, slotsOf, type SkeletonName } from './skeletons';

// ── 清单的形状（package.json 里 contributes 那一段）─────────────────────────

export interface PageContribution {
    type: string;
    title: string;
    icon?: string;
    /** 宿主骨架名 —— 布局归宿主，插件只引用 */
    skeleton: SkeletonName;
}

export interface ViewContribution {
    id: string;
    title: string;
    icon?: string;
    /** 骨架里的槽位名（不是坐标、不是尺寸） */
    area: string;
    /** 该槽的默认 tab；同一槽至多一个 */
    primary?: boolean;
}

/** 一个插件包的 package.json */
export interface PluginManifest {
    name: string;
    version: string;
    /** 宿主不支持就整份拒绝，不静默降级（theia 里这一位是 engines.vscode） */
    diy: { apiVersion: 1 };
    contributes?: {
        pages?: PageContribution[];
        /** key = 页类型；可以指向别的插件贡献的页 */
        views?: Record<string, ViewContribution[]>;
    };
}

/** 一个插件包：清单（package.json）+ 代码（本进程的 import） */
export interface PluginPackage {
    manifest: PluginManifest;
    /** view id → 组件。清单声明了但这里没有 = 版本对不上，加载时报错 */
    views: Record<string, ComponentType<ViewProps<Scope>>>;
}

/** 加载结果，可以直接喂给 <PageWorkbench page views /> */
export interface Contribution {
    /** 贡献这个**页**的包名 */
    pluginId: string;
    page: PageDef<Scope>;
    views: ViewDef<Scope>[];
    /** view id → 贡献它的包名（可能不是 pluginId：跨插件贡献） */
    sources: Record<string, string>;
}

// ── 包 → 模型（两阶段：页必须先全部存在，view 才知道往哪落）─────────────────

/**
 * 加载一批插件包。任何一处不合法都在**这里**炸，不是运行时白屏。
 *
 * @throws Error 清单自身不合法 / 包之间撞车 / 清单和代码对不上
 * @throws ModelError 骨架本身不合法（由 definePage 抛）
 */
export function loadPlugins(packages: readonly PluginPackage[]): Contribution[] {
    // ① 阶段一：校验每份清单 + 收集所有页
    const pages = new Map<string, { page: PageDef<Scope>; pluginId: string }>();
    for (const { manifest } of packages) {
        const id = manifest.name;
        if (!id) throw new Error('package.json 缺 name');
        if (manifest.diy?.apiVersion !== 1) {
            throw new Error(`插件 ${id}: diy.apiVersion ${manifest.diy?.apiVersion} 不受支持（本宿主只认 1）`);
        }
        for (const page of manifest.contributes?.pages ?? []) {
            const owner = pages.get(page.type);
            if (owner) throw new Error(`页类型重复: ${page.type}（${owner.pluginId} / ${id}）`);
            const skeleton = SKELETONS[page.skeleton];
            if (!skeleton) {
                throw new Error(
                    `插件 ${id}: 页 "${page.type}" 用了不存在的骨架 "${page.skeleton}"（宿主有 ${Object.keys(SKELETONS).join(' / ')}）`,
                );
            }
            pages.set(page.type, {
                pluginId: id,
                page: definePage<Scope>({ type: page.type, title: page.title, icon: page.icon, areas: skeleton.areas }),
            });
        }
    }

    // ② 阶段二：收 view —— 落到哪个页的哪个槽
    const byPage = new Map<string, ViewDef<Scope>[]>();
    const sources: Record<string, string> = {};
    for (const { manifest, views: components } of packages) {
        const id = manifest.name;
        for (const [pageType, declared] of Object.entries(manifest.contributes?.views ?? {})) {
            const target = pages.get(pageType);
            if (!target) {
                throw new Error(
                    `插件 ${id}: 往不存在的页 "${pageType}" 贡献 view（现有 ${[...pages.keys()].join(' / ') || '无'}）`,
                );
            }
            const slots = slotsOf(target.page.areas);
            const known = new Set(slots);
            for (const view of declared) {
                if (sources[view.id]) throw new Error(`view id 重复: ${view.id}（${sources[view.id]} / ${id}）`);
                if (!known.has(view.area)) {
                    throw new Error(
                        `插件 ${id}: view "${view.id}" 落在 "${view.area}"，但页 "${pageType}" 的骨架只有 ${slots.join(' / ')}`,
                    );
                }
                const component = components[view.id];
                if (!component) {
                    throw new Error(`插件 ${id}: 清单声明了 view "${view.id}"，但 index.tsx 没实现`);
                }
                sources[view.id] = id;
                const defs = byPage.get(pageType) ?? [];
                defs.push(
                    defineView<Scope>({
                        id: view.id,
                        title: view.title,
                        icon: view.icon,
                        placement: { [pageType]: { area: view.area, primary: view.primary } },
                        render: { kind: 'react', component },
                    }),
                );
                byPage.set(pageType, defs);
            }
        }
    }

    // ③ 按包的出现顺序输出（= rail 的顺序）；每个页只带自己的 view
    return [...pages].map(([pageType, { page, pluginId }]) => {
        const views = byPage.get(pageType) ?? [];
        const own: Record<string, string> = {};
        for (const view of views) own[view.id] = sources[view.id]!;
        return { pluginId, page, views, sources: own };
    });
}
