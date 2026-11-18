// askDraft.ts —— 提问卡的"半填内容"：怎么表示、怎么归一化、什么时候算答完了。
//
// 为什么单独拆出来：一张卡三种输入（选项 / 多字段 / 自由文本），以前是三个 useState。
// 而同一张卡在三个表面（astryx / shadcn / assistant-ui）里各渲一次，切表面就是卸载重建，
// 切房间更不用说 —— 半填的内容整块丢。现在这部分状态寄在草稿设施里
// （owner = roomId，field = `ask:<askId>`），本文件只管纯逻辑、不碰 React，单测直接打它。
//
// **按题分桶**：一批可以有好几题（见 protocol 的 AskQuestion），草稿也按题 id 存 ——
// 否则用户在第 2 题打的字会被第 1 题的重渲染冲掉。旧草稿（单题，selected/fields/text
// 直接在顶层）读的时候包成 q1，与旧就是一张单题卡。

import type { AskAnswer, AskQuestion, AskQuestionAnswer, AskRequest } from '@diy-agent/chat-core';

/** 一题上所有未提交的输入 */
export interface QuestionDraft {
    /** choice：勾上的选项 value */
    selected: string[];
    /** form：每个字段的内容 */
    fields: Record<string, string>;
    /** choice 的"其他"、text 的唯一输入 */
    text: string;
    /** 用户明确跳过了这一题（提交时带 skipped，与"漏了"区分开） */
    skipped: boolean;
}

/** 一张卡（一批题）上所有未提交的输入，按题 id 分桶 */
export interface AskDraft {
    answers: Record<string, QuestionDraft>;
}

export const EMPTY_QUESTION_DRAFT: QuestionDraft = { selected: [], fields: {}, text: '', skipped: false };

export const EMPTY_ASK_DRAFT: AskDraft = { answers: {} };

/** 草稿字段名：一个房间里的多个提问各占一条（批量提问仍然只占一条，题在里面分桶） */
export function draftFieldOf(askId: string): string {
    return `ask:${askId}`;
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
}

function stringMap(value: unknown): Record<string, string> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === 'string') out[key] = entry;
    }
    return out;
}

function questionDraftOf(value: unknown): QuestionDraft {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return EMPTY_QUESTION_DRAFT;
    const record = value as Record<string, unknown>;
    return {
        selected: stringList(record['selected']),
        fields: stringMap(record['fields']),
        text: typeof record['text'] === 'string' ? record['text'] : '',
        skipped: record['skipped'] === true,
    };
}

/**
 * 存下来的任意值 → 结构完整的草稿。
 * 服务端的行可能是旧版本写的、也可能是别的 kind 留下的，缺项一律补默认值，不抛。
 */
export function askDraftOf(value: unknown): AskDraft {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return EMPTY_ASK_DRAFT;
    const record = value as Record<string, unknown>;
    const raw = record['answers'];
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const answers: Record<string, QuestionDraft> = {};
        for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
            answers[id] = questionDraftOf(entry);
        }
        return { answers };
    }
    // 旧草稿：单题时代 selected / fields / text 在顶层 → 归到 q1（旧卡归一化后题 id 也是 q1）
    const legacy = questionDraftOf(record);
    const filled =
        legacy.selected.length > 0 || legacy.text !== '' || Object.keys(legacy.fields).length > 0;
    return filled ? { answers: { q1: legacy } } : EMPTY_ASK_DRAFT;
}

/** 取某一题的草稿（没有就是空的） */
export function questionDraftFor(draft: AskDraft, questionId: string): QuestionDraft {
    return draft.answers[questionId] ?? EMPTY_QUESTION_DRAFT;
}

function withQuestion(draft: AskDraft, questionId: string, next: QuestionDraft): AskDraft {
    return { answers: { ...draft.answers, [questionId]: next } };
}

