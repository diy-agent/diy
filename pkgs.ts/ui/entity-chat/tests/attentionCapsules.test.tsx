// attentionCapsules.test.tsx —— 标题栏那排分类计数徽标的口径（2026-11-25 用户报的红 7）。
//
// 钉住的三件事：
//   1. **一个总数不再出现**：4 错 + 2 等 + 1 跑 = 三颗胶囊，不是一个 7；
//   2. 只有「出错」用红（其余四类各有各的色，红色专属「出事了」）；
//   3. 全空闲时给「都闲着」灰点 —— 仍然点得开（不给一个点不动的死图标）。
//
// SSR 到字符串（entity-chat 的既有姿势，没有 jsdom）：effect 不跑，正好测「给定计数画什么」。

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { countByAttention, type AttentionCounts } from '../src/bots';
import { AttentionCapsules } from '../src/components/AttentionCapsules';
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

/** 用户报的那个场景：红 7，点开是 4 错 + 2 等 + 1 跑 */
function redSeven(): BotRow[] {
    return [
        ...Array.from({ length: 4 }, (_, i) => row({ botId: `e${i}`, state: 'needs-attention' })),
        ...Array.from({ length: 2 }, (_, i) => row({ botId: `q${i}`, state: 'asking' })),
        row({ botId: 'r1', state: 'running' }),
    ];
}

function render(counts: AttentionCounts): string {
    return renderToStaticMarkup(<AttentionCapsules counts={counts} onPick={noop} onOpen={noop} />);
}

describe('AttentionCapsules —— 分类计数，不再是一个总数', () => {
    it('4 错 + 2 等 + 1 跑 = 三颗胶囊（没有一个「7」）', () => {
        const html = render(countByAttention(redSeven()));
        // 多个类时**只写数字**（标题栏 28px 高，四颗带中文会把别的按钮挤没），
        // 类名词进 title —— 所以这里查 title 而不能直接查可见文字
        expect(html).toContain('出错 4 个');
        expect(html).toContain('等你回答 2 个');
        expect(html).toContain('在跑 1 个');
        // 三个数字各自出现；**不出现** 7（那就是被拆掉的那个总数）
        expect(html).toContain('>4<');
        expect(html).toContain('>2<');
        expect(html).toContain('>1<');
        expect(html).not.toContain('>7<');
        expect(html).not.toContain('要你看');
    });

    it('只有一类时才带中文（“4 出错” 一眼就懂，不必 hover）', () => {
        const html = render(countByAttention([row({ state: 'needs-attention' }), row({ state: 'needs-attention' })]));
        expect(html).toContain('出错');
    });

    it('只有「出错」用红，其余一色不染红', () => {
        const html = render(countByAttention(redSeven()));
        const broken = html.match(/text-rose-400/g)?.length ?? 0;
        const live = html.match(/text-emerald-400/g)?.length ?? 0;
        expect(broken).toBe(1); // 一颗
        expect(live).toBe(1); // 一颗（在跑绿的，不是红的）
        // 「在跑」那颗不含 rose
        const liveChip = html.slice(html.indexOf('text-emerald-400'), html.indexOf('text-emerald-400') + 220);
        expect(liveChip).not.toContain('text-rose-400');
    });

    it('为 0 的类不占位（不画一颗写 0 的）', () => {
        const html = render(countByAttention([row({ state: 'asking' })]));
        expect(html).toContain('等你回答');
        expect(html).not.toContain('出错');
        expect(html).not.toContain('在跑');
        expect(html).not.toContain('排队中');
    });

    it('全空闲给「都闲着」灰点（可点开，不是死图标）', () => {
        const html = render(countByAttention([row({ state: 'idle' }), row({ state: 'idle' })]));
        expect(html).toContain('都闲着');
        expect(html).toContain('button'); // 是按钮，点得开
    });

    it('排队单独一颗（系统状态，不混进红点）', () => {
        const html = render(countByAttention([row({ state: 'idle', queued: 3 }), row({ state: 'running' })]));
        // 计数按**成员行**算（一个成员排着 3 条也只占一行）：这里两个成员，一个排队一个在跑
        expect(html).toContain('排队中 1 个'); // title
        expect(html).not.toContain('要你看');
        expect(html).not.toContain('text-rose-400'); // 排队不染红
    });
});
