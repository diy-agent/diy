// jobsChip.test.tsx —— 底栏那枚「作业」chip 的空状态（用户 2026-11-24 裁）。
//
// 用户原话：「作业跑完了需要消失，只需要 0 空状态即可，这样还能点进去看历史」——
// 前半句说的是**那个跳动的绿点**要消失，不是整枚 chip。所以钉住两件事：
//   1. 0 条在跑时 chip **仍然占位置**（第一版这里是 `return null`，等于把进历史账本的
//      唯一入口也一起藏了）；
//   2. 0 条在跑时**不动**（没有 animate-ping）、也不写数字和时长 —— 空状态就长得像空状态。
//
// SSR 到字符串（仓库里 entity-chat 的既有姿势，没有 jsdom）：effect 不跑 ⇒ rows 恒为 []，
// 正好就是「什么都没在跑」。

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { JobsChip } from '../src/components/JobsChip';

describe('作业 chip 的空状态', () => {
    it('没有作业在跑时仍然渲染（历史账本的入口不许跟着消失）', () => {
        const html = renderToStaticMarkup(<JobsChip />);
        expect(html).toContain('作业');
        expect(html).toContain('<button');
    });

    it('空状态不动、不写数字：没有跳动的点', () => {
        const html = renderToStaticMarkup(<JobsChip />);
        expect(html).not.toContain('animate-ping');
        expect(html).not.toContain('tabular-nums'); // 时长那一段（`3m20s`）只在有在跑的时出现
    });

    it('title 说清「点开看的是历史」', () => {
        const html = renderToStaticMarkup(<JobsChip />);
        expect(html).toContain('现在没有在跑的');
    });
});
