// bots.test.tsx —— 「Bot 状态」两级披露的口径（用户 2026-11-25 定的形状）。
//
// 钉住的三件事，都是「两处各算一遍」会立刻出错的地方：
//   1. 二级浮层只列**要人看见的**（非 idle）；全空闲时写「都闲着」而不是空白一片；
//   2. 三级抽屉的**默认筛选与二级一致**（点进去看到的是同一批，只是多了列和批量动作）；
//   3. 结局文案由 `outcomeTextOf` 一处给：出错的行在二级就能读出「为什么」。
//
// SSR 到字符串（entity-chat 的既有姿势，没有 jsdom）：effect 不跑 ⇒ 数据全从 props 来，
// 正好测「给定这批行，画出来是什么样」。

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * 把浮层外壳换成**透传**（2026-11-27 修）。
 *
 * `BotsOverlay` 的外层是官方 `Sheet`（Base UI 的 Dialog）：它把内容挂进 portal，
 * 而 portal 的挂在 SSR 下不跑（没有 effect）—— `renderToStaticMarkup` 只能拿到空串，
 * 于是「浮层里画了什么」一条都测不到（换 Sheet 后的 10 个红）。
 *
 * 这些用例测的是**内容与口径**（谁该列、空态写什么、两道筛选是否一致），
 * 不是 portal 怎么挂载 —— 后者属于真机/截图验证的范围。所以把外壳换成 Fragment。
 */
vi.mock('@diy-agent/ui-shadcn', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@diy-agent/ui-shadcn')>();
    const React = await import('react');
    const Passthrough = ({ children }: { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, children);
    return { ...actual, Sheet: Passthrough, SheetContent: Passthrough };
});

import {
    attentionLabelOf,
    attentionOf,
    countByAttention,
    needsYou,
    outcomeTextOf,
    sortRows,
    visibleInOverlay,
} from '../src/bots';
import { BotsOverlay } from '../src/components/BotsOverlay';
import type { BotRow } from '@diy-agent/chat-transport-rpc';

const noop = () => undefined;

function row(extra: Partial<BotRow>): BotRow {
    return {
        roomId: 'r1',
        roomTitle: '任务一',
        roomType: 'task',
        botId: 'b1',
        botName: '小满',
        botColor: '#7cc4ff',
        state: 'idle',
        ...extra,
    };
}

function render(rows: BotRow[], initialMode?: 'brief' | 'full'): string {
    return renderToStaticMarkup(
        <BotsOverlay rows={rows} error={null} loaded reload={noop} onClose={noop} initialMode={initialMode} />,
    );
}

describe('visibleInOverlay —— 二级浮层列谁（非空闲）', () => {
    it('空闲之外都要列（含在跑与排队）', () => {
        expect(visibleInOverlay(row({ state: 'idle' }))).toBe(false);
        for (const state of ['running', 'asking', 'needs-attention'] as const) {
            expect(visibleInOverlay(row({ state }))).toBe(true);
        }
        expect(visibleInOverlay(row({ state: 'idle', queued: 2 }))).toBe(true);
    });
});

describe('needsYou —— 只算「真要你动手」的（标题栏那颗红点）', () => {
    it('出错 + 等你回答算，在跑 / 排队不算', () => {
        expect(needsYou(row({ state: 'needs-attention' }))).toBe(true);
        expect(needsYou(row({ state: 'asking' }))).toBe(true);
        // 2026-11-25 用户报的「红 7」：在跑被算进去了
        expect(needsYou(row({ state: 'running' }))).toBe(false);
        expect(needsYou(row({ state: 'idle', queued: 3 }))).toBe(false);
        expect(needsYou(row({ state: 'idle' }))).toBe(false);
    });
});

describe('countByAttention —— 分类计数（点开一定对得上）', () => {
    it('每行只归一类：错 + 等你 + 排队 + 在跑 + 空闲 = 总数', () => {
        const rows = [
            ...Array.from({ length: 4 }, (_, i) => row({ botId: `e${i}`, state: 'needs-attention' })),
            ...Array.from({ length: 2 }, (_, i) => row({ botId: `q${i}`, state: 'asking' })),
            row({ botId: 'r1', state: 'running' }),
            row({ botId: 'i1', state: 'idle' }),
        ];
        const counts = countByAttention(rows);
        // 用户报的那个场景：标题栏红 7，点开是 4 错 + 2 等 + 1 跑
        expect(counts.broken).toBe(4);
        expect(counts.blocked).toBe(2);
        expect(counts.live).toBe(1);
        expect(counts.idle).toBe(1);
        expect(counts.needsYou).toBe(6); // 红点只数 4 + 2，不再把「在跑」染红
        expect(counts.visible).toBe(7);
        expect(counts.broken + counts.blocked + counts.queued + counts.live + counts.idle).toBe(rows.length);
    });

    it('在跑优先于排队：正在干活的成员不能被归成「排队中」', () => {
        // 2026-11-26 用户报的那行：状态「排队中」+ 结局「中断」—— 其实它正在跑，
        // 只是 `queuedByBot` 把手上那条 delivering 也算成了排队
        const running = row({ state: 'running', queued: 3 });
        expect(attentionOf(running)).toBe('live');
        // 但排队数不能丢：行上两个字都说
        expect(attentionLabelOf(running)).toBe('在跑 · 排 3');

        const counts = countByAttention([running, row({ state: 'idle', queued: 1 })]);
        expect(counts.live).toBe(1);
        expect(counts.queued).toBe(1); // 只有“没在跑但排着”的算排队

        expect(attentionOf(row({ state: 'idle', queued: 1 }))).toBe('queued');
        expect(attentionLabelOf(row({ state: 'idle', queued: 1 }))).toBe('排队中');
    });
});

