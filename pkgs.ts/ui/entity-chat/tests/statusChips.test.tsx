// statusChips.test.tsx —— 房间状态条说什么、什么时候闭嘴。
//
// 这组用例直接来自 2026-11-24 的现场（room 01a2091d…）：提问挂 27 分钟没人答、
// 用户那条消息 `delivering` 26 分钟，而页面上一个字都没有 ⇒ 用户以为「它砸了，
// 重启也没反应」。所以这里锁的不是样式，是**三种静默各自有没有被说出来**：
//   1. 有提问在等 → 说清谁在等、问什么、已等多久，并给入口
//   2. 有投递挂着但没人动 → 说出来（"发了没人理"的唯一信号）
//   3. 都没有 → 一个字都不渲染（不要一条空边框）

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AskRequest, Bot, BotProgress, Delivery } from '@diy-agent/chat-core';

import { StatusChips, type StatusChipsProps } from '../src/components/RoomStatusBar';

const bot: Bot = { id: 'b1', name: 'job', color: '#a3e635', persona: '', homeRoomId: 'r1', modelKey: 'm' };

const base: StatusChipsProps = {
    bots: { b1: bot },
    speaking: [],
    progress: {},
    asks: [],
    stuck: [],
    now: 1_000_000,
    onStop: () => undefined,
    onStopAll: () => undefined,
    onJump: () => undefined,
};

function ask(overrides: Partial<AskRequest> = {}): AskRequest {
    return {
        askId: 'ask-1',
        questions: [{ id: 'q1', question: '作业历史要不要回填？', kind: 'choice', options: [{ value: 'a', label: 'A' }] }],
        owner: 'b1',
        at: 1_000_000 - 27 * 60_000,
        ...overrides,
    };
}

const html = (props: Partial<StatusChipsProps>): string => renderToStaticMarkup(<StatusChips {...base} {...props} />);

describe('StatusChips', () => {
    it('三种事实都没有时不渲染任何东西', () => {
        expect(html({})).toBe('');
    });

    it('有提问在等：说清谁、问什么、已等多久，并给入口', () => {
        const out = html({ asks: [ask()] });
        expect(out).toContain('job 等你回答');
        expect(out).toContain('作业历史要不要回填？');
        expect(out).toContain('已等 27m');
        expect(out).toContain('去回答');
    });

    it('刚发出的提问不说「已等 0s」（那是噪音）', () => {
        const out = html({ asks: [ask({ at: 1_000_000 - 1_000 })] });
        expect(out).toContain('job 等你回答');
        expect(out).not.toContain('已等');
    });

    it('有成员在跑：说清卡在哪个 await，并给单停', () => {
        const progress: Record<string, BotProgress> = {
            b1: { awaiting: 'tool:bash', idleMs: 3_000, at: 1_000_000, alive: true, stage: 'quiet' },
        };
        const out = html({ speaking: ['b1'], progress });
        expect(out).toContain('正在调用 bash…');
        expect(out).toContain('全部停止');
    });

    it('卡住的成员直说「失联」', () => {
        const progress: Record<string, BotProgress> = {
            // `at` = 收到事件的时刻（自走从这里起算），idleMs 是服务端已经算好的，别再减一遍
            b1: { awaiting: 'model-stream', idleMs: 125_000, at: 1_000_000, alive: false, stage: 'stalled' },
        };
        expect(html({ speaking: ['b1'], progress })).toContain('失联 2m05s');
    });

    it('投递挂着、没人动：说出来（这是「发了没人理」唯一的信号）', () => {
        const stuck: Delivery[] = [
            { roomId: 'r1', messageId: 'u-1', botId: 'b1', state: 'delivering', updatedAt: 1_000_000 - 26 * 60_000 },
        ];
        const out = html({ stuck });
        expect(out).toContain('job');
        expect(out).toContain('未开跑 26m');
    });

    it('投递还没到 15s：不说（正常开跑期间行尾已有运行指示器，重复只会让人以为没发出去）', () => {
        const stuck: Delivery[] = [
            { roomId: 'r1', messageId: 'u-1', botId: 'b1', state: 'delivering', updatedAt: 1_000_000 - 5_000 },
        ];
        expect(html({ stuck })).toBe('');
    });
});
