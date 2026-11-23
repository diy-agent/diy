// mapping.test.ts —— Astryx 面的纯映射规则（工具行 / 投递状态）。

import { describe, expect, it } from 'vitest';

import type { TimelinePart } from '@diy-agent/chat-core';
import { deliveryFooterOf, deliveryStatusOf } from './mapping';
import { runsOf, toolTargetOf } from '../shared';

const tool = (args: unknown): TimelinePart & { kind: 'tool' } => ({
    kind: 'tool',
    id: 'tool-1',
    name: 'bash',
    args,
    state: 'ok',
});

describe('toolTargetOf', () => {
    it('bash 只取首段命令', () => {
        expect(toolTargetOf(tool({ command: 'rg foo src && head -3 x && echo ok' }))).toBe('rg foo src');
    });

    it('文件工具只取文件名', () => {
        expect(toolTargetOf(tool({ path: '/Users/ccc/git/diy/diy/src/a.ts' }))).toBe('a.ts');
    });

    it('过长的目标截断到 60 字符以内', () => {
        const out = toolTargetOf(tool({ command: `echo ${'x'.repeat(200)}` }))!;
        expect(out.length).toBeLessThanOrEqual(60);
        expect(out.endsWith('…')).toBe(true);
    });
});

describe('delivery 状态', () => {
    it('queued/delivering 不算错误（执行中另有指示器）', () => {
        expect(deliveryStatusOf([{ botId: 'b', name: 'diy', color: '#000', state: 'delivering' }])).toBeUndefined();
        expect(deliveryFooterOf([{ botId: 'b', name: 'diy', color: '#000', state: 'queued' }])).toBeUndefined();
    });

    it('失败才出状态与文案', () => {
        const failed = [{ botId: 'b', name: 'diy', color: '#000', state: 'failed' as const }];
        expect(deliveryStatusOf(failed)).toBe('error');
        expect(deliveryFooterOf(failed)).toBe('diy 未送达');
    });
});

describe('runsOf', () => {
    const text = (value: string): TimelinePart => ({ kind: 'text', text: value });
    const toolPart = (id: string): TimelinePart => ({ kind: 'tool', id, name: 'bash', state: 'ok' });

    it('相邻文本合并，工具按连续同类归组', () => {
        const runs = runsOf([text('先说'), text('一句'), toolPart('t1'), toolPart('t2')]);
        expect(runs.map((run) => run.kind)).toEqual(['text', 'tool']);
        expect(runs[0]).toEqual({ kind: 'text', text: '先说\n\n一句' });
        expect(runs[1]?.kind === 'tool' && runs[1].tools.map((tool) => tool.id)).toEqual(['t1', 't2']);
    });

    // 这条守的是「错误不会被排版吃掉」：失败必须独立成块，否则
    // 「说一段 → 失败 → 再说一段」会被渲染成一段连续的话，因果读反。
    it('error 自成一个块，不并进前后文本', () => {
        const runs = runsOf([text('diy'), { kind: 'error', message: '调用失败' }, text('重试成功')]);
        expect(runs.map((run) => run.kind)).toEqual(['text', 'error', 'text']);
    });

    it('连续两个 error 不合并（它们是两次不同的失败）', () => {
        const runs = runsOf([
            { kind: 'error', message: '第一次' },
            { kind: 'error', message: '第二次' },
        ]);
        expect(runs).toHaveLength(2);
    });
});
