// surfaces/registry.tsx —— 表面注册表：shell 只认这个数组，不写 if (tab === …)。
//
// 两面并存不是「选不出来」，而是刻意保留的 A/B：Astryx 面用设计系统的 Chat 组件，
// shadcn 面全裸 Tailwind —— 同一份时间线、同一套 chat-core，两种画法。
// 2026-11-23 已把两面能力对齐（共用 shared.ts 的映射与业务件，缺的复制 / @ 补全 /
// 回到底部 / 空态都补齐），第三面 assistant-ui 已删（它 2491 行 registry 件里大半能力
// 没有对应事实可接，见 docs/plans/2026-11-24-surface-parity.md）。
//
// 2026-11-25 裁决（见 surface-parity 文档 §7）：**Astryx 面冻结为参考实现** ——
// 不再追新功能、不进「每次 UI 改动双面验证」的门，只保编译通过与一条冒烟；
// 缺省面改为 shadcn。翻回 Astryx 只为两件事：核对某个交互该长什么样，
// 或者 canary 依赖炸了要临时换回。2~4 周真实使用后复查是否删除。
//
// 缺省是哪一面由壳层决定（现在取 'shadcn'），这里不排序含义。

import type { FC, ReactNode } from 'react';

import { AstryxSurface } from './astryx/Surface';
import { ShadcnSurface } from './shadcn/Surface';

export interface ChatSurface {
    id: string;
    name: string;
    hint: string;
    /**
     * `composerExtras` = 输入框底栏那一行（上下文 / 模型 / 作业）。
     *
     * 它由**壳层**渲染（`ComposerBar`：模型弹窗、上下文压缩都在壳里），surface 只把它摆进
     * 自己 composer 的底栏 —— 两面各长一份就必然漂移，而这三个 chip 与「哪个 surface」无关。
     */
    Component: FC<{ targetId: string; composerExtras?: ReactNode }>;
}

export const SURFACES: ChatSurface[] = [
    {
        id: 'astryx',
        name: 'Astryx',
        hint: '设计系统 Chat 组件 + chat-core',
        Component: AstryxSurface,
    },
    {
        id: 'shadcn',
        name: 'shadcn',
        hint: '原生 Tailwind + chat-core，无 chat 库',
        Component: ShadcnSurface,
    },
];
