import { describe, expect, it } from 'vitest';

import type { AskQuestion, AskRequest } from '@diy-agent/chat-core';

import {
    askDraftOf,
    answerOf,
    draftFieldOf,
    EMPTY_ASK_DRAFT,
    EMPTY_QUESTION_DRAFT,
    questionDraftFor,
    radioGroupName,
    isQuestionReady,
    isQuestionSatisfied,
    isReady,
    missingFieldsOf,
    setChoice,
    setField,
    setSkipped,
    setText,
    unansweredOf,
} from '../src/askDraft';

/** 单题提问（旧形状的等价物：一批只有一题，id 固定 q1） */
function ask(question: Partial<AskQuestion>): AskRequest {
    return {
        askId: 'a1',
        questions: [{ id: 'q1', question: '选一个', kind: 'choice', ...question }],
        at: 0,
    };
}

/** 三题一批（就是"dev app 构建对齐"那次的形状） */
function batch(): AskRequest {
    return {
        askId: 'a2',
        questions: [
            { id: 'env', question: '环境变量口径怎么定？', kind: 'choice', options: [{ value: 'keep', label: 'B' }] },
            {
                id: 'topo',
                question: 'dev 的进程拓扑怎么改？',
                kind: 'choice',
                options: [{ value: 'single', label: 'A' }],
            },
            { id: 'scope', question: '本轮落地到哪一步？', kind: 'text' },
        ],
        at: 0,
    };
}

describe('askDraftOf', () => {
    it('undefined / 坏值都归一化成空草稿，不抛', () => {
        expect(askDraftOf(undefined)).toEqual(EMPTY_ASK_DRAFT);
        expect(askDraftOf(null)).toEqual(EMPTY_ASK_DRAFT);
        expect(askDraftOf('乱写的')).toEqual(EMPTY_ASK_DRAFT);
        expect(askDraftOf([1, 2])).toEqual(EMPTY_ASK_DRAFT);
    });

    it('旧草稿（单题，字段在顶层）读成 q1 那一桶：刷新不丢半填内容', () => {
        const draft = askDraftOf({ selected: ['a', 3, null], fields: { k: 'v', n: 1 }, text: 42 });
        expect(draft).toEqual({ answers: { q1: { selected: ['a'], fields: { k: 'v' }, text: '', skipped: false } } });
    });

    it('新草稿按题分桶，互不干扰', () => {
        const draft = askDraftOf({
            answers: {
                env: { selected: ['keep'] },
                scope: { text: '全量' },
                bad: '不是对象',
            },
        });
        expect(questionDraftFor(draft, 'env').selected).toEqual(['keep']);
        expect(questionDraftFor(draft, 'scope').text).toEqual('全量');
        expect(questionDraftFor(draft, 'bad')).toEqual({ selected: [], fields: {}, text: '', skipped: false });
    });
});

