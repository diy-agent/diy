// skeletons.ts —— **宿主的词汇表**：页骨架。
//
// 对应 theia / VS Code 的 viewsContainers：容器（explorer / activitybar / panel）属于宿主，
// 插件只能在 contributes.views 里说「我进 explorer 这个槽」。容器内部怎么排、几行几列、
// 谁默认折叠，插件管不着 —— theia 里唯一的布局信息是 `initialSize`（相对比例）和
// `visibility`，用户拖过就作废（见 theia sample-plugins/plugin-view-layout 的 README）。
//
// 这个文件就是同一件事的最小版本：骨架名是宿主认的字符串，插件清单只能**引用**它：
//
//   package.json: { "contributes": { "pages": [{ "skeleton": "two-pane" }] } }
//
// 于是插件作者写的是「插在哪」，宿主写的是「长什么样」。想加一种布局 = 这里加一项
// （宿主改动，要发版）；想加一个业务页 = 插件里加一个 package.json（不用碰宿主）。

import { area, col, row, type AreaNode } from '@diy-agent/workbench-dock';

export interface Skeleton {
    /** 给人看的一句话（rail / 报错文案用） */
    label: string;
    /** 区域树。槽位大小 / 最小宽 / 初始折叠都在这 —— 它们是布局，不是插件的事 */
    areas: AreaNode;
}

/**
 * 宿主的全部骨架。键就是插件清单里 `skeleton` 能写的值。
 *
 * 槽位名（sidebar / main / aside / bottom）也是宿主定的：插件只写 `"area": "main"`，
 * 不写「左边 240px 那一格」。
 */
export const SKELETONS = {
    'two-pane': {
        label: '左右两栏',
        areas: row([area('sidebar', { size: 240, min: 180 }), area('main', { size: '1fr', min: 320 })]),
    },
    'three-pane-bottom': {
        label: '三列 + 底部',
        areas: col([
            row([
                area('sidebar', { size: 240, min: 180 }),
                area('main', { size: '1fr', min: 380 }),
                area('aside', { size: 260, min: 200, initial: 'collapsed' }),
            ]),
            // 底栏横跨上面三列：它在 col 的第二个孩子位置
            area('bottom', { size: 200, min: 120, initial: 'collapsed' }),
        ]),
    },
} satisfies Record<string, Skeleton>;

/** 插件清单里 `skeleton` 的合法取值 */
export type SkeletonName = keyof typeof SKELETONS;

/** 骨架的槽位名（顺序 = 树里从左到右 / 从上到下）；校验和报错文案都用它 */
export function slotsOf(node: AreaNode): string[] {
    return node.type === 'region' ? [node.id] : node.data.children.flatMap(slotsOf);
}
