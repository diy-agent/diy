// ActiveGlyphs —— 标题栏的全实例活动入口：空闲时也必须可见且可辨认。

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Room } from '../src/model';
import { bootstrapStore, isRunningSession, setDiy2Client } from '../src/store';

import { ActiveJobsGlyph, ActiveSessionsGlyph } from '../src/components/ActiveGlyphs';

describe('标题栏活动指示器', () => {
    it('空闲时仍显示 Bot 与后台任务名称及 0，不退化成两个无标签图标；Bot 入口带列表语义', () => {
        const sessions = renderToStaticMarkup(<ActiveSessionsGlyph />);
        const jobs = renderToStaticMarkup(<ActiveJobsGlyph />);

        // 用户 2026-11-25 裁：这一颗叫「Bot」（「会话」与侧栏/房间的说法混淆）
        expect(sessions).toContain('Bot');
        expect(sessions).toContain('>0</span>');
        expect(sessions).toContain('查看正在运行的 Bot');
        expect(jobs).toContain('后台任务');
        expect(jobs).toContain('>0</span>');
    });

    it('Bot 计数按运行房间计，与弹出列表项目一致', async () => {
        const rooms: Room[] = [
            { id: 'task:one', type: 'task', modelKey: 'm', data: { title: '一号', status: 'open' }, botIds: [] },
            { id: 'task:closed', type: 'task', modelKey: 'm', data: { title: '已关闭', status: 'closed' }, botIds: [] },
            { id: 'proj:one', type: 'project', modelKey: 'm', data: { name: '项目' }, botIds: [] },
        ];
        let listener: ((frame: never) => void) | undefined;
        setDiy2Client({
            rooms: { list: async () => rooms },
            bots: { list: async () => [] },
            models: { list: async () => ({ providers: [] }) },
            subscribeActivity: (onFrame: (frame: never) => void) => {
                listener = onFrame;
                return () => undefined;
            },
            drafts: { list: async () => ({ drafts: [] }), put: async () => ({ updatedAt: 0 }), remove: async () => ({}) },
        } as never);
        bootstrapStore();
        await new Promise((resolve) => setTimeout(resolve, 0));
        // closed 任务里的旧 turn 不进这个数（那是一个已经收工的房间里残留的一轮）
        listener?.({
            rooms: [{ id: 'task:one', botIds: ['a', 'b'] }, { id: 'task:closed', botIds: ['c'] }],
            jobs: 0,
        } as never);

        const sessions = renderToStaticMarkup(<ActiveSessionsGlyph />);
        expect(sessions).toContain('aria-label="Bot 1，查看正在运行的 Bot"');
    });

    it('「算不算 Bot 在跑」只有一个判据：closed / 0 不算', () => {
        const room = (type: Room['type'], status?: string): Room =>
            ({ id: `${type}:x`, type, modelKey: 'm', data: { title: 'x', status }, botIds: [] }) as Room;

        expect(isRunningSession(room('task', 'open'), 2)).toBe(true);
        expect(isRunningSession(room('task', 'closed'), 2)).toBe(false);
        expect(isRunningSession(room('task', 'open'), 0)).toBe(false);
        // 项目房间自己也有成员与轮次（用户 2026-11-26「项目也是 bot」）——
        // 侧栏项目行会为它亮呼吸点（RoomRow），数字不数它就是「行上亮着、计数说 0」
        expect(isRunningSession(room('project'), 2)).toBe(true);
    });
});
