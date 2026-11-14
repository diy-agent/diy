import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/timeline';
describe('typing', () => {
  it('speaking bot without streaming entry gets a typing entry', () => {
    const bot = { id: 'b1', name: 'diy', color: '#111', persona: '', homeRoomId: 'r', modelKey: 'm' };
    const entries = buildTimeline([], [], { b1: bot }, { speaking: ['b1'] });
    expect(entries.map((e) => e.kind)).toEqual(['typing']);
  });
  it('skips when the bot already has a streaming entry', () => {
    const bot = { id: 'b1', name: 'diy', color: '#111', persona: '', homeRoomId: 'r', modelKey: 'm' };
    const item = { id: 'i1', seq: 1, turnId: 't', at: 0, status: 'streaming' as const, author: { id: 'b1', name: 'diy', color: '#111', role: 'bot' as const }, type: 'chat' as const, data: { text: 'hi' } };
    const entries = buildTimeline([item], [], { b1: bot }, { speaking: ['b1'] });
    expect(entries.map((e) => e.kind)).toEqual(['assistant']);
  });
});
