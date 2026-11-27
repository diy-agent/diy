// tools/journal.ts —— 任务日志工具：让 agent 自己把决策 / 踩坑 / 评审记下来。
//
// 为什么是工具而不是让模型在正文里说：journal 是 append-only 的结构化事件句，
// 面板按 kind 展示、变量树按 journal 单元投递；正文里的「我决定…」会被压缩摘要
// 当人话改写，事后查不到「当时为什么这么定」。

import { tool } from 'ai';
import { z } from 'zod';

import { JOURNAL_KINDS, type JournalKind } from '../db';

export function journalTool(onJournal: (input: { kind: JournalKind; text: string; unit?: string }) => void) {
    return tool({
        description:
            '记一条任务日志（append-only，一句话一条，不记流水账）：' +
            'decision=定了什么 / pitfall=踩了什么坑 / review=评审结论 / progress=里程碑 / learn=学到什么。' +
            '如果这条讲的是**某条需求**（尤其 decision：这条需求怎么定的、为什么），传 `unit` 挂上去 —— ' +
            '界面上它就出现在那条需求的「决策」里，不用另开一份决策清单。',
        inputSchema: z.object({
            kind: z.enum(JOURNAL_KINDS).describe('日志种类'),
            text: z.string().min(1).describe('一句事件句（「选了什么 / 为什么 / 代价」）'),
            unit: z.string().optional().describe('可选：这条日志属于哪条需求（账本条目的 id）'),
        }),
        execute: async ({ kind, text, unit }) => {
            onJournal({ kind, text, ...(unit === undefined || unit === '' ? {} : { unit }) });
            return { ok: true };
        },
    });
}
