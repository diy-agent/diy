import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/timeline';

const bot = { id: 'b1', name: 'diy', color: '#111', persona: '', homeRoomId: 'r', modelKey: 'm' };
const author = { id: 'b1', name: 'diy', color: '#111', role: 'bot' as const };

describe('typing', () => {
  it('speaking bot without streaming entry gets a typing entry', () => {
    const entries = buildTimeline([], [], { b1: bot }, { speaking: ['b1'] });
    expect(entries.map((e) => e.kind)).toEqual(['typing']);
  });

  it('skips when the bot already has a streaming entry', () => {
    const item = { id: 'i1', seq: 1, turnId: 't', at: 0, status: 'streaming' as const, author, type: 'chat' as const, data: { text: 'hi' } };
    const entries = buildTimeline([item], [], { b1: bot }, { speaking: ['b1'] });
    expect(entries.map((e) => e.kind)).toEqual(['assistant']);
    expect(entries[0]?.waiting).toBeUndefined();
  });

  it('本轮已有消息但没有流式内容：标在消息上（waiting），不另起一行', () => {
    const tool = {
      id: 'tool-1',
      seq: 1,
      turnId: 't',
      at: 1000,
      status: 'done' as const,
      author,
      type: 'tool' as const,
      data: { name: 'bash', args: { command: 'ls' }, state: 'ok' as const },
    };
    const entries = buildTimeline([tool], [], { b1: bot }, { speaking: ['b1'] });
    expect(entries.map((e) => e.kind)).toEqual(['assistant']);
    // 挂在消息末尾的"执行中 Ns"，起点是这条消息的开始时间
    expect(entries[0]?.waiting).toBe(true);
    expect(entries[0]?.at).toBe(1000);
  });
});
