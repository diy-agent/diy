// surfaces/registry.tsx —— 表面注册表：shell 只认这个数组，不写 if (tab === …)。
//
// 两面并存不是「选不出来」，而是刻意保留的 A/B：Astryx 面用设计系统的 Chat 组件，
// shadcn 面全裸 Tailwind —— 同一份时间线、同一套 chat-core，两种画法。
// 2026-11-23 已把两面能力对齐（共用 shared.ts 的映射与业务件，缺的复制 / @ 补全 /
// 回到底部 / 空态都补齐），第三面 assistant-ui 已删（它 2491 行 registry 件里大半能力
// 没有对应事实可接，见 docs/plans/2026-11-24-surface-parity.md）。
//
// 缺省是哪一面由壳层决定（App.tsx 取 'astryx'），这里不排序含义。

import type { FC } from 'react';

import { AstryxSurface } from './astryx/Surface';
import { ShadcnSurface } from './shadcn/Surface';

export interface ChatSurface {
    id: string;
    name: string;
    hint: string;
    Component: FC<{ targetId: string }>;
}

export const SURFACES: ChatSurface[] = [
    { id: 'astryx', name: 'Astryx', hint: '设计系统 Chat 组件 + chat-core', Component: AstryxSurface },
    { id: 'shadcn', name: 'shadcn', hint: '原生 Tailwind + chat-core，无 chat 库', Component: ShadcnSurface },
];
