// tools/ask.ts —— `ask` 工具：需要用户做决定时，把选项 / 表单推给他。
//
// 为什么要做成工具而不是让模型在正文里问：
//   正文里的问题会被大段输出淹掉，用户往往没意识到"现在卡在等我决定"。
//   工具调用能触发置顶卡片（选项 / 表单），回答结构化地回到模型。
//
// 回答以文本形式返回给模型（读起来最稳），例如：
//   用户选择：测试优先（test-first）
//   用户填写：标题=diy2 发版；优先级=高

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { AskGate } from '../ask';
import type { AskAnswer, AskRequest } from '../types';

const OPTION_SCHEMA = z.object({
    value: z.string().describe('选项值（回答时回传这个）'),
    label: z.string().describe('给用户看的短标签'),
    description: z.string().optional().describe('补充说明（一行）'),
});

const FIELD_SCHEMA = z.object({
    name: z.string().describe('字段名（回答时作为 key）'),
    label: z.string().describe('给用户看的标签'),
    type: z.enum(['text', 'textarea', 'number']).describe('输入类型'),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
});

function describeAnswer(request: AskRequest, answer: AskAnswer | undefined): string {
    if (answer === undefined) return '用户没有回答（本轮已取消）。';
    if (request.kind === 'text') {
        return `用户回答：${answer.text ?? '（空）'}`;
    }
    if (request.kind === 'form') {
        const fields = request.fields ?? [];
        const lines = fields.map((field) => `- ${field.label}：${answer.fields?.[field.name] ?? '（未填）'}`);
        return `用户已填写：\n${lines.join('\n')}`;
    }
    const values = answer.values ?? [];
    if (values.length === 0) return '用户没有选任何选项。';
    const labels = values.map((value) => {
        const option = request.options?.find((candidate) => candidate.value === value);
        return option === undefined ? value : `${option.label}（${value}）`;
    });
    const picked = `用户选择：${labels.join('、')}`;
    return answer.text === undefined || answer.text.trim() === '' ? picked : `${picked}；补充：${answer.text.trim()}`;
}

export function askTool(gate: AskGate | undefined, owner?: string): ToolSet[string] | undefined {
    if (gate === undefined) return undefined;
    return tool({
        description:
            '需要用户做决定时调用（选方案 / 定范围 / 填参数）。**不要在正文里提问** —— 正文的问题会被淹没。' +
            '选项题传 options（可 multiple），表单题传 fields。回答会作为工具结果返回给你。',
        inputSchema: z.object({
            question: z.string().describe('一句话说清要用户决定什么'),
            kind: z
                .enum(['choice', 'form', 'text'])
                .optional()
                .describe('缺省：有 fields 就是 form，有 options 就是 choice，否则 text'),
            allowFreeform: z.boolean().optional().describe('选项之外还允许自由输入（"其他"）'),
            options: z.array(OPTION_SCHEMA).optional().describe('选项（choice 用）'),
            fields: z.array(FIELD_SCHEMA).optional().describe('表单字段（form 用）'),
            multiple: z.boolean().optional().describe('选项是否多选'),
            note: z.string().optional().describe('补充说明：背景 / 影响 / 默认建议'),
        }),
        execute: async (input, options) => {
            const callId = (options as { toolCallId?: string } | undefined)?.toolCallId;
            const outcome = await gate.request(
                { ...input, ...(callId === undefined ? {} : { toolCallId: callId }) },
                owner,
            );
            if (outcome.cancelled === true) {
                return `用户没有回答（${outcome.reason ?? '已取消'}）。可以换个问法，或先按最保守的方案继续。`;
            }
            return describeAnswer(outcome.request, outcome.answer);
        },
    }) as ToolSet[string];
}