describe('编辑', () => {
    it('单选替换、多选切换', () => {
        let draft = setChoice(EMPTY_ASK_DRAFT, 'q1', 'a', false);
        expect(questionDraftFor(draft, 'q1').selected).toEqual(['a']);
        draft = setChoice(draft, 'q1', 'b', false);
        expect(questionDraftFor(draft, 'q1').selected).toEqual(['b']);

        let multi = setChoice(EMPTY_ASK_DRAFT, 'q1', 'a', true);
        multi = setChoice(multi, 'q1', 'b', true);
        expect(questionDraftFor(multi, 'q1').selected).toEqual(['a', 'b']);
        multi = setChoice(multi, 'q1', 'a', true);
        expect(questionDraftFor(multi, 'q1').selected).toEqual(['b']);
    });

    it('setField / setText 不改别的字段（并存）', () => {
        const draft = setText(setField(EMPTY_ASK_DRAFT, 'q1', 'title', '标题'), 'q1', '其他内容');
        expect(questionDraftFor(draft, 'q1')).toEqual({
            selected: [],
            fields: { title: '标题' },
            text: '其他内容',
            skipped: false,
        });
    });

    it('改第 2 题不会冲掉第 1 题（分桶的意义）', () => {
        const draft = setText(setChoice(EMPTY_ASK_DRAFT, 'env', 'keep', false), 'scope', '全量');
        expect(questionDraftFor(draft, 'env').selected).toEqual(['keep']);
        expect(questionDraftFor(draft, 'scope').text).toEqual('全量');
    });

    it('跳过 / 撤销跳过；重新回答会自动撤销跳过', () => {
        const skipped = setSkipped(EMPTY_ASK_DRAFT, 'q1', true);
        expect(questionDraftFor(skipped, 'q1').skipped).toBe(true);
        expect(questionDraftFor(setSkipped(skipped, 'q1', false), 'q1').skipped).toBe(false);
        expect(questionDraftFor(setChoice(skipped, 'q1', 'a', false), 'q1').skipped).toBe(false);
        expect(questionDraftFor(setText(skipped, 'q1', '哦'), 'q1').skipped).toBe(false);
    });

    it('字段名就是一个房间里一条草稿（批量提问也只占一条）', () => {
        expect(draftFieldOf('ask_42')).toBe('ask:ask_42');
    });
});

describe('能否提交', () => {
    it('choice：勾一个或写了自由输入都能交', () => {
        const request = ask({});
        expect(isReady(request, EMPTY_ASK_DRAFT)).toBe(false);
        expect(isReady(request, setChoice(EMPTY_ASK_DRAFT, 'q1', 'a', false))).toBe(true);
        expect(isReady(request, setText(EMPTY_ASK_DRAFT, 'q1', '都不是'))).toBe(true);
    });

    it('form：必填项没填就不让交；只有空格的也不算填了', () => {
        const request = ask({
            kind: 'form',
            fields: [
                { name: 'title', label: '标题', type: 'text', required: true },
                { name: 'desc', label: '描述', type: 'textarea' },
            ],
        });
        expect(missingFieldsOf(request.questions[0]!, EMPTY_QUESTION_DRAFT)).toEqual(['title']);
        expect(isReady(request, setField(EMPTY_ASK_DRAFT, 'q1', 'title', '   '))).toBe(false);
        expect(isReady(request, setField(EMPTY_ASK_DRAFT, 'q1', 'desc', '随便写'))).toBe(false);
        expect(isReady(request, setField(EMPTY_ASK_DRAFT, 'q1', 'title', '定稿'))).toBe(true);
    });

    it('text：空 / 空格不算答了', () => {
        const request = ask({ kind: 'text' });
        expect(isReady(request, setText(EMPTY_ASK_DRAFT, 'q1', '  '))).toBe(false);
        expect(isReady(request, setText(EMPTY_ASK_DRAFT, 'q1', '答案'))).toBe(true);
    });

    it('多题：答完一部分不算答完，全部答完才能提交', () => {
        const request = batch();
        expect(unansweredOf(request, EMPTY_ASK_DRAFT).map((question) => question.id)).toEqual(['env', 'topo', 'scope']);
        let draft = setChoice(EMPTY_ASK_DRAFT, 'env', 'keep', false);
        expect(isReady(request, draft)).toBe(false);
        draft = setChoice(draft, 'topo', 'single', false);
        expect(isReady(request, draft)).toBe(false);
        draft = setText(draft, 'scope', '全量');
        expect(isReady(request, draft)).toBe(true);
        expect(unansweredOf(request, draft)).toEqual([]);
    });

    it('可选题（required: false）不拦提交，也不进「还没答」清单', () => {
        // 「要不要顺手改文档」这类顺带确认标成可选：全强制会逼用户点一下，全不强制又会漏主决策
        const request: AskRequest = {
            askId: 'a3',
            questions: [
                { id: 'main', question: '主决策', kind: 'choice', options: [{ value: 'a', label: 'A' }] },
                { id: 'extra', question: '顺手改文档？', kind: 'choice', required: false },
            ],
            at: 0,
        };
        const onlyMain = setChoice(EMPTY_ASK_DRAFT, 'main', 'a', false);
        expect(isReady(request, onlyMain)).toBe(true);
        expect(unansweredOf(request, onlyMain)).toEqual([]);
        // 但「填了没有」是另一件事：可选题没填时不能亮「已答」
        expect(isQuestionReady(request.questions[1]!, questionDraftFor(onlyMain, 'extra'))).toBe(false);
        expect(isQuestionSatisfied(request.questions[1]!, questionDraftFor(onlyMain, 'extra'))).toBe(true);
        // 主决策没答时仍然拦
        expect(isReady(request, EMPTY_ASK_DRAFT)).toBe(false);
    });

    it('多题：显式跳过算答完（"不想定"不能把整批卡死）', () => {
        const request = batch();
        const draft = setText(
            setChoice(setSkipped(setChoice(EMPTY_ASK_DRAFT, 'env', 'keep', false), 'topo', true), 'scope', '全量'),
            'scope',
            '全量',
        );
        expect(isQuestionReady(request.questions[1]!, questionDraftFor(draft, 'topo'))).toBe(true);
        expect(isReady(request, draft)).toBe(true);
    });
});

