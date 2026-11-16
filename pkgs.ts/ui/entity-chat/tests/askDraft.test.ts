import { describe, expect, it } from 'vitest';

import type { AskRequest } from '@diy-agent/chat-core';

import {
    askDraftOf,
    answerOf,
    draftFieldOf,
    EMPTY_ASK_DRAFT,
    isReady,
    missingFieldsOf,
    setChoice,
    setField,
    setText,
} from '../src/askDraft';

function ask(patch: Partial<AskRequest>): AskRequest {
    return { askId: 'a1', question: '选一个', kind: 'choice', at: 0, ...patch };
}

describe('askDraftOf', () => {
    it('undefined / 坏值都归一化成空草稿，不抛', () => {
        expect(askDraftOf(undefined)).toEqual(EMPTY_ASK_DRAFT);
        expect(askDraftOf(null)).toEqual(EMPTY_ASK_DRAFT);
        expect(askDraftOf('乱写的')).toEqual(EMPTY_ASK_DRAFT);
        expect(askDraftOf([1, 2])).toEqual(EMPTY_ASK_DRAFT);
    });

    it('旧版本 / 别的 kind 留下的行：缺项补默认，类型不对的丢掉', () => {
        const draft = askDraftOf({ selected: ['a', 3, null], fields: { k: 'v', n: 1 }, text: 42 });
        expect(draft).toEqual({ selected: ['a'], fields: { k: 'v' }, text: '' });
    });
});

describe('编辑', () => {
    it('单选替换、多选切换', () => {
        let draft = setChoice(EMPTY_ASK_DRAFT, 'a', false);
        expect(draft.selected).toEqual(['a']);
        draft = setChoice(draft, 'b', false);
        expect(draft.selected).toEqual(['b']);

        let multi = setChoice(EMPTY_ASK_DRAFT, 'a', true);
        multi = setChoice(multi, 'b', true);
        expect(multi.selected).toEqual(['a', 'b']);
        multi = setChoice(multi, 'a', true);
        expect(multi.selected).toEqual(['b']);
    });

    it('setField / setText 不改别的字段（并存）', () => {
        const draft = setText(setField(EMPTY_ASK_DRAFT, 'title', '标题'), '其他内容');
        expect(draft).toEqual({ selected: [], fields: { title: '标题' }, text: '其他内容' });
    });

    it('字段名就是一个房间里一条草稿', () => {
        expect(draftFieldOf('ask_42')).toBe('ask:ask_42');
    });
});

describe('能否提交', () => {
    it('choice：勾一个或写了自由输入都能交', () => {
        const request = ask({});
        expect(isReady(request, EMPTY_ASK_DRAFT)).toBe(false);
        expect(isReady(request, setChoice(EMPTY_ASK_DRAFT, 'a', false))).toBe(true);
        expect(isReady(request, setText(EMPTY_ASK_DRAFT, '都不是'))).toBe(true);
    });

    it('form：必填项没填就不让交；只有空格的也不算填了', () => {
        const request = ask({
            kind: 'form',
            fields: [
                { name: 'title', label: '标题', type: 'text', required: true },
                { name: 'desc', label: '描述', type: 'textarea' },
            ],
        });
        expect(missingFieldsOf(request, EMPTY_ASK_DRAFT)).toEqual(['title']);
        expect(isReady(request, setField(EMPTY_ASK_DRAFT, 'title', '   '))).toBe(false);
        expect(isReady(request, setField(EMPTY_ASK_DRAFT, 'desc', '随便写'))).toBe(false);
        expect(isReady(request, setField(EMPTY_ASK_DRAFT, 'title', '定稿'))).toBe(true);
    });

    it('text：空 / 空格不算答了', () => {
        const request = ask({ kind: 'text' });
        expect(isReady(request, setText(EMPTY_ASK_DRAFT, '  '))).toBe(false);
        expect(isReady(request, setText(EMPTY_ASK_DRAFT, '答案'))).toBe(true);
    });
});

describe('装配 answer', () => {
    it('choice：values + 可选 text（空白不带）', () => {
        const request = ask({ allowFreeform: true });
        expect(answerOf(request, setChoice(EMPTY_ASK_DRAFT, 'a', true))).toEqual({ values: ['a'] });
        expect(answerOf(request, setText(setChoice(EMPTY_ASK_DRAFT, 'a', true), '其他'))).toEqual({
            values: ['a'],
            text: '其他',
        });
    });

    it('form：fields 全带上，text 只在非空时带', () => {
        const request = ask({ kind: 'form' });
        const draft = setField(EMPTY_ASK_DRAFT, 'title', '定稿');
        expect(answerOf(request, draft)).toEqual({ fields: { title: '定稿' } });
        expect(answerOf(request, setText(draft, '补充'))).toEqual({ fields: { title: '定稿' }, text: '补充' });
    });

    it('text：只带 text', () => {
        expect(answerOf(ask({ kind: 'text' }), setText(EMPTY_ASK_DRAFT, '好'))).toEqual({ text: '好' });
    });
});
