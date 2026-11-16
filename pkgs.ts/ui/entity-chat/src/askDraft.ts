// askDraft.ts —— 提问卡的"半填内容"：怎么表示、怎么归一化、什么时候算答完了。
//
// 为什么单独拆出来：一张卡三种输入（选项 / 多字段 / 自由文本），以前是三个 useState。
// 而同一张卡在三个表面（astryx / shadcn / assistant-ui）里各渲一次，切表面就是卸载重建，
// 切房间更不用说 —— 半填的内容整块丢。现在这部分状态寄在草稿设施里
// （owner = roomId，field = `ask:<askId>`），本文件只管纯逻辑、不碰 React，单测直接打它。

import type { AskAnswer, AskRequest } from '@diy-agent/chat-core';

/** 一张卡上所有未提交的输入。字段固定，方便按值比较 / 从服务端旧值归一化 */
export interface AskDraft {
    /** choice：勾上的选项 value */
    selected: string[];
    /** form：每个字段的内容 */
    fields: Record<string, string>;
    /** choice 的"其他"、text 的唯一输入 */
    text: string;
}

export const EMPTY_ASK_DRAFT: AskDraft = { selected: [], fields: {}, text: '' };

/** 草稿字段名：一个房间里的多个提问各占一条 */
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

/**
 * 存下来的任意值 → 结构完整的草稿。
 * 服务端的行可能是旧版本写的、也可能是别的 kind 留下的，缺项一律补默认值，不抛。
 */
export function askDraftOf(value: unknown): AskDraft {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return EMPTY_ASK_DRAFT;
    const record = value as Record<string, unknown>;
    return {
        selected: stringList(record['selected']),
        fields: stringMap(record['fields']),
        text: typeof record['text'] === 'string' ? record['text'] : '',
    };
}

/** 勾 / 取消一个选项：单选就替换，多选就切换 */
export function setChoice(draft: AskDraft, value: string, multiple: boolean): AskDraft {
    if (!multiple) return { ...draft, selected: [value] };
    const selected = draft.selected.includes(value)
        ? draft.selected.filter((entry) => entry !== value)
        : [...draft.selected, value];
    return { ...draft, selected };
}

export function setField(draft: AskDraft, name: string, text: string): AskDraft {
    return { ...draft, fields: { ...draft.fields, [name]: text } };
}

export function setText(draft: AskDraft, text: string): AskDraft {
    return { ...draft, text };
}

/** 必填但还空着的字段名（只对 form 有意义） */
export function missingFieldsOf(request: AskRequest, draft: AskDraft): string[] {
    return (request.fields ?? [])
        .filter((field) => field.required === true && (draft.fields[field.name] ?? '').trim() === '')
        .map((field) => field.name);
}

/** 能不能提交：form 看必填，text 看非空，choice 看"选了或写了" */
export function isReady(request: AskRequest, draft: AskDraft): boolean {
    if (request.kind === 'form') return missingFieldsOf(request, draft).length === 0;
    if (request.kind === 'text') return draft.text.trim() !== '';
    return draft.selected.length > 0 || draft.text.trim() !== '';
}

/** 草稿 → 提交用的 answer（与后端约定一致：choice 用 values，form 用 fields） */
export function answerOf(request: AskRequest, draft: AskDraft): AskAnswer {
    const text = draft.text.trim();
    const freeText = text === '' ? {} : { text };
    if (request.kind === 'form') return { fields: draft.fields, ...freeText };
    if (request.kind === 'text') return { text };
    return { values: draft.selected, ...freeText };
}