describe('sortRows —— 急的排前面', () => {
    it('出错 > 等你 > 排队 > 在跑 > 空闲', () => {
        const rows = [
            row({ botId: 'e', state: 'idle' }),
            row({ botId: 'd', state: 'running' }),
            row({ botId: 'c', state: 'idle', queued: 2 }),
            row({ botId: 'b', state: 'asking' }),
            row({ botId: 'a', state: 'needs-attention' }),
        ];
        expect(sortRows(rows).map((item) => item.botId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('同状态按最后动静新→旧，没有动静的垫底', () => {
        const rows = [
            row({ botId: 'old', state: 'idle', lastTurnAt: 1000 }),
            row({ botId: 'none', state: 'idle' }),
            row({ botId: 'new', state: 'idle', lastTurnAt: 3000 }),
        ];
        expect(sortRows(rows).map((item) => item.botId)).toEqual(['new', 'old', 'none']);
    });
});

describe('outcomeTextOf', () => {
    it('失败说原文，其余给固定说法', () => {
        expect(outcomeTextOf(row({ outcome: 'failed', outcomeMessage: '网关 500' }))).toBe('网关 500');
        expect(outcomeTextOf(row({ outcome: 'failed' }))).toBe('运行失败');
        expect(outcomeTextOf(row({ outcome: 'truncated' }))).toBe('被输出上限截断');
        expect(outcomeTextOf(row({}))).toBe('还没跑过');
    });
});

describe('二级浮层', () => {
    it('只列要人看见的，空闲的不出现', () => {
        const html = render([
            row({ botName: '在跑的', state: 'running' }),
            row({ roomTitle: '空闲房间', botName: '闲着的', state: 'idle' }),
        ]);
        expect(html).toContain('在跑的');
        expect(html).not.toContain('闲着的');
        expect(html).not.toContain('空闲房间');
    });

    it('出错的二级就能读出为什么 + 有「继续」', () => {
        const html = render([row({ state: 'needs-attention', outcome: 'failed', outcomeMessage: '网关 500' })]);
        expect(html).toContain('网关 500');
        expect(html).toContain('发一条「继续」接着干');
    });

    it('全空闲写「都闲着」，不是空白', () => {
        const html = render([row({ state: 'idle' })]);
        expect(html).toContain('都闲着');
    });

    it('还没拉到数据时写「正在读」', () => {
        const html = renderToStaticMarkup(
            <BotsOverlay rows={[]} error={null} loaded={false} reload={noop} onClose={noop} />,
        );
        expect(html).toContain('正在读 bot 状态');
    });
});

describe('三级表格', () => {
    it('默认「全部」：空闲的也在（「要看的」那一筛已删）', () => {
        const html = render(
            [row({ botName: '在跑的', state: 'running' }), row({ botName: '闲着的', state: 'idle' })],
            'full',
        );
        expect(html).not.toContain('>要看的 '); // 2026-11-26 用户：那个筛选 tab 删掉
        expect(html).toContain('全部 2');
        expect(html).toContain('在跑的');
        expect(html).toContain('闲着的');
    });

    it('空的类别不占筛选钮（连「出错 0」也不画）', () => {
        const html = render([row({ botName: '闲着的', state: 'idle' })], 'full');
        expect(html).not.toContain('出错 0');
        expect(html).toContain('空闲 1');
    });

    it('有全选：一键勾中当前筛出来的这批', () => {
        const html = render(
            [row({ botName: 'a', state: 'needs-attention' }), row({ botName: 'b', state: 'running' })],
            'full',
        );
        expect(html).toContain('aria-label="全选"');
        expect(html).toContain('已选 0 / 2');
    });

    it('结局列写「上轮 ·」，不与左边的「此刻」读成一件事', () => {
        const html = render([row({ state: 'running', outcome: 'interrupted' })], 'full');
        expect(html).toContain('上轮 · 中断（上一轮没跑完）');
        // 状态列是「此刻」：正在跑就写正在跑
        expect(html).toContain('在跑');
    });

    it('带批量入口与回二级浮层的回退', () => {
        const html = render([row({ state: 'needs-attention' })], 'full');
        expect(html).toContain('重试选中（0）');
        // 文案从「只看要看的」改成「只看活动的」：前者与已删掉的那个筛选 tab 撞名
        expect(html).toContain('只看活动的');
    });
});
