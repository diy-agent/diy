// surface.ts —— 「现在用哪一面」这个偏好：**一份状态，两个宿主**。
//
// 2026-11-24 之前它是 `App` 里的一个 `useState`。用户要求把 Astryx / shadcn 这两颗 tab
// 「上移为 view 级别」—— 也就是画到**宿主的区域标题栏**里去（工作台的 `wb-area-bar`）。
// 于是这个选择不再只属于对话区自己的那一行：区域标题栏和对话区是两个组件，
// 状态必须落在两者之上。
//
// 为什么不继续用 props 传：宿主（diy2 的 workbench）要在区域标题栏里画这几颗 tab，
// 而它的 page 定义是模块级常量 —— 抽屉不到对话 view 的 useState。反过来把状态
// 提到宿主，又让 entity-chat 在「整页 App」形态下必须自带一份默认值。
// 模块级 + localStorage 是最短的一条：两处读同一份、刷新后还是那一面、多标签页也一致。

import * as React from 'react';

import { SURFACES } from './surfaces/registry';

const KEY = 'entity-chat:surface';

function load(): string {
    try {
        const saved = localStorage.getItem(KEY);
        if (saved !== null && SURFACES.some((surface) => surface.id === saved)) return saved;
    } catch {
        /* 存储不可用：用缺省 */
    }
    // 缺省 Astryx（虚拟化 + 自带代码高亮，长会话最稳）
    return SURFACES.find((surface) => surface.id === 'astryx')?.id ?? SURFACES[0]!.id;
}

let current = load();
const listeners = new Set<() => void>();

export function getSurfaceId(): string {
    return current;
}

export function setSurfaceId(id: string): void {
    if (id === current) return;
    if (!SURFACES.some((surface) => surface.id === id)) return;
    current = id;
    try {
        localStorage.setItem(KEY, id);
    } catch {
        /* 存储不可用：本次运行仍然生效 */
    }
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * 两面**都挂载**、只把非当前项隐藏 —— 这条策略留在使用方（App），这里只管「选哪一面」。
 */
export function useSurfaceId(): [string, (id: string) => void] {
    const id = React.useSyncExternalStore(subscribe, getSurfaceId, getSurfaceId);
    return [id, setSurfaceId];
}