/** 勾 / 取消一个选项：单选就替换，多选就切换 */
export function setChoice(draft: AskDraft, questionId: string, value: string, multiple: boolean): AskDraft {
    const current = questionDraftFor(draft, questionId);
    const selected = multiple
        ? current.selected.includes(value)
            ? current.selected.filter((entry) => entry !== value)
            : [...current.selected, value]
        : [value];
    // 选了就代表这题没跳过：用户回头改答案时不用再点一次"撤销跳过"
    return withQuestion(draft, questionId, { ...current, selected, skipped: false });
}

export function setField(draft: AskDraft, questionId: string, name: string, text: string): AskDraft {
    const current = questionDraftFor(draft, questionId);
    return withQuestion(draft, questionId, {
        ...current,
        fields: { ...current.fields, [name]: text },
        skipped: false,
    });
}

export function setText(draft: AskDraft, questionId: string, text: string): AskDraft {
    const current = questionDraftFor(draft, questionId);
    return withQuestion(draft, questionId, { ...current, text, skipped: false });
}

/** 显式跳过 / 撤销跳过 */
export function setSkipped(draft: AskDraft, questionId: string, skipped: boolean): AskDraft {
    const current = questionDraftFor(draft, questionId);
    return withQuestion(draft, questionId, { ...current, skipped });
}

/** 必填但还空着的字段名（只对 form 有意义） */
export function missingFieldsOf(question: AskQuestion, draft: QuestionDraft): string[] {
    if (draft.skipped) return [];
    return (question.fields ?? [])
        .filter((field) => field.required === true && (draft.fields[field.name] ?? '').trim() === '')
        .map((field) => field.name);
}

/** 这一题填了没有：跳过算填了；form 看必填，text 看非空，choice 看"选了或写了" */
export function isQuestionReady(question: AskQuestion, draft: QuestionDraft): boolean {
    if (draft.skipped) return true;
    if (question.kind === 'form') return missingFieldsOf(question, draft).length === 0;
    if (question.kind === 'text') return draft.text.trim() !== '';
    return draft.selected.length > 0 || draft.text.trim() !== '';
}

/**
 * 这题还挡不挡提交：`required: false` 的题永远不挡（没填也能提交）。
 *
 * 与 `isQuestionReady` 分开：后者是"填了没有"（界面拿它显示「已答」），
 * 前者是"还差它吗"。可选题没填时，「已答」不能亮，但也不该拦着提交。
 */
export function isQuestionSatisfied(question: AskQuestion, draft: QuestionDraft): boolean {
    return question.required === false || isQuestionReady(question, draft);
}

/** 整批能不能提交 */
export function isReady(request: AskRequest, draft: AskDraft): boolean {
    return request.questions.every((question) => isQuestionSatisfied(question, questionDraftFor(draft, question.id)));
}

/** 还没答的必答题（按顺序）：界面用来显示"还有 N 题没答"，也是提交时跳转的目标 */
export function unansweredOf(request: AskRequest, draft: AskDraft): AskQuestion[] {
    return request.questions.filter((question) => !isQuestionSatisfied(question, questionDraftFor(draft, question.id)));
}

/** 这一题提交过什么（已答的只读展示用） */
export function answeredOf(answer: AskAnswer | undefined, questionId: string): AskQuestionAnswer | undefined {
    return answer?.answers.find((entry) => entry.id === questionId);
}

/** 草稿 → 提交用的整批回答（与后端约定一致：choice 用 values，form 用 fields，纯跳过带 skipped） */
export function answerOf(request: AskRequest, draft: AskDraft): AskAnswer {
    const answers = request.questions.map((question): AskQuestionAnswer => {
        const current = questionDraftFor(draft, question.id);
        if (current.skipped) return { id: question.id, skipped: true };
        const text = current.text.trim();
        const freeText = text === '' ? {} : { text };
        if (question.kind === 'form') return { id: question.id, fields: current.fields, ...freeText };
        if (question.kind === 'text') return { id: question.id, text };
        return { id: question.id, values: current.selected, ...freeText };
    });
    return { answers };
}
