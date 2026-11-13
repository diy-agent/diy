// room-log.test.ts —— 公共层：只追加、只存可见条目、按发言人视角映射成消息。

import { describe, expect, it } from 'vitest';

import { RoomLog, toMessage } from '../src/room-log';
import type { Author } from '../src/types';

const HUMAN: Author = { id: 'human:我', name: '我', color: '#999', role: 'human' };
const BOT_A: Author = { id: 'bot:a', name: 'diy', color: '#111', role: 'bot' };

describe('RoomLog', () => {
    it('seq 单调递增，since 只取之后的条目', () => {
        const log = new RoomLog();
        const one = log.append({ kind: 'say', author: HUMAN, text: '麻烦修改 bug' });
        const two = log.append({ kind: 'conclusion', botId: 'bot:a', name: 'diy', text: '已提交' });
        const three = log.append({ kind: 'notice', text: 'a 被唤起' });

        expect([one.seq, two.seq, three.seq]).toEqual([1, 2, 3]);
        expect(log.since(1).map((entry) => entry.seq)).toEqual([2, 3]);
        expect(log.all()).toHaveLength(3);
    });

    it('人话按 user 角色进来，别人的结论带发言人标签', () => {
        const log = new RoomLog();
        const say = log.append({ kind: 'say', author: HUMAN, text: '麻烦修改 bug' });
        const other = log.append({ kind: 'conclusion', botId: 'bot:b', name: 'cops', text: '缺锁' });

        expect(toMessage(say, 'bot:a')).toEqual({ role: 'user', content: '麻烦修改 bug' });
        expect(toMessage(other, 'bot:a')).toEqual({ role: 'user', content: '[cops 的结论] 缺锁' });
    });

    it('自己的结论不进自己的上下文（已在 assistant 产出里），通知不进上下文', () => {
        const log = new RoomLog();
        const mine = log.append({ kind: 'conclusion', botId: 'bot:a', name: 'diy', text: '已修复' });
        const notice = log.append({ kind: 'notice', text: 'a 被唤起' });

        expect(toMessage(mine, 'bot:a')).toBeNull();
        expect(toMessage(notice, 'bot:a')).toBeNull();
    });

    it('bot 的发言带方括号标签，便于模型区分谁说的', () => {
        const log = new RoomLog();
        const say = log.append({ kind: 'say', author: BOT_A, text: '我看过了' });
        expect(toMessage(say, 'bot:b')).toEqual({ role: 'user', content: '[diy] 我看过了' });
    });
});
