// mention.test.ts —— @ 提及规则的唯一真源（两个表面共用）。

import { describe, expect, it } from 'vitest';

import {
    completeMention,
    dismissMention,
    filterMentionCandidates,
    mentionCandidatesOf,
    mentionQuery,
    moveActive,
} from '../src/mention';
import type { Bot } from '../src/types';

const bots: Record<string, Bot> = {
    a: { id: 'a', name: 'diy', color: '#111', persona: '', homeEntityId: 'p', modelKey: 'm' },
    b: { id: 'b', name: '小满', color: '#222', persona: '', homeEntityId: 'p', modelKey: 'm' },
};

describe('mentionQuery', () => {
    it('行首或空白后的 @ 才算提及', () => {
        expect(mentionQuery('@')).toBe('');
        expect(mentionQuery('@di')).toBe('di');
        expect(mentionQuery('你好 @小')).toBe('小');
        expect(mentionQuery('a@b')).toBeNull();
        expect(mentionQuery('@diy 说')).toBeNull();
    });
});

describe('filterMentionCandidates', () => {
    const candidates = mentionCandidatesOf(['a', 'b'], bots);

    it('空查询返回全部，按实体顺序（第一个是 owner）', () => {
        expect(filterMentionCandidates(candidates, '').map((c) => c.name)).toEqual(['diy', '小满']);
        expect(candidates[0]?.isOwner).toBe(true);
        expect(candidates[1]?.isOwner).toBe(false);
    });

    it('按名字子串过滤，大小写无关', () => {
        expect(filterMentionCandidates(candidates, 'DI').map((c) => c.id)).toEqual(['a']);
        expect(filterMentionCandidates(candidates, '满').map((c) => c.id)).toEqual(['b']);
        expect(filterMentionCandidates(candidates, 'zzz')).toEqual([]);
    });
});

describe('补全', () => {
    it('把末尾 @query 换成 @name + 空格', () => {
        expect(completeMention('你好 @小', '小满')).toBe('你好 @小满 ');
        expect(completeMention('@', 'diy')).toBe('@diy ');
    });

    it('Esc 取消时删掉 @query', () => {
        expect(dismissMention('你好 @小')).toBe('你好 ');
        expect(dismissMention('@')).toBe('');
    });

    it('↑↓ 在候选间循环', () => {
        expect(moveActive(0, 1, 2)).toBe(1);
        expect(moveActive(1, 1, 2)).toBe(0);
        expect(moveActive(0, -1, 2)).toBe(1);
        expect(moveActive(3, 1, 0)).toBe(0);
    });
});
