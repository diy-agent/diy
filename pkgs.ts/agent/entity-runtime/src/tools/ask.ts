// tools/ask.ts —— `ask` 工具：需要用户做决定时，把选项 / 表单推给他。
//
// 为什么要做成工具而不是让模型在正文里问：
//   正文里的问题会被大段输出淹掉，用户往往没意识到"现在卡在等我决定"。
//   工具调用能触发置顶卡片（选项 / 表单），回答结构化地回到模型。
//
// **不阻塞**：调用后立刻返回回执，本轮照常结束。用户作答时，回答以一条新的用户消息
// 到来（`回答提问「…」：…`），模型在自己的记录里看到提问 + 答案，接着干。
// 所以工具结果只负责三件事：确认提问已发出、说清回答会怎么回来、划清"别自己猜"的红线。

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { AskGate } from '../ask';

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

/** 批量里的一题：问什么 + 怎么答（选项 / 字段 / 纯文本） */
const QUESTION_SCHEMA = z.object({
    id: z.string().optional().describe('题 id（缺省 q1/q2…）：回答按它回传，不填也行'),
    question: z.string().describe('这一题要用户决定什么'),
    kind: z.enum(['choice', 'form', 'text']).optional().describe('缺省：有 fields 就是 form，有 options 就是 choice'),
    options: z.array(OPTION_SCHEMA).optional().describe('选项（choice 用）'),
    fields: z.array(FIELD_SCHEMA).optional().describe('表单字段（form 用）'),
    multiple: z.boolean().optional().describe('选项是否多选'),
    allowFreeform: z.boolean().optional().describe('选项之外还允许自由输入（"其他"）'),
    note: z.string().optional().describe('这一题的补充说明'),
});

export function askTool(gate: AskGate | undefined, owner?: string): ToolSet[string] | undefined {
    if (gate === undefined) return undefined;
    return tool({
        description:
            '需要用户做决定时调用（选方案 / 定范围 / 填参数）。**不要在正文里提问** —— 正文的问题会被淹没。' +
            '**有好几件相关的事要定就一次问完**：传 questions 数组，界面一张卡列出全部、用户一次提交；' +
            '分开问会变成多张卡、用户要逐张点提交、你也会收到多条问候。' +
            '只问一件事时可以简写：直接给 question + options / fields。' +
            '这个工具**不会停下来等回答**：调用后立刻返回，本轮可以照常结束；' +
            '用户作答时会以一条新的用户消息到来（形如「回答提问（3 题）：- 题目 → 答案」）。',
        inputSchema: z.object({
            questions: z
                .array(QUESTION_SCHEMA)
                .min(1)
                .optional()
                .describe('要一起问的多个问题（一张卡、一次提交）。只问一件事就用下面的简写字段'),
            question: z.string().optional().describe('单题简写：只问一件事时用它，配合 kind/options/fields'),
            kind: z
                .enum(['choice', 'form', 'text'])
                .optional()
                .describe('缺省：有 fields 就是 form，有 options 就是 choice，否则 text'),
            allowFreeform: z.boolean().optional().describe('选项之外还允许自由输入（"其他"）'),
            options: z.array(OPTION_SCHEMA).optional().describe('选项（choice 用）'),
            fields: z.array(FIELD_SCHEMA).optional().describe('表单字段（form 用）'),
            multiple: z.boolean().optional().describe('选项是否多选'),
            note: z.string().optional().describe('补充说明：背景 / 影响 / 默认建议（批量时作为整批的背景）'),
        }),
        execute: async (input, options) => {
            const callId = (options as { toolCallId?: string } | undefined)?.toolCallId;
            const batch = input.questions !== undefined && input.questions.length > 0;
            const request = gate.request(
                {
                    ...(batch
                        ? { questions: input.questions! }
                        : {
                              question: input.question ?? '',
                              ...(input.kind === undefined ? {} : { kind: input.kind }),
                              ...(input.options === undefined ? {} : { options: input.options }),
                              ...(input.fields === undefined ? {} : { fields: input.fields }),
                              ...(input.multiple === undefined ? {} : { multiple: input.multiple }),
                              ...(input.allowFreeform === undefined ? {} : { allowFreeform: input.allowFreeform }),
                          }),
                    ...(input.note === undefined ? {} : { note: input.note }),
                    ...(callId === undefined ? {} : { toolCallId: callId }),
                },
                owner,
            );
            if (request === undefined) {
                return '没问成：一题都没给（要 questions 数组，或单题简写的 question）。把问题补上再调一次。';
            }
            const titles = request.questions.map((question) =>
                request.questions.length === 1 ? question.question : `- ${question.question}`,
            );
            return [
                request.questions.length === 1
                    ? `提问已展示给用户：「${titles[0]}」`
                    : `提问已展示给用户（共 ${request.questions.length} 题，一张卡）：\n${titles.join('\n')}`,
                '不会阻塞你：本轮可以照常结束。',
                '用户作答后会以一条新的用户消息到来（单题是「回答提问「…」：…」，多题是「回答提问（N 题）」' +
                    '逐行「- 题目 → 答案」），那时再按答案继续。',
                '现在可以继续做不依赖这个决定的部分；没有别的事就直接结束本轮，并说清你在等这个回答。',
                '不要重复问同一个问题，也不要替他猜答案 —— 需要他定的（尤其不可逆的动作）就等他回。',
            ].join('\n');
        },
    }) as ToolSet[string];
}
