// @vitest-environment happy-dom
// pendingTable.test.tsx —— 诊断面（刀 4）能一眼读出「谁卡在哪」。
//
// 测的是纯表格 `PendingRows`（容器那层只做订阅，见组件注释）。判据 = 渲染出来的文本：
// 成员名、在等什么、多久没动、有没有心跳、档位 —— 这五样就是「卡住时能答出的问题」。

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Bot, BotProgress } from '@diy-agent/chat-core';

import { PendingRows } from '../src/components/PendingTable';

const BOTS: Record<string, Bot> = {
    'bot:a': { id: 'bot:a', name: '小满', color: '#111', persona: '', homeRoomId: 'r', modelKey: 'm' },
};

function progress(overrides: Partial<BotProgress> = {}): BotProgress {
    return { awaiting: 'model-stream', idleMs: 0, at: 0, alive: false, stage: 'quiet', ...overrides };
}

describe('PendingRows', () => {
    it('没有在跑的轮次：一句人话，不渲染空表', () => {
        const html = renderToStaticMarkup(<PendingRows rows={[]} bots={BOTS} now={0} />);
        expect(html).toContain('现在没有正在跑的轮次');
        expect(html).not.toContain('<table');
    });

    it('一行读完：成员 / 在等什么 / 多久没动 / 心跳 / 档位', () => {
        const html = renderToStaticMarkup(
            <PendingRows
                rows={[['bot:a', progress({ awaiting: 'tool:bash', idleMs: 5_000, alive: true, stage: 'slow' })]]}
                bots={BOTS}
                now={1_000}
            />,
        );
        expect(html).toContain('小满');
        expect(html).toContain('bash'); // 机器码翻了人话
        expect(html).toContain('6s'); // 5s + 自走 1s
        expect(html).toContain('有'); // 心跳
        expect(html).toContain('偏慢');
    });

    it('失联那一行标红（档位来自服务端，UI 不自己比秒数）', () => {
        const html = renderToStaticMarkup(
            <PendingRows rows={[['bot:a', progress({ idleMs: 125_000, stage: 'stalled' })]]} bots={BOTS} now={0} />,
        );
        expect(html).toContain('text-destructive');
        expect(html).toContain('失联');
        expect(html).toContain('2m05s');
    });

    it('成员不在 bots 表里就退回 id（不能因为查不到名字就空一格）', () => {
        const html = renderToStaticMarkup(<PendingRows rows={[['bot:x', progress()]]} bots={BOTS} now={0} />);
        expect(html).toContain('bot:x');
    });
});