describe('装配 answer', () => {
    it('choice：values + 可选 text（空白不带）', () => {
        const request = ask({ allowFreeform: true });
        expect(answerOf(request, setChoice(EMPTY_ASK_DRAFT, 'q1', 'a', true))).toEqual({
            answers: [{ id: 'q1', values: ['a'] }],
        });
        expect(answerOf(request, setText(setChoice(EMPTY_ASK_DRAFT, 'q1', 'a', true), 'q1', '其他'))).toEqual({
            answers: [{ id: 'q1', values: ['a'], text: '其他' }],
        });
    });

    it('form：fields 全带上，text 只在非空时带', () => {
        const request = ask({ kind: 'form' });
        const draft = setField(EMPTY_ASK_DRAFT, 'q1', 'title', '定稿');
        expect(answerOf(request, draft)).toEqual({ answers: [{ id: 'q1', fields: { title: '定稿' } }] });
        expect(answerOf(request, setText(draft, 'q1', '补充'))).toEqual({
            answers: [{ id: 'q1', fields: { title: '定稿' }, text: '补充' }],
        });
    });

    it('text：只带 text', () => {
        expect(answerOf(ask({ kind: 'text' }), setText(EMPTY_ASK_DRAFT, 'q1', '好'))).toEqual({
            answers: [{ id: 'q1', text: '好' }],
        });
    });

    it('多题：一次装配整批，每题按 id 回传；跳过的题带 skipped', () => {
        const request = batch();
        const draft = setText(
            setSkipped(setChoice(EMPTY_ASK_DRAFT, 'env', 'keep', false), 'topo', true),
            'scope',
            '全量',
        );
        expect(answerOf(request, draft)).toEqual({
            answers: [
                { id: 'env', values: ['keep'] },
                { id: 'topo', skipped: true },
                { id: 'scope', text: '全量' },
            ],
        });
    });

    // 时间线上每张单题卡的题 id 都是 q1（批内唯一，不是全局唯一）。
    // 只按题 id 分组的话所有卡的 radio 会连成一组：勾一张会把另一张取消，
    // 方向键还会跨卡跳、静默改掉另一条待答提问的草稿。
    describe('radioGroupName', () => {
        it('同一题在不同卡片里组名不同（单题卡题 id 恒为 q1）', () => {
            expect(radioGroupName('ask-a', 'q1')).not.toBe(radioGroupName('ask-b', 'q1'));
        });

        it('同一张卡片的不同题组名也不同', () => {
            expect(radioGroupName('ask-a', 'q1')).not.toBe(radioGroupName('ask-a', 'q2'));
        });

        it('同一卡片同一题稳定（同一组 radio 才能互斥）', () => {
            expect(radioGroupName('ask-a', 'q1')).toBe(radioGroupName('ask-a', 'q1'));
        });
    });
});
