// pendingAskBar.test.tsx —— 壳层待答条约渲染吗？（SSR 到字符串，不需要 DOM）
//
// 为什么值得一条：这个条第一版挂在 assistant-ui 的 ChatPanel 里，lab 实机发现默认表面是
// astryx ⇒ 条在用户实际看的那一屏上根本不存在。渲染冒烟钉住两件事：
//   1. 没有待答提问时**不占地方**（返回 null，不要一条空边框）；
//   2. 有一条时说出「几个 + 问的是什么」，chip 的 title 是完整题干（侧栏 ? 只说几个）。

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PendingAskBar } from '../src/components/PendingAskBar';
import type { AskRequest } from '@diy-agent/chat-core';

const request: AskRequest = {
    askId: 'ask-1',
    questions: [{ id: 'q1', question: '是否继续？', kind: 'choice', options: [{ value: 'A', label: '继续' }] }],
    owner: 'bot-1',
    at: 1,
};

describe('PendingAskBar', () => {
    it('没有待答提问时不渲染任何东西', () => {
        expect(renderToStaticMarkup(<PendingAskBar asks={[]} onJump={() => undefined} />)).toBe('');
    });

    it('说出几个 + 问的是什么', () => {
        const html = renderToStaticMarkup(<PendingAskBar asks={[request]} onJump={() => undefined} />);
        expect(html).toContain('等你回答 · 1');
        expect(html).toContain('是否继续？');
        // chip 的 title 是完整题干（`askChipTitleOf`：题数 + 第一句）
        expect(html).toContain('还有 1 题等你回答');
    });
});
