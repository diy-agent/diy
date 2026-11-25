// turnFooter.test.tsx —— 轮次最下面那一行（用户 2026-11-24 要的三件事）。
//
// 钉住四件：
//   1. 运行中写「已用 Ns」，且秒数从**开始时刻**起算（不是从第一条内容到达起算）；
//   2. 结束时换成结算：`完成 · 耗时 · tokens · 步数 · 工具次数` + `结束于 HH:MM`；
//   3. 正常收尾也要有这一行（页脚对 completed 沉默，但"这轮到止"必须有分界）；
//   4. 既没在跑也没有结算事实时**不占位置**（老数据 / 快照重放）。
//
// SSR 到字符串（仓库里 entity-chat 的既有姿势，没有 jsdom）：`useNow` 的 interval 不跑，
// 「已用」取初始值，正好可以直接断言文案形状。

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelineEntry } from '@diy-agent/chat-core';

import { TurnFooter } from '../src/components/TurnFooter';

const bot = { id: 'b1', name: 'diy', color: '#111', role: 'bot' as const };

function entry(overrides: Partial<TimelineEntry>): TimelineEntry {
    return {
        key: 't1:b1',
        kind: 'assistant',
        turnId: 't1',
        author: bot,
        parts: [],
        streaming: false,
        deliveries: [],
        at: 1_000,
        ...overrides,
    } as TimelineEntry;
}

describe('TurnFooter', () => {
    it('运行中：停止按钮固定在变化文案左侧，只写「已用」，不写结算', () => {
        const startedAt = Date.now() - 12_000;
        const html = renderToStaticMarkup(
            <TurnFooter
                entry={entry({ streaming: true, turn: { startedAt } })}
                roomId="r1"
                onStopBot={() => undefined}
            />,
        );
        expect(html).toContain('已用');
        expect(html).toContain('12s');
        expect(html).not.toContain('完成');
        expect(html.indexOf('>停</button>')).toBeLessThan(html.indexOf('执行中'));
    });

    it('结束：结算片段 + 结束时刻，标签用页脚那套文案', () => {
        // 用**今天**的 22:28 起算：`formatClock` 当天只写 HH:MM、跳天会补日期，
        // 固定写死 2026-11-24 的话，跑到第二天这条就变成「11-24 22:31」了（2026-11-25 真踩到）。
        const startedAt = new Date();
        startedAt.setHours(22, 28, 0, 0);
        const endedAt = startedAt.getTime() + 192_000;
        const html = renderToStaticMarkup(
            <TurnFooter
                entry={entry({
                    turn: {
                        startedAt,
                        endedAt,
                        usage: { inputTokens: 12_000, outputTokens: 400 },
                        toolCalls: 2,
                        reason: { type: 'completed', steps: 7 },
                    },
                })}
                roomId="r1"
            />,
        );
        expect(html).toContain('完成');
        expect(html).toContain('3m12s');
        expect(html).toContain('12.4k tokens');
        expect(html).toContain('7 步');
        expect(html).toContain('2 次工具');
        expect(html).toContain('结束于 22:31');
        expect(html).not.toContain('已用');
    });

    it('异常收尾说清是什么停的（不许只写「完成」）', () => {
        const html = renderToStaticMarkup(
            <TurnFooter
                entry={entry({ turn: { startedAt: 0, endedAt: 1_000, reason: { type: 'max-tokens' } } })}
                roomId="r1"
            />,
        );
        expect(html).toContain('被输出上限截断');
    });

    it('既没在跑且没有结算事实：这一行不占位置', () => {
        expect(renderToStaticMarkup(<TurnFooter entry={entry({})} roomId="r1" />)).toBe('');
    });
});
